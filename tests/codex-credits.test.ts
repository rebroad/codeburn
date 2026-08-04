import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexCredits, codexCreditRate, parseCodexPricingMarkdown, refreshCodexPricing } from '../src/codex-credits.js'

const originalCacheDir = process.env['CODEBURN_CACHE_DIR']

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalCacheDir === undefined) delete process.env['CODEBURN_CACHE_DIR']
  else process.env['CODEBURN_CACHE_DIR'] = originalCacheDir
})

describe('codexCreditRate', () => {
  it('resolves the documented per-model rates', () => {
    expect(codexCreditRate('gpt-5.6-luna')).toEqual({ input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 })
    expect(codexCreditRate('gpt-5.5')).toEqual({ input: 125, cachedInput: 12.5, cacheWrite: null, output: 750 })
    expect(codexCreditRate('gpt-5.4')).toEqual({ input: 62.5, cachedInput: 6.25, cacheWrite: null, output: 375 })
    expect(codexCreditRate('gpt-5.4-mini')).toEqual({ input: 18.75, cachedInput: 1.875, cacheWrite: null, output: 113 })
  })

  it('tolerates codex suffix variants and casing', () => {
    expect(codexCreditRate('GPT-5.5-codex')?.input).toBe(125)
    expect(codexCreditRate('gpt-5.4-codex-mini')?.input).toBe(18.75)
  })

  it('returns null for models with no known credit rate', () => {
    expect(codexCreditRate('gpt-4o')).toBeNull()
    expect(codexCreditRate('claude-opus-4-8')).toBeNull()
  })
})

describe('codexCredits', () => {
  it('charges 1M input tokens at the input rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 1_000_000, cachedReadTokens: 0, outputTokens: 0 })).toBe(125)
  })

  it('charges 1M output tokens at the output rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 0, outputTokens: 1_000_000 })).toBe(750)
  })

  it('charges cache-read tokens at the cheaper cached rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 1_000_000, outputTokens: 0 })).toBe(12.5)
  })

  it('charges Luna cache writes at the published rate', () => {
    expect(codexCredits('gpt-5.6-luna', { inputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 1_000_000, outputTokens: 0 })).toBe(6.25)
  })

  it('keeps reasoning as a breakdown instead of adding it to output billing', () => {
    // Reasoning is included in the provider output breakdown, not billed twice.
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 0, outputTokens: 500_000, reasoningTokens: 500_000 })).toBe(375)
  })

  it('sums a mixed record (gpt-5.4)', () => {
    // 2M input (125) + 1M cached (6.25) + 0.5M output (187.5) = 318.75
    const credits = codexCredits('gpt-5.4', { inputTokens: 2_000_000, cachedReadTokens: 1_000_000, outputTokens: 500_000 })
    expect(credits).toBeCloseTo(125 + 6.25 + 187.5, 6)
  })

  it('clamps negative / non-finite token counts to 0', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: -100, cachedReadTokens: NaN, outputTokens: 1_000_000 })).toBe(750)
  })

  it('returns null for an unknown model', () => {
    expect(codexCredits('gpt-4o', { inputTokens: 1_000_000, cachedReadTokens: 0, outputTokens: 0 })).toBeNull()
  })

  it('does not hide cache writes when the model has no published write rate', () => {
    expect(codexCredits('gpt-5.5', { inputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 1, outputTokens: 0 })).toBeNull()
    expect(codexCredits('gpt-5.5', { inputTokens: 1_000_000, cachedReadTokens: 0, outputTokens: 0 })).toBe(125)
  })
})

describe('Codex pricing page parsing', () => {
  it('keeps standard-context prices instead of overwriting them with the all-models table', () => {
    const rates = parseCodexPricingMarkdown([
      '## Flagship models',
      '| Model | Input | Cached input | Cache writes | Output |',
      '| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 |',
      '## All models',
      '| Model | Input | Cached input | Cache writes | Output |',
      '| gpt-5.6-luna | $0.10 | $0.01 | $0.125 | $0.60 |',
    ].join('\n'))
    expect(rates['gpt-5.6-luna']).toEqual({ input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 })
  })

  it('retains rows whose cache-write column is not separately priced', () => {
    const rates = parseCodexPricingMarkdown([
      '### Standard pricing data',
      '| Model | Input | Cached input | Cache writes | Output |',
      '| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 |',
      '### Batch pricing data',
      '| gpt-5.5 | $2.50 | $0.25 | - | $15.00 |',
    ].join('\n'))
    expect(rates['gpt-5.5']).toEqual({ input: 125, cachedInput: 12.5, cacheWrite: null, output: 750 })
  })

  it('rejects a page without a pricing table', () => {
    expect(() => parseCodexPricingMarkdown('# Pricing\nNo table')).toThrow()
  })

  it('uses a fresh cached pricing snapshot without fetching', async () => {
    process.env['CODEBURN_CACHE_DIR'] = await mkdtemp(join(tmpdir(), 'codeburn-pricing-'))
    await writeFile(join(process.env['CODEBURN_CACHE_DIR'], 'codex-pricing.json'), JSON.stringify({
      updatedAt: new Date().toISOString(),
      rates: { 'gpt-5.6-luna': { input: 7, cachedInput: 0.7, cacheWrite: 8.75, output: 42 } },
    }))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await refreshCodexPricing()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(codexCreditRate('gpt-5.6-luna')?.input).toBe(7)
  })

  it('falls back to a stale valid cache when the pricing page is unavailable', async () => {
    process.env['CODEBURN_CACHE_DIR'] = await mkdtemp(join(tmpdir(), 'codeburn-pricing-'))
    await writeFile(join(process.env['CODEBURN_CACHE_DIR'], 'codex-pricing.json'), JSON.stringify({
      updatedAt: '2020-01-01T00:00:00.000Z',
      rates: { 'gpt-5.6-luna': { input: 9, cachedInput: 0.9, cacheWrite: 11.25, output: 54 } },
    }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await refreshCodexPricing()
    expect(codexCreditRate('gpt-5.6-luna')?.input).toBe(9)
  })
})
