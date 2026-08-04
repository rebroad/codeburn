import { appendFile, mkdir, open, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { calculateCost, getModelCosts } from './models.js'
import { codexCostUsd, codexCreditRate, codexCredits, refreshCodexPricing } from './codex-credits.js'

type TokenUsage = {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
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
  cacheWriteTokens?: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number | null
  credits: number | null
  eventId?: string
  source: string
}

export type CodexWatchOptions = {
  outputPath?: string
  pollSeconds?: number
  format?: string
  ledgerPath?: string
}

type FileState = {
  offset: number
  pending: string
  usage: CodexWatchState
}

function codexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
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
    usage.cache_write_input_tokens ?? 0,
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
  let cacheWriteTokens: number
  let outputTokens: number
  let reasoningTokens: number
  if (last) {
    inputTokens = numberValue(last.input_tokens)
    cachedInputTokens = numberValue(last.cached_input_tokens)
    cacheWriteTokens = numberValue(last.cache_write_input_tokens)
    outputTokens = numberValue(last.output_tokens)
    reasoningTokens = numberValue(last.reasoning_output_tokens)
  } else if (total) {
    inputTokens = delta(total.input_tokens, state.previous?.input_tokens)
    cachedInputTokens = delta(total.cached_input_tokens, state.previous?.cached_input_tokens)
    cacheWriteTokens = delta(total.cache_write_input_tokens, state.previous?.cache_write_input_tokens)
    outputTokens = delta(total.output_tokens, state.previous?.output_tokens)
    reasoningTokens = delta(total.reasoning_output_tokens, state.previous?.reasoning_output_tokens)
  } else {
    return null
  }

  if (total) state.previous = total
  const normalizedInput = Math.max(0, inputTokens - cachedInputTokens)
  const resolvedModel = state.model ?? 'unknown'
  const creditTokens = {
    inputTokens: normalizedInput,
    cachedReadTokens: cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
  }
  const credits = codexCredits(resolvedModel, creditTokens)
  const genericCosts = getModelCosts(resolvedModel)
  const hasGenericPrice = genericCosts !== null && (
    genericCosts.inputCostPerToken > 0
    || genericCosts.outputCostPerToken > 0
    || genericCosts.cacheWriteCostPerToken > 0
    || genericCosts.cacheReadCostPerToken > 0
  )
  const costUsd = codexCreditRate(resolvedModel)
    ? codexCostUsd(resolvedModel, creditTokens)
    : hasGenericPrice ? calculateCost(
      resolvedModel,
      normalizedInput,
      outputTokens + reasoningTokens,
      cacheWriteTokens,
      cachedInputTokens,
      0,
    ) : null
  const eventId = createHash('sha256').update(JSON.stringify([
    source, state.sessionId ?? '', entry['timestamp'] ?? '', normalizedInput,
    cachedInputTokens, cacheWriteTokens, outputTokens, reasoningTokens,
  ])).digest('hex')

  return {
    loggedAt: new Date().toISOString(),
    timestamp: stringValue(entry['timestamp']) ?? new Date().toISOString(),
    sessionId: state.sessionId ?? null,
    projectPath: state.projectPath ?? null,
    model: resolvedModel,
    inputTokens: normalizedInput,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    costUsd,
    credits,
    eventId,
    source,
  }
}

const DEFAULT_HUMAN_FORMAT = '%t %m input=%i cached=%c cache_write=%w output=%o reasoning=%r cost=$%d credits=%C'

function displayValue(value: string | number | null): string {
  if (value === null) return '-'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(6)
  return value
}

export function formatCodexUsageRecord(record: CodexUsageRecord, format: string): string {
  if (format === 'json') return JSON.stringify(record)
  const template = format === 'human' ? DEFAULT_HUMAN_FORMAT : format.replace(/^\+/, '')
  const values: Record<string, string | number | null> = {
    '%': '%',
    t: record.timestamp,
    l: record.loggedAt,
    m: record.model,
    s: record.sessionId,
    p: record.projectPath,
    i: record.inputTokens,
    c: record.cachedInputTokens,
    w: record.cacheWriteTokens ?? 0,
    o: record.outputTokens,
    r: record.reasoningTokens,
    d: record.costUsd,
    C: record.credits,
    f: record.source,
  }
  return template.replace(/%([%tlmspicowrdCf])/g, (_match, key: string) => displayValue(values[key] ?? null))
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
    const buffer = Buffer.alloc(Math.min(state.offset, 4 * 1024 * 1024))
    await handle.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8').split('\n')) {
      if (!line) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const payload = entry['payload'] as Record<string, unknown> | undefined
      if (!payload) continue
      const sessionId = stringValue(payload['session_id'])
      const projectPath = stringValue(payload['cwd'])
      const model = stringValue(payload['model']) ?? stringValue(payload['model_name'])
      if (sessionId) state.usage.sessionId = sessionId
      if (projectPath) state.usage.projectPath = projectPath
      if (model) state.usage.model = model
      const info = payload['info'] as Record<string, unknown> | undefined
      const infoModel = info && (stringValue(info['model']) ?? stringValue(info['model_name']))
      if (infoModel) state.usage.model = infoModel
    }
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
  const outputPath = options.outputPath
  const format = options.format ?? 'json'
  const pollMs = Math.max(250, (options.pollSeconds ?? 1) * 1000)
  const ledgerPath = options.ledgerPath ?? join(homedir(), '.cache', 'codeburn', 'codex-usage.jsonl')
  if (outputPath) await mkdir(dirname(outputPath), { recursive: true })
  if (ledgerPath) await mkdir(dirname(ledgerPath), { recursive: true })
  await refreshCodexPricing()

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
        if (ledgerPath) {
          await appendFile(ledgerPath, JSON.stringify({
            event_id: record.eventId,
            provider: 'openai',
            updated_at: Number.isFinite(Date.parse(record.timestamp))
              ? Math.floor(Date.parse(record.timestamp) / 1000)
              : Math.floor(Date.parse(record.loggedAt) / 1000),
            total_usage_usd: record.costUsd,
            priced: record.costUsd !== null,
            // Kept for codex-status schema compatibility. Codex does not emit
            // a separate billable prewarm token category.
            total_usage_usd_with_prewarm: record.costUsd,
            total_tokens: record.inputTokens + record.cachedInputTokens + (record.cacheWriteTokens ?? 0) + record.outputTokens + record.reasoningTokens,
            input_tokens: record.inputTokens,
            cached_input_tokens: record.cachedInputTokens,
            cache_write_input_tokens: record.cacheWriteTokens,
            output_tokens: record.outputTokens,
            reasoning_output_tokens: record.reasoningTokens,
            model: record.model,
            credits: record.credits,
            session_id: record.sessionId,
            source: record.source,
          }) + '\n', 'utf8')
        }
        const serialized = formatCodexUsageRecord(record, format) + '\n'
        if (outputPath) await appendFile(outputPath, serialized, 'utf8')
        else process.stdout.write(serialized)
      }
    }
  }

  await flush()
  process.stderr.write(`Watching Codex sessions; ${outputPath ? `logging to ${outputPath}` : 'writing records to stdout'}${ledgerPath ? `; accounting to ${ledgerPath}` : ''} (Ctrl-C to stop)\n`)
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => { void flush().catch(error => process.stderr.write(`codeburn watch: ${String(error)}\n`)) }, pollMs)
    const stop = () => { clearInterval(timer); resolve() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
