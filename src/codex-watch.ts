import { appendFile, mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
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
  accountId?: string
  accountEmail?: string
  accountEmails?: Record<string, string>
  model?: string
  modelAliases?: Record<string, string>
  sessionId?: string
  projectPath?: string
  previous?: TokenUsage
  lastSignature?: string
  usageRecordIds?: Set<string>
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
  totalTokens?: number
  costUsd: number | null
  credits: number | null
  usageSource?: 'token_usage_record'
  usageUnknown?: boolean
  responseId?: string
  reportedAmount?: string
  accountId?: string
  accountEmail?: string
  eventId?: string
  source: string
}

export type CodexWatchOptions = {
  outputPath?: string
  format?: string
  ledgerPath?: string
}

export type CodexWatchFileState = {
  offset: number
  pending: string
  decoder: StringDecoder
  device: number
  inode: number
  discardingOversizeLine: boolean
  usage: CodexWatchState
}

const READ_CHUNK_SIZE = 1024 * 1024
const MAX_PENDING_LINE_BYTES = 16 * 1024 * 1024

function codexHome(): string {
  return process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const encoded = token.split('.')[1]
  if (!encoded) return undefined
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    const payload = JSON.parse(decoded) as unknown
    return payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

async function loadCodexAccountEmails(): Promise<Record<string, string>> {
  try {
    const auth = JSON.parse(await readFile(join(codexHome(), 'auth.json'), 'utf8')) as Record<string, unknown>
    const tokens = auth['tokens'] as Record<string, unknown> | undefined
    if (!tokens) return {}
    const tokenPayloads = Object.values(tokens)
      .filter((token): token is string => typeof token === 'string')
      .map(decodeJwtPayload)
      .filter((payload): payload is Record<string, unknown> => payload !== undefined)
    const result: Record<string, string> = {}
    const tokenAccountId = stringValue(tokens['account_id'])
    let fallbackEmail: string | undefined
    for (const payload of tokenPayloads) {
      const authClaims = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
      const profileClaims = payload['https://api.openai.com/profile'] as Record<string, unknown> | undefined
      const accountId = stringValue(authClaims?.['chatgpt_account_id'])
      const email = stringValue(profileClaims?.['email']) ?? stringValue(payload['email'])
      if (accountId && email) result[accountId] = email
      if (email) fallbackEmail = email
    }
    if (tokenAccountId && fallbackEmail) result[tokenAccountId] = fallbackEmail
    return result
  } catch {
    return {}
  }
}

function catalogModelName(displayName: string): string | undefined {
  const candidate = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '')
  return codexCreditRate(candidate) ? candidate : undefined
}

async function loadCodexModelAliases(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(join(codexHome(), 'models_cache.json'), 'utf8')) as {
      models?: unknown
    }
    if (!Array.isArray(parsed.models)) return {}
    const aliases: Record<string, string> = {}
    for (const entry of parsed.models) {
      if (!entry || typeof entry !== 'object') continue
      const model = entry as Record<string, unknown>
      const slug = stringValue(model['slug'])?.toLowerCase()
      const displayName = stringValue(model['display_name'])
      if (!slug || !displayName) continue
      const canonical = catalogModelName(displayName)
      if (canonical && canonical !== slug) aliases[slug] = canonical
    }
    return aliases
  } catch {
    return {}
  }
}

function resolvedModel(state: CodexWatchState): string {
  const model = state.model ?? 'unknown'
  return state.modelAliases?.[model.toLowerCase()] ?? model
}

function updateStateFromPayload(
  state: CodexWatchState,
  entryType: string | undefined,
  payload: Record<string, unknown>,
  updateModel = true,
): void {
  const sessionId = stringValue(payload['session_id'])
    ?? (entryType === 'session_meta' ? stringValue(payload['id']) : undefined)
  const projectPath = stringValue(payload['cwd'])
  if (sessionId) state.sessionId = sessionId
  if (projectPath) state.projectPath = projectPath
  if (updateModel) {
    const model = modelFromPayload(payload)
    if (model) state.model = model
  }
}

