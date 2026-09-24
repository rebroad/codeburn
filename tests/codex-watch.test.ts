import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { describe, expect, it } from 'vitest'
import {
  formatCodexUsageRecord,
  loadCodexAccountInfo,
  processCodexLine,
  processCodexRateLimitLine,
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

function usageRecord(
  responseId: string,
  usage?: Record<string, number>,
  effectiveModel?: string,
  sessionId: string | null = 'session-1',
): string {
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp: '2026-08-04T12:00:01.000Z',
    payload: {
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      ...(sessionId ? { session_id: sessionId } : {}),
      root_turn_id: 'turn-1',
      account_id: 'account-one',
      response_id: responseId,
      ...(effectiveModel ? { effective_model: effectiveModel } : {}),
      ...(usage ? { usage } : {}),
      usage_metadata: { amount: '0.125000000000000001' },
    },
  })
}

function usageWithoutAccount(responseId: string, usage: Record<string, number>): string {
  const entry = JSON.parse(usageRecord(responseId, usage)) as { payload: Record<string, unknown> }
  delete entry.payload['account_id']
  return JSON.stringify(entry)
}

function routedUsageRecord(responseId: string, model: string): string {
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp: '2026-08-04T12:00:02.000Z',
    payload: {
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      session_id: 'session-1',
      root_turn_id: 'turn-1',
      account_id: 'account-one',
      response_id: responseId,
      effective_model: model,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  })
}

