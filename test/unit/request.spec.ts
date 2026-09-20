/**
 * Pure request helpers.
 *
 * These run without the harness build on purpose: `src/request.ts` imports
 * nothing from `@deepseek-ai/*`, so every rule the bridge enforces on a body is
 * decided by code this file can exercise directly.
 */

import { describe, expect, test } from 'vitest'
import {
  buildSessionTitle,
  deriveSessionId,
  MAX_TITLE_CHARS,
  parseJsonObject,
  parseStartRequest,
  parseStatusRequest,
  parseStopRequest,
  SESSION_ID_PREFIX,
} from '../../src/request.ts'

/** A minimal valid start body, overridable per case. */
function startBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    debateId: 'd-1f2e3d4c',
    title: 'Debate d-1f2e3d4c — Opponent',
    prompt: 'You are the Opponent.',
    agentPreset: '',
    permissionPreset: 'danger-full-access',
    workspacePath: '/Users/example/aweave',
    ...overrides,
  }
}

describe('parseJsonObject', () => {
  test('accepts a JSON object and rejects every other JSON shape', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 })
    // Each of these is a validation failure with the same 4xx body, so they
    // must not be distinguishable from a malformed body.
    expect(parseJsonObject('[]')).toBeUndefined()
    expect(parseJsonObject('"text"')).toBeUndefined()
    expect(parseJsonObject('null')).toBeUndefined()
    expect(parseJsonObject('3')).toBeUndefined()
    expect(parseJsonObject('{oops')).toBeUndefined()
    expect(parseJsonObject('')).toBeUndefined()
  })
})

describe('identity derivation', () => {
  test('the session id is deterministic and prefixed', () => {
    expect(deriveSessionId('d-1f2e3d4c')).toBe(`${SESSION_ID_PREFIX}d-1f2e3d4c`)
    // Stability across calls is the whole idempotency story.
    expect(deriveSessionId('d-1f2e3d4c')).toBe(deriveSessionId('d-1f2e3d4c'))
    expect(deriveSessionId('a')).not.toBe(deriveSessionId('b'))
  })

  test('the title is collapsed and truncated with an ellipsis', () => {
    expect(buildSessionTitle('  Debate   A  ')).toBe('Debate A')
    expect(buildSessionTitle('x'.repeat(MAX_TITLE_CHARS))).toHaveLength(MAX_TITLE_CHARS)
    const cut = buildSessionTitle('y'.repeat(MAX_TITLE_CHARS + 50))
    expect(cut).toHaveLength(MAX_TITLE_CHARS)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('parseStartRequest', () => {
  test('a complete body round-trips, with "" meaning the host default', () => {
    const parsed = parseStartRequest(startBody())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual({
      debateId: 'd-1f2e3d4c',
      title: 'Debate d-1f2e3d4c — Opponent',
      prompt: 'You are the Opponent.',
      agentPreset: '',
      permissionPreset: 'danger-full-access',
      workspacePath: '/Users/example/aweave',
    })
    // `exactOptionalPropertyTypes` discipline: absent optionals are ABSENT, not undefined.
    expect('sessionId' in parsed.value).toBe(false)
    expect('model' in parsed.value).toBe(false)
  })

  test('each required field is rejected when missing, blank or wrong-typed', () => {
    for (const field of ['debateId', 'title', 'prompt', 'workspacePath']) {
      const missing = parseStartRequest(startBody({ [field]: undefined }))
      expect(missing.ok, `${field} missing`).toBe(false)
      const blank = parseStartRequest(startBody({ [field]: '   ' }))
      expect(blank.ok, `${field} blank`).toBe(false)
      const typed = parseStartRequest(startBody({ [field]: 7 }))
      expect(typed.ok, `${field} wrong type`).toBe(false)
      if (!typed.ok) expect(typed.error).toBe(`${field} must be a string`)
    }
    const nulled = parseStartRequest(startBody({ title: null }))
    expect(nulled.ok).toBe(false)
  })

  test('a malformed debate id is rejected — it becomes a session id AND a directory name', () => {
    for (const bad of ['..', '.', '-lead', '_lead', 'a/b', 'a b', 'a\\b', 'a:b', '']) {
      const parsed = parseStartRequest(startBody({ debateId: bad }))
      expect(parsed.ok, `debateId ${JSON.stringify(bad)}`).toBe(false)
    }
    expect(parseStartRequest(startBody({ debateId: 'A.b_c-9' })).ok).toBe(true)
  })

  test('a caller-supplied sessionId is validated with the same identifier rules', () => {
    const good = parseStartRequest(startBody({ sessionId: 'dsh-debate-abc' }))
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.value.sessionId).toBe('dsh-debate-abc')
    expect(parseStartRequest(startBody({ sessionId: '../escape' })).ok).toBe(false)
    expect(parseStartRequest(startBody({ sessionId: 12 })).ok).toBe(false)
  })

  test('model is optional, shape-checked, and blank means the host default', () => {
    const present = parseStartRequest(startBody({ model: 'deepseek/deepseek-v3' }))
    expect(present.ok).toBe(true)
    if (present.ok) expect(present.value.model).toBe('deepseek/deepseek-v3')
    // Blank is the same request as absent, never a route the host is told to
    // run: the live resolver maps both onto the host's default selection.
    const blank = parseStartRequest(startBody({ model: '   ' }))
    expect(blank.ok).toBe(true)
    if (blank.ok) expect(blank.value.model).toBe('')
    expect(parseStartRequest(startBody({ model: 3 })).ok).toBe(false)
  })

  test('a wrong-typed preset is rejected rather than read as the default', () => {
    expect(parseStartRequest(startBody({ permissionPreset: 1 })).ok).toBe(false)
    expect(parseStartRequest(startBody({ agentPreset: [] })).ok).toBe(false)
    // Absent and "" both mean the host default.
    const absent = parseStartRequest({
      debateId: 'd',
      title: 't',
      prompt: 'p',
      workspacePath: '/w',
    })
    expect(absent.ok).toBe(true)
    if (absent.ok) {
      expect(absent.value.agentPreset).toBe('')
      expect(absent.value.permissionPreset).toBe('')
    }
  })

  test('oversized fields are refused, so no single body can be unbounded', () => {
    expect(parseStartRequest(startBody({ prompt: 'x'.repeat(64 * 1024 + 1) })).ok).toBe(false)
    expect(parseStartRequest(startBody({ workspacePath: `/${'x'.repeat(4096)}` })).ok).toBe(false)
    expect(parseStartRequest(startBody({ title: 'x'.repeat(4097) })).ok).toBe(false)
  })
})

describe('parseStopRequest / parseStatusRequest', () => {
  test('both verbs require exactly one valid sessionId', () => {
    expect(parseStopRequest({ sessionId: 'dsh-debate-x' })).toEqual({
      ok: true,
      value: { sessionId: 'dsh-debate-x' },
    })
    expect(parseStatusRequest({ sessionId: 'dsh-debate-x' })).toEqual({
      ok: true,
      value: { sessionId: 'dsh-debate-x' },
    })
    expect(parseStopRequest({}).ok).toBe(false)
    expect(parseStatusRequest({ sessionId: '' }).ok).toBe(false)
    expect(parseStatusRequest({ sessionId: '../etc/passwd' }).ok).toBe(false)
    expect(parseStopRequest({ sessionId: 'ok', extra: true }).ok).toBe(true)
  })
})