function modelFromPayload(payload: Record<string, unknown>): string | undefined {
  const info = payload['info'] as Record<string, unknown> | undefined
  const threadSettings = payload['thread_settings'] as Record<string, unknown> | undefined
  return stringValue(payload['effective_model'])
    ?? stringValue(payload['model'])
    ?? (info && (
      stringValue(info['effective_model'])
      ?? stringValue(info['model'])
      ?? stringValue(info['model_name'])
    ))
    ?? (threadSettings && stringValue(threadSettings['model']))
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

  updateStateFromPayload(state, stringValue(entry['type']), payload)

  if (entry['type'] === 'event_msg' && payload['type'] === 'account_updated') {
    state.accountId = stringValue(payload['account_id'])
    state.accountEmail = state.accountId ? state.accountEmails?.[state.accountId] : undefined
    return null
  }

  if (entry['type'] === 'token_usage_record') {
    const responseId = stringValue(payload['response_id'])
    const usage = payload['usage'] as TokenUsage | undefined
    if (responseId) {
      state.usageRecordIds ??= new Set<string>()
      if (state.usageRecordIds.has(responseId)) return null
      state.usageRecordIds.add(responseId)
    }

    const inputTokens = usage ? numberValue(usage.input_tokens) : 0
    const cachedInputTokens = usage ? numberValue(usage.cached_input_tokens) : 0
    const cacheWriteTokens = usage ? numberValue(usage.cache_write_input_tokens) : 0
    const outputTokens = usage ? numberValue(usage.output_tokens) : 0
    const reasoningTokens = usage ? numberValue(usage.reasoning_output_tokens) : 0
    const normalizedInput = Math.max(0, inputTokens - cachedInputTokens)
    const billingModel = modelFromPayload(payload) ?? resolvedModel(state)
    const accountId = stringValue(payload['account_id']) ?? state.accountId
    const accountEmail = accountId
      ? state.accountEmails?.[accountId]
        ?? (accountId === state.accountId ? state.accountEmail : undefined)
      : undefined
    const creditRate = codexCreditRate(billingModel)
    const creditTokens = {
      inputTokens: normalizedInput,
      cachedReadTokens: cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
    }
    const costUsd = usage
      ? creditRate && (cacheWriteTokens === 0 || creditRate.cacheWrite !== null)
        ? codexCostUsd(billingModel, creditTokens)
        : creditRate
          ? null
          : getModelCosts(billingModel) ? calculateCost(
            billingModel,
            normalizedInput,
            outputTokens,
            cacheWriteTokens,
            cachedInputTokens,
            0,
          )
          : null
      : null
    const eventId = responseId
      ? `codex:usage:${responseId}`
      : createHash('sha256').update(JSON.stringify([
        source, entry['timestamp'] ?? '', inputTokens, cachedInputTokens,
        cacheWriteTokens, outputTokens, reasoningTokens,
      ])).digest('hex')

    return {
      loggedAt: new Date().toISOString(),
      timestamp: stringValue(entry['timestamp']) ?? new Date().toISOString(),
      sessionId: state.sessionId ?? null,
      projectPath: state.projectPath ?? null,
      model: billingModel,
      inputTokens: normalizedInput,
      cachedInputTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens,
      totalTokens: usage?.total_tokens,
      costUsd,
      // This is reconstructed consumption from the exact token usage and the
      // published per-model credit rate, not the account's balance.
      credits: usage && creditRate && (cacheWriteTokens === 0 || creditRate.cacheWrite !== null)
        ? codexCredits(billingModel, creditTokens)
        : null,
      usageSource: 'token_usage_record',
      usageUnknown: !usage,
      responseId,
      reportedAmount: stringValue(
        (payload['usage_metadata'] as Record<string, unknown> | undefined)?.['amount'],
      ),
      accountId,
      accountEmail,
      eventId,
      source,
    }
  }

  // TokenCountEvent and the cumulative fields on TokenUsageRecord are not
  // per-response billing records. Only TokenUsageRecord.usage is billable here.
  return null
}

const DEFAULT_HUMAN_FORMAT = '%t %m account=%a input=%i cached=%c cache_write=%w output=%o reasoning=%r cost=$%d credits=%C'

export const CODEX_WATCH_FORMAT_HELP = `
Watch output formats:

  json
    Full JSON record. The backend account is available as accountEmail when known;
    accountId remains available for stable attribution.

  human
    Human-readable output using:
      %t timestamp  %l logged time  %m model  %a backend account email
      %s session    %p project      %i input  %c cached input
      %w cache write %o output      %r reasoning output
      %d cost in USD %C credits     %f rollout source
      %% literal percent sign

  <format>
    A custom date-style token format, for example:
      +%t %m account=%a input=%i output=%o cost=$%d

The account value is the email associated with the backend account used by the
model request; it is the stable account ID when no email mapping is available,
and '-' when the rollout does not provide an account.\n`

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
    a: record.accountEmail ?? record.accountId,
    f: record.source,
  }
  return template.replace(/%([%tlmspicowrdCaf])/g, (_match, key: string) => displayValue(values[key] ?? null))
}

