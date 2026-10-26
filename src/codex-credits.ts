import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fetchWithTimeout } from './fetch-utils.js'
import { readConfig } from './config.js'

// Codex credit pricing. ChatGPT/Codex subscription users consume *credits*, a
// separate unit from API dollars: usage is billed as "credits per million
// tokens" at per-model rates that differ from the API USD pricing CodeBurn uses
// for cost. This module computes credit consumption from token counts so the
// app can show usage in credits (issues #408 and #495).
//
// Rates are credits per 1,000,000 tokens, from
// https://developers.openai.com/codex/pricing#credits-overview
// (cached input is the cheaper rate applied to cache-read tokens).

export type CodexCreditRate = {
  input: number
  cachedInput: number
  /// Null means the source does not publish a separate cache-write price.
  cacheWrite: number | null
  output: number
}

const CREDITS_PER_USD = 25
const PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

const CREDITS_PER_MILLION: Record<string, CodexCreditRate> = {
  'gpt-6-astra': { input: 250, cachedInput: 25, cacheWrite: 312.5, output: 1250 },
  'gpt-6-sol': { input: 50, cachedInput: 5, cacheWrite: 62.5, output: 250 },
  'gpt-6-luna': { input: 2.5, cachedInput: 0.25, cacheWrite: 3.125, output: 12.5 },
  'gpt-5.6-luna': { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
  'gpt-5.5': { input: 125, cachedInput: 12.5, cacheWrite: null, output: 750 },
  'gpt-5.4': { input: 62.5, cachedInput: 6.25, cacheWrite: null, output: 375 },
  'gpt-5.4-mini': { input: 18.75, cachedInput: 1.875, cacheWrite: null, output: 113 },
}

type PricingCache = { version: 3; updatedAt: string; rates: Record<string, CodexCreditRate> }

function cachePath(): string {
  const root = process.env['CODEBURN_CACHE_DIR'] ?? join(homedir(), '.cache', 'codeburn')
  return join(root, 'codex-pricing.json')
}

function parseUsd(value: string): number | null {
  const normalized = value.replace('$', '').replaceAll(',', '').trim()
  if (normalized === '-') return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function parseCodexPricingMarkdown(markdown: string): Record<string, CodexCreditRate> {
  const rates: Record<string, CodexCreditRate> = {}
  const standardHeading = /^###\s+Standard pricing data\s*$/im.exec(markdown)
  let standardTable = markdown
  if (standardHeading && standardHeading.index !== undefined) {
    const start = standardHeading.index + standardHeading[0].length
    const remainder = markdown.slice(start)
    const nextHeading = /^###\s+/im.exec(remainder)
    standardTable = remainder.slice(0, nextHeading?.index ?? remainder.length)
  } else {
    standardTable = markdown.split(/^#{1,6}\s+All models\b/im, 1)[0] ?? markdown
  }
  let columns: { model: number; input: number; cachedInput: number; cacheWrite: number; output: number } | null = null
  for (const line of standardTable.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim().toLowerCase())
    if (cells.includes('model') && cells.some(cell => cell === 'input' || cell === 'short context input')
      && cells.some(cell => cell === 'output' || cell === 'short context output')) {
      const find = (...labels: string[]) => cells.findIndex(cell => labels.includes(cell))
      const model = find('model')
      const input = find('short context input', 'input')
      const cachedInput = find('short context cached input', 'cached input')
      const cacheWrite = find('short context 30m write', 'cache writes', 'cache write', '30m write')
      const output = find('short context output', 'output')
      columns = model >= 0 && input >= 0 && cachedInput >= 0 && output >= 0
        ? { model, input, cachedInput, cacheWrite, output }
        : null
      continue
    }
    if (!columns) continue
    const row = line.split('|').slice(1, -1).map(cell => cell.trim())
    const modelCell = row[columns.model]
    if (!modelCell || !/^gpt-/i.test(modelCell)) continue
    const model = modelCell.replace(/\s+\([^)]*\)\s*$/, '').trim().toLowerCase()
    const input = parseUsd(row[columns.input] ?? '')
    const cachedInput = parseUsd(row[columns.cachedInput] ?? '')
    const cacheWrite = columns.cacheWrite < 0 ? null : parseUsd(row[columns.cacheWrite] ?? '')
    const output = parseUsd(row[columns.output] ?? '')
    if (input === null || cachedInput === null || output === null) continue
    rates[model] = {
      input: input * CREDITS_PER_USD,
      cachedInput: cachedInput * CREDITS_PER_USD,
      cacheWrite: cacheWrite === null ? null : cacheWrite * CREDITS_PER_USD,
      output: output * CREDITS_PER_USD,
    }
  }
  if (Object.keys(rates).length === 0) throw new Error('pricing table contained no usable model rates')
  return rates
}

async function readCachedPricing(): Promise<Record<string, CodexCreditRate> | null> {
  try {
    const path = cachePath()
    const raw = JSON.parse(await readFile(path, 'utf8')) as PricingCache
    const updated = Date.parse(raw.updatedAt)
    if (raw.version !== 3 || !Number.isFinite(updated) || Date.now() - updated > CACHE_TTL_MS) return null
    return raw.rates
  } catch {
    return null
  }
}

async function fetchPricing(): Promise<Record<string, CodexCreditRate>> {
  const response = await fetchWithTimeout(PRICING_URL)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const rates = parseCodexPricingMarkdown(await response.text())
  try {
    const existing = JSON.parse(await readFile(cachePath(), 'utf8')) as PricingCache
    if (existing.version === 3 && existing.rates && isDeepStrictEqual(existing.rates, rates)) return rates
  } catch {
    // Missing or malformed caches are replaced with the fetched pricing data.
  }
  await mkdir(dirname(cachePath()), { recursive: true })
  await writeFile(cachePath(), JSON.stringify({ version: 3, updatedAt: new Date().toISOString(), rates }, null, 2))
  return rates
}

export async function refreshCodexPricing(): Promise<void> {
  const cached = await readCachedPricing()
  if (cached) {
    Object.assign(CREDITS_PER_MILLION, cached)
  } else {
    try {
      Object.assign(CREDITS_PER_MILLION, await fetchPricing())
    } catch {
      try {
        const stale = JSON.parse(await readFile(cachePath(), 'utf8')) as PricingCache
        if (stale.version === 3 && stale.rates) Object.assign(CREDITS_PER_MILLION, stale.rates)
      } catch {
        // Built-in rates keep watch usable when the official page is unavailable.
      }
    }
  }
  const config = await readConfig()
  for (const [model, override] of Object.entries(config.priceOverrides ?? {})) {
    const input = Number(override.input)
    const cachedInput = Number(override.cacheRead ?? input * 0.1)
    const cacheWrite = Number(override.cacheCreation ?? input * 1.25)
    const output = Number(override.output)
    if ([input, cachedInput, cacheWrite, output].every(value => Number.isFinite(value) && value >= 0)) {
      CREDITS_PER_MILLION[model.toLowerCase()] = {
        input: input * CREDITS_PER_USD,
        cachedInput: cachedInput * CREDITS_PER_USD,
        cacheWrite: cacheWrite * CREDITS_PER_USD,
        output: output * CREDITS_PER_USD,
      }
    }
  }
}

/// Resolve the credit rate for a Codex model name, tolerating suffix variants
/// (e.g. "gpt-5.5-codex"). Returns null when the model has no known credit rate.
export function codexCreditRate(model: string): CodexCreditRate | null {
  const m = model.toLowerCase().replace(/-codex$/, '')
  if (CREDITS_PER_MILLION[m]) return CREDITS_PER_MILLION[m]!
  // Match the version only at a token boundary (start/'-' before, '-'/end
  // after) so a bare `includes('5.4')` can't catch a substring. The tokens
  // AFTER the version give the SKU tier: only the base and `-mini` SKUs have
  // credit rates, so a distinct sibling tier (gpt-5.4-pro, gpt-5.4-nano) must
  // fall through to the unknown fallback instead of billing at the base rate.
  const match = m.match(/(?:^|-)(5\.[45])(?:-|$)/)
  if (!match) return null
  const version = match[1]!
  const tierTokens = m.slice(match.index! + match[0].length).split('-')
  if (tierTokens.includes('pro') || tierTokens.includes('nano')) return null
  if (version === '5.4' && tierTokens.includes('mini')) return CREDITS_PER_MILLION['gpt-5.4-mini']!
  if (version === '5.4') return CREDITS_PER_MILLION['gpt-5.4']!
  if (version === '5.5') return CREDITS_PER_MILLION['gpt-5.5']!
  return null
}

export type CodexCreditTokens = {
  /// Non-cached input tokens (CodeBurn normalizes Codex to Anthropic semantics,
  /// so this excludes cache-read tokens).
  inputTokens: number
  /// Cache-read (cached input) tokens, billed at the cheaper cached rate.
  cachedReadTokens: number
  cacheWriteTokens?: number
  /// Billable output tokens: reasoning is already included (billableOutputTokens
  /// in models.ts), so callers must not add it on top here.
  outputTokens: number
  /// Reasoning tokens are a reported output breakdown. Do not add them to
  /// outputTokens unless a provider price explicitly requires that treatment.
  reasoningTokens?: number
}

/// Credits consumed for one Codex usage record. Returns null when the model has
/// no known credit rate (caller decides how to surface "unknown").
export function codexCredits(model: string, tokens: CodexCreditTokens): number | null {
  const rate = codexCreditRate(model)
  if (!rate) return null
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
  const PER_MILLION = 1_000_000
  const cacheWrites = safe(tokens.cacheWriteTokens ?? 0)
  if (cacheWrites > 0 && rate.cacheWrite === null) return null
  const output = safe(tokens.outputTokens)
  return (
    (safe(tokens.inputTokens) / PER_MILLION) * rate.input +
    (safe(tokens.cachedReadTokens) / PER_MILLION) * rate.cachedInput +
    (cacheWrites / PER_MILLION) * (rate.cacheWrite ?? 0) +
    (safe(tokens.outputTokens) / PER_MILLION) * rate.output
  )
}

export function codexCostUsd(model: string, tokens: CodexCreditTokens): number | null {
  const credits = codexCredits(model, tokens)
  return credits === null ? null : credits / CREDITS_PER_USD
}
