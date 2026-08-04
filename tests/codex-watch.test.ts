import { describe, expect, it } from 'vitest'
import { processCodexLine, type CodexWatchState } from '../src/codex-watch.js'

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
      outputTokens: 200,
      reasoningTokens: 50,
    })
    expect(record?.costUsd).toBeGreaterThan(0)
    expect(record?.credits).toBeGreaterThan(0)
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
})
