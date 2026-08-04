import { describe, expect, it } from 'vitest'
import { formatCodexUsageRecord, processCodexLine, type CodexWatchState } from '../src/codex-watch.js'

function meta(): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { session_id: 'session-1', cwd: '/work/project', model: 'gpt-5.4' },
  })
}

function tokens(last: Record<string, number> | undefined, total: Record<string, number>): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-04T12:00:00.000Z',
    payload: {
      type: 'token_count',
      info: { ...(last ? { last_token_usage: last } : {}), total_token_usage: total },
    },
  })
}

function rawResponse(responseId: string, usage?: Record<string, number>): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-04T12:00:01.000Z',
    payload: {
      type: 'raw_response_completed',
      response_id: responseId,
      ...(usage ? { token_usage: usage } : {}),
    },
  })
}

describe('Codex live usage processing', () => {
  it('primes session metadata and normalizes cached input', () => {
    const state: CodexWatchState = {}
    expect(processCodexLine(state, meta(), '/rollout.jsonl')).toBeNull()

    const record = processCodexLine(state, tokens(
      { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50 },
      { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1650 },
    ), '/rollout.jsonl')

    expect(record).toMatchObject({
      sessionId: 'session-1',
      projectPath: '/work/project',
      model: 'gpt-5.4',
      inputTokens: 600,
      cachedInputTokens: 400,
      cacheWriteTokens: 0,
      outputTokens: 200,
      reasoningTokens: 50,
    })
    expect(record?.costUsd).toBeGreaterThan(0)
    expect(record?.usageSource).toBe('token_count_estimate')
  })

  it('uses exact raw completion usage and suppresses token snapshots', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, meta(), '/rollout.jsonl')
    const record = processCodexLine(state, rawResponse('resp-1', {
      input_tokens: 1000,
      cached_input_tokens: 400,
      cache_write_input_tokens: 30,
      output_tokens: 200,
      reasoning_output_tokens: 50,
      total_tokens: 1680,
    }), '/rollout.jsonl')

    expect(record).toMatchObject({
      responseId: 'resp-1',
      usageSource: 'raw_response_completed',
      inputTokens: 600,
      cachedInputTokens: 400,
      cacheWriteTokens: 30,
      outputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1680,
    })
    expect(record?.credits).toBeNull()
    expect(processCodexLine(state, tokens(undefined, {
      input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200,
      reasoning_output_tokens: 50, total_tokens: 1650,
    }), '/rollout.jsonl')).toBeNull()
    expect(processCodexLine(state, rawResponse('resp-1', {
      input_tokens: 1000, output_tokens: 200, total_tokens: 1200,
    }), '/rollout.jsonl')).toBeNull()
  })

  it('keeps missing raw usage unknown rather than zero-priced', () => {
    const state: CodexWatchState = { model: 'gpt-5.6-luna' }
    const record = processCodexLine(state, rawResponse('resp-missing'), '/rollout.jsonl')
    expect(record).toMatchObject({ usageUnknown: true, costUsd: null, totalTokens: undefined })
  })

  it('tracks cache-write tokens separately', () => {
    const state: CodexWatchState = { model: 'gpt-5.6-luna' }
    const record = processCodexLine(state, tokens(
      { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 200 },
    ), '/rollout.jsonl')
    expect(record).toMatchObject({ inputTokens: 80, cachedInputTokens: 20, cacheWriteTokens: 30 })
  })

  it('converts cumulative-only usage into per-request deltas', () => {
    const state: CodexWatchState = { model: 'gpt-5.4' }
    const first = processCodexLine(state, tokens(
      undefined,
      { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 170 },
    ), '/rollout.jsonl')
    const second = processCodexLine(state, tokens(
      undefined,
      { input_tokens: 250, cached_input_tokens: 70, output_tokens: 90, reasoning_output_tokens: 30, total_tokens: 440 },
    ), '/rollout.jsonl')

    expect(first).toMatchObject({ inputTokens: 80, cachedInputTokens: 20, outputTokens: 40, reasoningTokens: 10 })
    expect(second).toMatchObject({ inputTokens: 100, cachedInputTokens: 50, outputTokens: 50, reasoningTokens: 20 })
  })

  it('suppresses a repeated cumulative checkpoint', () => {
    const state: CodexWatchState = { model: 'gpt-5.4' }
    const line = tokens(
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    )
    expect(processCodexLine(state, line, '/rollout.jsonl')).not.toBeNull()
    expect(processCodexLine(state, line, '/rollout.jsonl')).toBeNull()
  })

  it('preserves the exact model identifier from turn context metadata', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna', cwd: '/work/project', session_id: 'session-2' },
    }), '/rollout.jsonl')
    const record = processCodexLine(state, tokens(
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ), '/rollout.jsonl')
    expect(record?.model).toBe('gpt-5.6-luna')
  })

  it('does not report an unknown Codex catalog slug as zero cost', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'codex-auto-review' },
    }), '/rollout.jsonl')
    const record = processCodexLine(state, tokens(
      { input_tokens: 100, output_tokens: 40 },
      { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
    ), '/rollout.jsonl')
    expect(record?.costUsd).toBeNull()
    expect(record?.credits).toBeNull()
  })

  it('does not assume a model when the rollout omits model metadata', () => {
    const state: CodexWatchState = {}
    const record = processCodexLine(state, tokens(
      { input_tokens: 100, output_tokens: 40 },
      { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
    ), '/rollout.jsonl')
    expect(record).toMatchObject({ model: 'unknown', costUsd: null, credits: null })
  })

  it('renders selected human-readable fields using date-style tokens', () => {
    const record = {
      loggedAt: '2026-08-04T12:00:01.000Z',
      timestamp: '2026-08-04T12:00:00.000Z',
      sessionId: 'session-1',
      projectPath: '/work/project',
      model: 'gpt-5.6-luna',
      inputTokens: 600,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningTokens: 50,
      costUsd: 0.00535,
      credits: 0.13375,
      source: '/rollout.jsonl',
    }
    expect(formatCodexUsageRecord(record, '%t %m i=%i c=%c o=%o r=%r $%d %C')).toBe(
      '2026-08-04T12:00:00.000Z gpt-5.6-luna i=600 c=400 o=200 r=50 $0.005350 0.133750',
    )
  })
})