function resetFileState(state: CodexWatchFileState, file: { dev: number; ino: number }): void {
  state.offset = 0
  state.pending = ''
  state.decoder = new StringDecoder('utf8')
  state.device = file.dev
  state.inode = file.ino
  state.discardingOversizeLine = false
  state.usage = { modelAliases: state.usage.modelAliases }
}

export async function readAppended(
  filePath: string,
  state: CodexWatchFileState,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  const file = await stat(filePath).catch(() => null)
  if (!file) return
  if (file.size < state.offset || file.dev !== state.device || file.ino !== state.inode) {
    resetFileState(state, file)
  }
  if (file.size === state.offset) return

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(READ_CHUNK_SIZE)
    while (state.offset < file.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - state.offset), state.offset)
      if (bytesRead === 0) break
      state.offset += bytesRead
      state.pending += state.decoder.write(buffer.subarray(0, bytesRead))

      while (true) {
        const newline = state.pending.indexOf('\n')
        if (newline < 0) {
          if (Buffer.byteLength(state.pending, 'utf8') > MAX_PENDING_LINE_BYTES) {
            state.pending = ''
            state.discardingOversizeLine = true
          }
          break
        }
        const line = state.pending.slice(0, newline)
        state.pending = state.pending.slice(newline + 1)
        if (state.discardingOversizeLine) {
          state.discardingOversizeLine = false
        } else if (Buffer.byteLength(line, 'utf8') <= MAX_PENDING_LINE_BYTES) {
          await onLine(line)
        }
      }
    }
  } finally {
    await handle.close()
  }
}

async function primeFile(filePath: string, state: CodexWatchFileState): Promise<void> {
  if (state.offset === 0) return
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return
  try {
    const windowSize = 4 * 1024 * 1024
    const buffer = Buffer.alloc(Math.min(state.offset, windowSize))
    await handle.read(buffer, 0, buffer.length, 0)
    for (const line of buffer.toString('utf8').split('\n')) {
      primeLine(state.usage, line)
    }

    // The newest model setting may be far older than the end of a large
    // rollout. Scan backwards until the first model-bearing record, which is
    // the latest model change, without loading the whole file.
    const chunkSize = 1024 * 1024
    let end = state.offset
    let suffix = ''
    let latestModel: string | undefined
    while (end > 0 && !latestModel) {
      const start = Math.max(0, end - chunkSize)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const lines = (chunk.toString('utf8') + suffix).split('\n')
      suffix = start > 0 ? (lines.shift() ?? '') : ''
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const model = parseModelLine(lines[index] ?? '')
        if (model) {
          latestModel = model
          break
        }
      }
      end = start
    }
    if (latestModel) state.usage.model = latestModel
  } finally {
    await handle.close()
  }
}

function parseModelLine(line: string): string | undefined {
  if (!line) return undefined
  try {
    const entry = JSON.parse(line) as Record<string, unknown>
    const payload = entry['payload'] as Record<string, unknown> | undefined
    return payload ? modelFromPayload(payload) : undefined
  } catch {
    return undefined
  }
}

function primeLine(state: CodexWatchState, line: string): void {
  if (!line) return
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  const payload = entry['payload'] as Record<string, unknown> | undefined
  if (!payload) return
  // Prefix priming is only for session identity and deduplication. Model
  // selection is deliberately owned by the reverse scan from EOF.
  updateStateFromPayload(state, stringValue(entry['type']), payload, false)
  if (entry['type'] === 'token_usage_record') {
    const responseId = stringValue(payload['response_id'])
    if (responseId) {
      state.usageRecordIds ??= new Set<string>()
      state.usageRecordIds.add(responseId)
    }
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

async function watchRolloutDirectories(
  root: string,
  onChange: (path: string) => void,
): Promise<() => void> {
  const watchers = new Map<string, FSWatcher>()
  const addDirectory = async (directory: string, emitExistingFiles: boolean): Promise<void> => {
    if (watchers.has(directory)) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const watcher = watch(directory, (_event, filename) => {
      if (!filename) return
      const path = join(directory, filename.toString())
      onChange(path)
      void stat(path).then(info => {
        if (info.isDirectory()) void addDirectory(path, true)
      }).catch(() => {})
    })
    watcher.on('error', error => {
      process.stderr.write(`codeburn watch: directory watcher failed for ${directory}: ${String(error)}\n`)
    })
    watchers.set(directory, watcher)
    if (emitExistingFiles) {
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          onChange(join(directory, entry.name))
        }
      }
    }
    await Promise.all(entries
      .filter(entry => entry.isDirectory())
      .map(entry => addDirectory(join(directory, entry.name), emitExistingFiles)))
  }

  for (const directory of [join(root, 'sessions'), join(root, 'archived_sessions')]) {
    await addDirectory(directory, false)
  }
  return () => {
    for (const watcher of watchers.values()) watcher.close()
  }
}

