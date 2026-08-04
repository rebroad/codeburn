import { appendFile, mkdir, open, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { calculateCost } from './models.js'
import { codexCredits } from './codex-credits.js'

type TokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

export type CodexWatchState = {
  model?: string
  sessionId?: string
  projectPath?: string
  previous?: TokenUsage
  lastSignature?: string
}

export type CodexUsageRecord = {
  loggedAt: string
  timestamp: string
  sessionId: string | null
  projectPath: string | null
  model: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  credits: number | null
  source: string
}

export type CodexWatchOptions = {
  outputPath?: string
  pollSeconds?: number
}

type FileState = {
  offset: number
  pending: string
  usage: CodexWatchState
}

function codexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function defaultOutputPath(): string {
  const cacheDir = process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
  return join(cacheDir, 'codex-usage.jsonl')
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function usageSignature(usage: TokenUsage): string {
  return [
    usage.total_tokens ?? 0,
    usage.input_tokens ?? 0,
    usage.cached_input_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.reasoning_output_tokens ?? 0,
  ].join(':')
}

function delta(current: unknown, previous: unknown): number {
  return Math.max(0, numberValue(current) - numberValue(previous))
}

export function processCodexLine(
  state: CodexWatchState,
  line: string,
  source: string,
): CodexUsageRecord | null {
  if (!line.trim()) return null

  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }

  const payload = entry['payload'] as Record<string, unknown> | undefined
  if (!payload) return null

  const sessionId = stringValue(payload['session_id'])
  const projectPath = stringValue(payload['cwd'])
  const model = stringValue(payload['model'])
  if (sessionId) state.sessionId = sessionId
  if (projectPath) state.projectPath = projectPath
  if (model) state.model = model

  if (entry['type'] !== 'event_msg' || payload['type'] !== 'token_count') return null

  const info = payload['info'] as Record<string, unknown> | undefined
  if (!info) return null
  const rawLast = info['last_token_usage'] as TokenUsage | undefined
  const last = rawLast && Object.values(rawLast).some(value => typeof value === 'number') ? rawLast : undefined
  const total = info['total_token_usage'] as TokenUsage | undefined
  const infoModel = stringValue(info['model']) ?? stringValue(info['model_name'])
  if (infoModel) state.model = infoModel

  if (total) {
    const signature = usageSignature(total)
    if (signature === state.lastSignature) return null
    state.lastSignature = signature
  }

  let inputTokens: number
  let cachedInputTokens: number
  let outputTokens: number
  let reasoningTokens: number
  if (last) {
    inputTokens = numberValue(last.input_tokens)
    cachedInputTokens = numberValue(last.cached_input_tokens)
    outputTokens = numberValue(last.output_tokens)
    reasoningTokens = numberValue(last.reasoning_output_tokens)
  } else if (total) {
    inputTokens = delta(total.input_tokens, state.previous?.input_tokens)
    cachedInputTokens = delta(total.cached_input_tokens, state.previous?.cached_input_tokens)
    outputTokens = delta(total.output_tokens, state.previous?.output_tokens)
    reasoningTokens = delta(total.reasoning_output_tokens, state.previous?.reasoning_output_tokens)
  } else {
    return null
  }

  if (total) state.previous = total
  const normalizedInput = Math.max(0, inputTokens - cachedInputTokens)
  const resolvedModel = state.model ?? 'gpt-5'
  const costUsd = calculateCost(
    resolvedModel,
    normalizedInput,
    outputTokens + reasoningTokens,
    0,
    cachedInputTokens,
    0,
  )
  const credits = codexCredits(resolvedModel, {
    inputTokens: normalizedInput,
    cachedReadTokens: cachedInputTokens,
    outputTokens,
    reasoningTokens,
  })

  return {
    loggedAt: new Date().toISOString(),
    timestamp: stringValue(entry['timestamp']) ?? new Date().toISOString(),
    sessionId: state.sessionId ?? null,
    projectPath: state.projectPath ?? null,
    model: resolvedModel,
    inputTokens: normalizedInput,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    costUsd,
    credits,
    source,
  }
}

async function readAppended(filePath: string, state: FileState): Promise<string[]> {
  const file = await stat(filePath).catch(() => null)
  if (!file) return []
  if (file.size < state.offset) {
    state.offset = 0
    state.pending = ''
    state.usage = {}
  }
  if (file.size === state.offset) return []

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(file.size - state.offset)
    await handle.read(buffer, 0, buffer.length, state.offset)
    const oldPendingBytes = Buffer.byteLength(state.pending)
    const combined = state.pending + buffer.toString('utf8')
    const lastNewline = combined.lastIndexOf('\n')
    if (lastNewline < 0) return []
    const complete = combined.slice(0, lastNewline + 1)
    state.pending = combined.slice(lastNewline + 1)
    state.offset += Buffer.byteLength(complete) - oldPendingBytes
    return complete.split('\n').filter(Boolean)
  } finally {
    await handle.close()
  }
}

async function primeFile(filePath: string, state: FileState): Promise<void> {
  if (state.offset === 0) return
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return
  try {
    const buffer = Buffer.alloc(Math.min(state.offset, 1024 * 1024))
    await handle.read(buffer, 0, buffer.length, 0)
    const firstLine = buffer.toString('utf8').split('\n', 1)[0]
    if (firstLine) processCodexLine(state.usage, firstLine, filePath)
  } finally {
    await handle.close()
  }
}

async function discoverRollouts(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && depth > 0) {
        await visit(path, depth - 1)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(path)
      }
    }
  }
  await visit(join(root, 'sessions'), 3)
  await visit(join(root, 'archived_sessions'), 1)
  return files
}

export async function runCodexWatch(options: CodexWatchOptions = {}): Promise<void> {
  const outputPath = options.outputPath ?? defaultOutputPath()
  const pollMs = Math.max(250, (options.pollSeconds ?? 1) * 1000)
  await mkdir(dirname(outputPath), { recursive: true })

  const files = new Map<string, FileState>()
  const registerNewFiles = async (): Promise<void> => {
    for (const path of await discoverRollouts(codexHome())) {
      if (files.has(path)) continue
      const file = await stat(path).catch(() => null)
      if (file) {
        const state = { offset: file.size, pending: '', usage: {} as CodexWatchState }
        await primeFile(path, state)
        files.set(path, state)
      }
    }
  }

  const flush = async (): Promise<void> => {
    await registerNewFiles()
    for (const [path, state] of files) {
      const lines = await readAppended(path, state)
      for (const line of lines) {
        const record = processCodexLine(state.usage, line, path)
        if (!record) continue
        const serialized = JSON.stringify(record) + '\n'
        await appendFile(outputPath, serialized, 'utf8')
        process.stdout.write(serialized)
      }
    }
  }

  await flush()
  process.stderr.write(`Watching Codex sessions; logging to ${outputPath} (Ctrl-C to stop)\n`)
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => { void flush().catch(error => process.stderr.write(`codeburn watch: ${String(error)}\n`)) }, pollMs)
    const stop = () => { clearInterval(timer); resolve() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
