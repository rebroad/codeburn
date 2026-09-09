import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'
import {
  formatCodexUsageRecord,
  processCodexLine,
  readAppended,
  type CodexWatchFileState,
  type CodexWatchState,
} from '../src/codex-watch.js'

function meta(): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { session_id: 'session-1', cwd: '/work/project', model: 'gpt-5.4' },
  })
}

function tokens(
  last: Record<string, number> | undefined,
  total: Record<string, number>,
  effectiveModel?: string,
): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-04T12:00:00.000Z',
    payload: {
      type: 'token_count',
      ...(effectiveModel ? { effective_model: effectiveModel } : {}),
      info: { ...(last ? { last_token_usage: last } : {}), total_token_usage: total },
    },
  })
}

function rawResponse(responseId: string, usage?: Record<string, number>, effectiveModel?: string): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-04T12:00:01.000Z',
    payload: {
      type: 'raw_response_completed',
      response_id: responseId,
      ...(effectiveModel ? { effective_model: effectiveModel } : {}),
      ...(usage ? { token_usage: usage } : {}),
    },
  })
}

function routedRawResponse(responseId: string, model: string): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-04T12:00:02.000Z',
    payload: {
      type: 'raw_response_completed',
      response_id: responseId,
      effective_model: model,
      token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  })
}