export async function runCodexWatch(options: CodexWatchOptions = {}): Promise<void> {
  const outputPath = options.outputPath
  const format = options.format ?? 'json'
  const ledgerPath = options.ledgerPath ?? join(homedir(), '.cache', 'codeburn', 'codex-usage.jsonl')
  if (outputPath) await mkdir(dirname(outputPath), { recursive: true })
  if (ledgerPath) await mkdir(dirname(ledgerPath), { recursive: true })
  await refreshCodexPricing()
  const modelAliases = await loadCodexModelAliases()
  const accountEmails = await loadCodexAccountEmails()

  const files = new Map<string, CodexWatchFileState>()
  const registerNewFiles = async (): Promise<void> => {
    for (const path of await discoverRollouts(codexHome())) {
      if (files.has(path)) continue
      const file = await stat(path).catch(() => null)
      if (file) {
        const state = {
          offset: file.size,
          pending: '',
          decoder: new StringDecoder('utf8'),
          device: file.dev,
          inode: file.ino,
          discardingOversizeLine: false,
          usage: { accountEmails, modelAliases } as CodexWatchState,
        }
        await primeFile(path, state)
        files.set(path, state)
      }
    }
  }

  const registerAndRead = async (path: string): Promise<void> => {
    let state = files.get(path)
    if (!state) {
      const file = await stat(path).catch(() => null)
      if (!file?.isFile() || !path.split('/').pop()?.startsWith('rollout-') || !path.endsWith('.jsonl')) return
      state = {
        offset: 0,
        pending: '',
        decoder: new StringDecoder('utf8'),
        device: file.dev,
        inode: file.ino,
        discardingOversizeLine: false,
        usage: { accountEmails, modelAliases } as CodexWatchState,
      }
      files.set(path, state)
    }
    await readAppended(path, state, async (line) => {
        const record = processCodexLine(state.usage, line, path)
        if (!record) return
        if (ledgerPath) {
          await appendFile(ledgerPath, JSON.stringify({
            event_id: record.eventId,
            ...(record.accountId ? { account_id: record.accountId } : {}),
            provider: 'openai',
            updated_at: Number.isFinite(Date.parse(record.timestamp))
              ? Math.floor(Date.parse(record.timestamp) / 1000)
              : Math.floor(Date.parse(record.loggedAt) / 1000),
            total_usage_usd: record.costUsd,
            priced: record.costUsd !== null,
            // Kept for codex-status schema compatibility. Codex does not emit
            // a separate billable prewarm token category.
            total_usage_usd_with_prewarm: record.costUsd,
            total_tokens: record.totalTokens,
            input_tokens: record.inputTokens,
            cached_input_tokens: record.cachedInputTokens,
            cache_write_input_tokens: record.cacheWriteTokens,
            output_tokens: record.outputTokens,
            reasoning_output_tokens: record.reasoningTokens,
            model: record.model,
            credits: record.credits,
            ...(record.reportedAmount !== undefined ? { reported_amount: record.reportedAmount } : {}),
            session_id: record.sessionId,
            source: record.source,
            usage_source: record.usageSource,
            usage_unknown: record.usageUnknown,
            response_id: record.responseId,
          }) + '\n', 'utf8')
        }
        const serialized = formatCodexUsageRecord(record, format) + '\n'
        if (outputPath) await appendFile(outputPath, serialized, 'utf8')
        else process.stdout.write(serialized)
    })
  }

  await registerNewFiles()
  const pendingPaths = new Set<string>()
  let flushInFlight = false
  let flushAgain = false
  const flushPending = async (): Promise<void> => {
    if (flushInFlight) {
      flushAgain = true
      return
    }
    flushInFlight = true
    try {
      do {
        flushAgain = false
        const paths = [...pendingPaths]
        pendingPaths.clear()
        await Promise.all(paths.map(path => registerAndRead(path)))
      } while (flushAgain || pendingPaths.size > 0)
    } finally {
      flushInFlight = false
    }
  }
  const schedulePath = (path: string): void => {
    pendingPaths.add(path)
    void flushPending().catch(error => process.stderr.write(`codeburn watch: ${String(error)}\n`))
  }
  const closeDirectoryWatchers = await watchRolloutDirectories(codexHome(), schedulePath)
  process.stderr.write(`Watching Codex sessions; ${outputPath ? `logging to ${outputPath}` : 'writing records to stdout'}${ledgerPath ? `; accounting to ${ledgerPath}` : ''} (Ctrl-C to stop)\n`)
  await new Promise<void>((resolve) => {
    const stop = () => { closeDirectoryWatchers(); resolve() }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}