describe('Codex live usage processing', () => {
  it('emits quota snapshots from token_count and only when the selected window changes', () => {
    const state: CodexWatchState = {
      accountId: 'account-one',
      accountUpdateSeen: true,
      accountEmails: { 'account-one': 'one@example.test' },
    }
    const quotaLine = (usedPercent: number, primaryUsedPercent = 10) => JSON.stringify({
      type: 'event_msg', timestamp: '2026-08-04T12:00:01.000Z',
      payload: { type: 'token_count', rate_limits: {
        limit_id: 'codex', limit_name: 'Codex',
        primary: { used_percent: primaryUsedPercent, window_minutes: 300, resets_at: 1_800_000_000 },
        secondary: { used_percent: usedPercent, window_minutes: 10080, resets_at: 1_800_100_000 },
      } },
    })

    const first = processCodexRateLimitLine(state, quotaLine(25), '/rollout.jsonl')
    expect(first).toMatchObject({
      type: 'rate_limit_snapshot', accountId: 'account-one', accountEmail: 'one@example.test',
      limitId: 'codex',
      primary: { usedPercent: 10, resetAt: 1_800_000_000, windowMinutes: 300 },
      secondary: { usedPercent: 25, resetAt: 1_800_100_000, windowMinutes: 10080 },
    })
    expect(processCodexRateLimitLine(state, quotaLine(25), '/rollout.jsonl')).toBeNull()
    expect(processCodexRateLimitLine(state, quotaLine(26), '/rollout.jsonl')?.secondary?.usedPercent).toBe(26)
    expect(processCodexRateLimitLine(state, quotaLine(26, 11), '/rollout.jsonl')?.primary?.usedPercent).toBe(11)

    const globalState = new Map<string, string>()
    const left = { ...state, lastRateLimitSignature: undefined }
    const right = { ...state, lastRateLimitSignature: undefined }
    expect(processCodexRateLimitLine(left, quotaLine(30), '/left.jsonl', globalState)).not.toBeNull()
    expect(processCodexRateLimitLine(right, quotaLine(30), '/right.jsonl', globalState)).toBeNull()
  })

  it('uses auth fallback only when the rollout has no account signal', () => {
    const state: CodexWatchState = { fallbackAccountId: 'auth-account', accountEmails: { 'auth-account': 'auth@example.test' } }
    const inferred = processCodexLine(state, usageWithoutAccount('resp-inferred', { input_tokens: 100, output_tokens: 20 }), '/rollout.jsonl')
    expect(inferred).toMatchObject({ accountId: 'auth-account', accountEmail: 'auth@example.test' })

    const explicit = processCodexLine(state, usageRecord('resp-explicit', { input_tokens: 100, output_tokens: 20 }), '/rollout.jsonl')
    expect(explicit?.accountId).toBe('account-one')
  })

  it('uses the latest account update and treats an explicit null as authoritative', () => {
    const state: CodexWatchState = { fallbackAccountId: 'auth-account' }
    processCodexLine(state, JSON.stringify({ type: 'event_msg', payload: { type: 'account_updated', account_id: 'rollout-account' } }), '/rollout.jsonl')
    expect(processCodexLine(state, usageWithoutAccount('resp-updated', { input_tokens: 1 }), '/rollout.jsonl')?.accountId).toBe('rollout-account')
    processCodexLine(state, JSON.stringify({ type: 'event_msg', payload: { type: 'account_updated', account_id: null } }), '/rollout.jsonl')
    expect(processCodexLine(state, usageWithoutAccount('resp-null', { input_tokens: 1 }), '/rollout.jsonl')?.accountId).toBeUndefined()
  })

  it('reads the current auth account and tolerates missing or malformed auth files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeburn-auth-'))
    const previousHome = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = directory
    try {
      expect(await loadCodexAccountInfo()).toMatchObject({ emails: {} })
      await writeFile(join(directory, 'auth.json'), '{broken', 'utf8')
      expect(await loadCodexAccountInfo()).toMatchObject({ emails: {} })
      const jwt = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email: 'active@example.test' } })).toString('base64url')}.x`
      await writeFile(join(directory, 'auth.json'), JSON.stringify({ tokens: { account_id: 'active-account', access_token: jwt } }), 'utf8')
      expect(await loadCodexAccountInfo()).toEqual({
        activeAccountId: 'active-account',
        emails: { 'active-account': 'active@example.test' },
      })
    } finally {
      if (previousHome === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = previousHome
    }
  })

  it('refreshes the inferred account between usage records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codeburn-auth-switch-'))
    const previousHome = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = directory
    const auth = (accountId: string, email: string) => {
      const jwt = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email } })).toString('base64url')}.x`
      return JSON.stringify({ tokens: { account_id: accountId, access_token: jwt } })
    }
    try {
      const state: CodexWatchState = {}
      await writeFile(join(directory, 'auth.json'), auth('first-account', 'first@example.test'), 'utf8')
      const first = await loadCodexAccountInfo()
      state.fallbackAccountId = first.activeAccountId
      state.accountEmails = first.emails
      expect(processCodexLine(state, usageWithoutAccount('resp-first-account', { input_tokens: 1 }), '/rollout.jsonl')?.accountId)
        .toBe('first-account')

      await writeFile(join(directory, 'auth.json'), auth('second-account', 'second@example.test'), 'utf8')
      const current = await loadCodexAccountInfo()
      state.fallbackAccountId = current.activeAccountId
      state.accountEmails = current.emails
      expect(processCodexLine(state, usageWithoutAccount('resp-second-account', { input_tokens: 1 }), '/rollout.jsonl'))
        .toMatchObject({ accountId: 'second-account', accountEmail: 'second@example.test' })
    } finally {
      if (previousHome === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = previousHome
    }
  })

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

  it('uses per-response usage records and suppresses token snapshots', () => {
    const state: CodexWatchState = { accountEmails: { 'account-one': 'account@example.test' } }
    processCodexLine(state, meta(), '/rollout.jsonl')
    expect(processCodexLine(state, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'account_updated', account_id: 'account-one' },
    }), '/rollout.jsonl')).toBeNull()
    const record = processCodexLine(state, usageRecord('resp-1', {
      input_tokens: 1000,
      cached_input_tokens: 400,
      cache_write_input_tokens: 30,
      output_tokens: 200,
      reasoning_output_tokens: 50,
      total_tokens: 1680,
    }, 'gpt-5.6-luna'), '/rollout.jsonl')

    expect(record).toMatchObject({
      responseId: 'resp-1',
      accountId: 'account-one',
      accountEmail: 'account@example.test',
      usageSource: 'token_usage_record',
      reportedAmount: '0.125000000000000001',
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
    expect(processCodexLine(state, usageRecord('resp-1', {
      input_tokens: 1000, output_tokens: 200, total_tokens: 1200,
    }), '/rollout.jsonl')).toBeNull()
  })

  it('uses the backend effective model for routed completions', () => {
    const state: CodexWatchState = { model: 'codex-auto-review' }
    const record = processCodexLine(state, routedUsageRecord('resp-routed', 'gpt-5.6-luna'), '/rollout.jsonl')
    expect(record).toMatchObject({ model: 'gpt-5.6-luna', costUsd: expect.any(Number) })
    expect(record?.credits).toBeCloseTo(0.0011, 8)
  })

  it('tracks cache-write tokens separately', () => {
    const state: CodexWatchState = { model: 'gpt-5.6-luna' }
    const record = processCodexLine(state, usageRecord('resp-cache-write', {
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 30,
      output_tokens: 40,
      reasoning_output_tokens: 10,
      total_tokens: 200,
    }), '/rollout.jsonl')
    expect(record).toMatchObject({ inputTokens: 80, cachedInputTokens: 20, cacheWriteTokens: 30 })
    expect(formatCodexUsageRecord(record!, 'cache_write=%w')).toBe('cache_write=30')
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
    const record = processCodexLine(state, usageRecord('resp-model', {
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
    const first = processCodexLine(state, usageRecord('resp-old', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }), '/rollout.jsonl')

    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'gpt-5.6-luna' },
    }), '/rollout.jsonl')
    const second = processCodexLine(state, usageRecord('resp-new', {
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

    const record = processCodexLine(state, usageRecord('resp-settings-model', {
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

    const record = processCodexLine(state, usageRecord('resp-latest-model', {
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
    const record = processCodexLine(state, usageRecord('resp-session-id', {
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
    }, undefined, null), '/rollout.jsonl')

    expect(record?.sessionId).toBe('session-from-metadata')
  })

  it('prices Codex auto review at the assumed gpt-6-luna rate', () => {
    const state: CodexWatchState = {}
    processCodexLine(state, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'codex-auto-review' },
    }), '/rollout.jsonl')
    const record = processCodexLine(state, usageRecord('resp-unpriced', {
      input_tokens: 100, output_tokens: 40, total_tokens: 140,
    }), '/rollout.jsonl')
    expect(record).toMatchObject({ model: 'auto-review', costUsd: expect.any(Number) })
    expect(record?.costUsd).toBeCloseTo(0.00003, 8)
    expect(record?.credits).toBeCloseTo(0.00075, 8)
  })

  it('resolves a Codex catalog alias before billing', () => {
    const state: CodexWatchState = {
      model: 'codex-auto-review',
      modelAliases: { 'codex-auto-review': 'gpt-5.6-luna' },
    }
    const record = processCodexLine(state, usageRecord('resp-alias', {
      input_tokens: 100, output_tokens: 40, total_tokens: 140,
    }), '/rollout.jsonl')
    expect(record).toMatchObject({ model: 'auto-review', costUsd: expect.any(Number) })
    expect(record?.credits).toBeCloseTo(0.0017, 8)
  })

  it('does not assume a model when the rollout omits model metadata', () => {
    const state: CodexWatchState = {}
    const record = processCodexLine(state, usageRecord('resp-no-model', {
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
    expect(formatCodexUsageRecord({ ...record, accountId: 'account-one', accountEmail: 'account@example.test' }, 'account=%a')).toBe(
      'account=account@example.test',
    )
  })
})