describe('Codex live usage processing', () => {
  it('streams a large append without materializing all lines at once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeburn-codex-watch-'))
    const filePath = join(directory, 'rollout-test.jsonl')
    const lineCount = 120_000
    await writeFile(filePath, '{"type":"ignored"}\n'.repeat(lineCount), 'utf8')
    const file = await stat(filePath)
    const state: CodexWatchFileState = {
      offset: 0,
      pending: '',
      decoder: new StringDecoder('utf8'),
      device: file.dev,
      inode: file.ino,
      discardingOversizeLine: false,
      usage: {},
    }
    let received = 0

    await readAppended(filePath, state, async (line) => {
      expect(line).toBe('{"type":"ignored"}')
      received += 1
    })

    expect(received).toBe(lineCount)
    expect(state.offset).toBe(file.size)
    expect(state.pending).toBe('')
  })

  it('does not bill cumulative token-count snapshots', () => {
    const state: CodexWatchState = {}
    expect(processCodexLine(state, meta(), '/rollout.jsonl')).toBeNull()

    expect(processCodexLine(state, tokens(
      { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50 },
      { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1650 },
    ), '/rollout.jsonl')).toBeNull()
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
    }, 'gpt-5.6-luna'), '/rollout.jsonl')

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
    expect(record?.credits).toBeCloseTo(0.0093875, 8)
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

  it('uses the backend effective model for routed completions', () => {
    const state: CodexWatchState = { model: 'codex-auto-review' }
    const record = processCodexLine(state, routedRawResponse('resp-routed', 'gpt-5.6-luna'), '/rollout.jsonl')
    expect(record).toMatchObject({ model: 'gpt-5.6-luna', costUsd: expect.any(Number) })
    expect(record?.credits).toBeCloseTo(0.0011, 8)
  })

  it('tracks cache-write tokens separately', () => {
    const state: CodexWatchState = { model: 'gpt-5.6-luna' }
    const record = processCodexLine(state, rawResponse('resp-cache-write', {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 30,
      output_tokens: 40,
      reasoning_output_tokens: 10,
      total_tokens: 200,
    }), '/rollout.jsonl')
    expect(record).toMatchObject({ inputTokens: 80, cachedInputTokens: 20, cacheWriteTokens: 30 })
  })

  it('does not convert cumulative-only snapshots into billable deltas', () => {
    const state: CodexWatchState = { model: 'gpt-5.4' }
    const first = processCodexLine(state, tokens(
      undefined,
      { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 170 },
    ), '/rollout.jsonl')
    const second = processCodexLine(state, tokens(
      undefined,
      { input_tokens: 250, cached_input_tokens: 70, output_tokens: 90, reasoning_output_tokens: 30, total_tokens: 440 },
    ), '/rollout.jsonl')

    expect(first).toBeNull()
    expect(second).toBeNull()
  })

  it('suppresses a repeated cumulative checkpoint', () => {
    const state: CodexWatchState = { model: 'gpt-5.4' }
    const line = tokens(
      { input_tokens: 10, output_tokens: 5 },
      { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    )
    expect(processCodexLine(state, line, '/rollout.jsonl')).toBeNull()
    expect(processCodexLine(state, line, '/rollout.jsonl')).toBeNull()
  })

  it('preserves the exact model identifier from turn context metadata', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna', cwd: '/work/project', session_id: 'session-2' },
    }), '/rollout.jsonl')
    const record = processCodexLine(state, rawResponse('resp-model', {
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
    }), '/rollout.jsonl')
    expect(record?.model).toBe('gpt-5.6-luna')
  })

  it('attributes each completion to the model active for that turn', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.4' },
    }), '/rollout.jsonl')
    const first = processCodexLine(state, rawResponse('resp-old', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }), '/rollout.jsonl')

    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna' },
    }), '/rollout.jsonl')
    const second = processCodexLine(state, rawResponse('resp-new', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }), '/rollout.jsonl')

    expect(first?.model).toBe('gpt-5.4')
    expect(second?.model).toBe('gpt-5.6-luna')
  })

  it('updates the active model from thread settings applied events', () => {
    const state: CodexWatchState = { model: 'gpt-5.4' }
    processCodexLine(state, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'thread_settings_applied',
        thread_settings: { model: 'gpt-5.6-luna' },
      },
    }), '/rollout.jsonl')

    const record = processCodexLine(state, rawResponse('resp-settings-model', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }), '/rollout.jsonl')

    expect(record?.model).toBe('gpt-5.6-luna')
  })

  it('keeps the latest model setting after later rollout records', () => {
    const state: CodexWatchState = { model: 'gpt-5.6-sol' }
    processCodexLine(state, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-luna' } },
    }), '/rollout.jsonl')
    processCodexLine(state, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1 } } },
    }), '/rollout.jsonl')

    const record = processCodexLine(state, rawResponse('resp-latest-model', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }), '/rollout.jsonl')

    expect(record?.model).toBe('gpt-5.6-luna')
  })

  it('reads the session id from session metadata id', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'session_meta',
      payload: { id: 'session-from-metadata', cwd: '/work/project', model: 'gpt-5.6-luna' },
    }), '/rollout.jsonl')
    const record = processCodexLine(state, rawResponse('resp-session-id', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }), '/rollout.jsonl')

    expect(record?.sessionId).toBe('session-from-metadata')
  })

  it('does not report an unknown Codex catalog slug as zero cost', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'codex-auto-review' },
    }), '/rollout.jsonl')
    const record = processCodexLine(state, rawResponse('resp-unpriced', {
      input_tokens: 100, output_tokens: 40, total_tokens: 140,
    }), '/rollout.jsonl')
    expect(record?.costUsd).toBeNull()
    expect(record?.credits).toBeNull()
  })

  it('resolves a Codex catalog alias before billing', () => {
    const state: CodexWatchState = {
      model: 'codex-auto-review',
      modelAliases: { 'codex-auto-review': 'gpt-5.6-luna' },
    }
    const record = processCodexLine(state, rawResponse('resp-alias', {
      input_tokens: 100, output_tokens: 40, total_tokens: 140,
    }), '/rollout.jsonl')
    expect(record).toMatchObject({ model: 'gpt-5.6-luna', costUsd: expect.any(Number) })
    expect(record?.credits).toBeCloseTo(0.0017, 8)
  })

  it('does not assume a model when the rollout omits model metadata', () => {
    const state: CodexWatchState = {}
    const record = processCodexLine(state, rawResponse('resp-no-model', {
      input_tokens: 100, output_tokens: 40, total_tokens: 140,
    }), '/rollout.jsonl')
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
