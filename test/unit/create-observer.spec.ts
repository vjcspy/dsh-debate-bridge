/**
 * The Proposer attach observer: pairing, extraction, and the cost discipline.
 *
 * Two properties are load-bearing beyond "it works":
 * - the observer runs on the host's hottest feed, so a non-tool event must not
 *   reach the JSON parse or either regex. That is asserted with spies on the
 *   exported patterns rather than claimed in prose;
 * - a `debate_id` found in tool output is a CLAIM, so nothing is recorded until
 *   the debate server has confirmed it.
 */
import { describe, expect, test, vi } from 'vitest'

import { createAttachRegistry, type SessionLineage } from '../../src/host/attach-registry.ts'
import {
  CREATE_COMMAND_PATTERN,
  DEBATE_ID_PATTERN,
  createCreateObserver,
  extractDebateId,
  isCreateCommand,
  isFailedResult,
  readToolCall,
  readToolResult,
} from '../../src/host/create-observer.ts'
import { MAX_PENDING_CALL_IDS } from '../../src/config.ts'

/** One `tool/call` payload for the shell tool. */
function callPayload(callId: string, command: string, name = 'bash'): Record<string, unknown> {
  return { turn: 1, step: 1, callId, name, arguments: JSON.stringify({ command, description: 'run it' }) }
}

/**
 * One `tool/result` payload carrying stdout, as `tool-bash`'s renderer emits it.
 * @param callId - the paired call identity.
 * @param text - the tool's model-facing text.
 * @returns the event payload.
 */
function resultPayload(callId: string, text: string): Record<string, unknown> {
  return {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      source: { kind: 'tool', callId },
      content: [{ type: 'text', text }],
    },
  }
}

/** The create payload as `aw debate create --format json` pretty-prints it. */
function createOutput(debateId: string, exitCode = 0): string {
  const stdout = [
    '{',
    '  "success": true,',
    '  "content": [',
    '    {',
    '      "type": "json",',
    '      "data": {',
    `        "debate_id": "${debateId}",`,
    '        "argument_type": "MOTION",',
    '        "debate_state": "AWAITING_OPPONENT"',
    '      }',
    '    }',
    '  ]',
    '}',
  ].join('\n')
  return exitCode === 0 ? stdout : `${stdout}\n[exit code: ${String(exitCode)}]`
}

/** A fresh observer over a fresh registry, with every collaborator scripted. */
function observerFor(options: {
  readonly confirm?: (debateId: string) => Promise<boolean>
  readonly lineage?: (sessionId: string) => SessionLineage | undefined
  readonly note?: (message: string) => void
} = {}): {
  readonly registry: ReturnType<typeof createAttachRegistry>
  /** Emit one event for one Session, as the root `session/event` listener would. */
  readonly observe: (sessionId: string, type: string, data: unknown) => void
  readonly notes: string[]
} {
  const registry = createAttachRegistry()
  const notes: string[] = []
  const observer = createCreateObserver({
    registry,
    lineageOf: options.lineage ?? (sessionId => ({ id: sessionId })),
    confirm: options.confirm ?? (async () => true),
    note: options.note ?? (message => { notes.push(message) }),
    now: () => 4242,
  })
  return {
    registry,
    notes,
    observe: (sessionId, type, data) => { observer.observe({ id: sessionId }, { type, data }) },
  }
}

describe('isCreateCommand', () => {
  test('matches every spelling of a create invocation and no other verb', () => {
    for (const command of [
      'aw debate create --debate-id x --title y',
      'pnpm aw debate create --debate-id x',
      'cd /workspace && pnpm aw debate create --content "..."',
      'ID=$(aw debate generate-id) && aw\ndebate create --debate-id $ID',
    ]) {
      expect(isCreateCommand(JSON.stringify({ command })), command).toBe(true)
    }
    for (const command of [
      'aw debate list',
      'aw debate wait --debate-id x',
      'aw debate submit --content y',
      'aw debate get-context',
      'aw debate generate-id',
    ]) {
      expect(isCreateCommand(JSON.stringify({ command })), command).toBe(false)
    }
  })

  test('a shell call that never mentions the debate CLI is not parsed', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      expect(isCreateCommand('{"command":"ls -la"}')).toBe(false)
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  test('malformed model arguments are a non-match, never a throw', () => {
    expect(isCreateCommand('{"command": "aw debate create"')).toBe(false)
    expect(isCreateCommand('"a string"')).toBe(false)
    expect(isCreateCommand('{"command": 7}')).toBe(false)
  })
})

describe('readToolCall / readToolResult', () => {
  test('a non-shell tool is refused before its arguments are touched', () => {
    expect(readToolCall({ name: 'job_output', callId: 'c1', arguments: '{"command":"aw debate create"}' })).toBeUndefined()
    expect(readToolCall({ name: 'bash', callId: '', arguments: '{}' })).toBeUndefined()
    expect(readToolCall({ name: 'bash', callId: 'c1', arguments: {} })).toBeUndefined()
    expect(readToolCall(undefined)).toBeUndefined()
  })

  test('a matched shell call yields its identity', () => {
    expect(readToolCall(callPayload('c1', 'aw debate create --debate-id x'))).toEqual({ callId: 'c1' })
  })

  test('a tool result yields its paired identity and text', () => {
    expect(readToolResult(resultPayload('c1', 'hello'))).toEqual({ callId: 'c1', text: 'hello' })
    expect(readToolResult({ message: { source: {} } })).toBeUndefined()
    expect(readToolResult('nope')).toBeUndefined()
  })

  test('a result carrying no text block yields no text', () => {
    expect(readToolResult({
      message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'image', url: 'x' }] },
    })).toEqual({ callId: 'c1', text: undefined })
  })
})

describe('extractDebateId / isFailedResult', () => {
  test('reads the id out of a pretty-printed envelope', () => {
    expect(extractDebateId(createOutput('debate-1'))).toBe('debate-1')
  })

  test('reads the id across a stderr section and a markdown fence', () => {
    const text = `\`\`\`json\n${createOutput('debate-2')}\n\`\`\`\n[stderr]\n$ node bin/run.js\n`
    expect(extractDebateId(text)).toBe('debate-2')
  })

  test('a successful result carries no exit marker at all', () => {
    // `renderResult` emits `[exit code: N]` only for a non-zero code, so this
    // asserts the shape the extractor relies on rather than an "exit code: 0"
    // marker that never appears.
    expect(isFailedResult(createOutput('debate-1'))).toBe(false)
  })

  test('a non-zero exit code marks the result failed', () => {
    expect(isFailedResult(createOutput('debate-1', 7))).toBe(true)
    expect(extractDebateId(createOutput('debate-1', 7))).toBe('debate-1')
  })

  test('an interrupted call marks the result failed', () => {
    expect(isFailedResult('[timed out after 300000ms]')).toBe(true)
    expect(isFailedResult('[killed by signal: SIGKILL]')).toBe(true)
    expect(isFailedResult('[stopped: user]')).toBe(true)
  })

  test('an unrelated numeric marker is not an exit code', () => {
    expect(isFailedResult('processed 3 items')).toBe(false)
    expect(isFailedResult(createOutput('debate-1'))).toBe(false)
  })
})

describe('createCreateObserver', () => {
  test('records the attachment after a matched create and its confirmed result', async () => {
    const h = observerFor()
    h.observe('session-1', 'tool/call', callPayload('c1', 'pnpm aw debate create --debate-id d1 --title t'))
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1')))
    await vi.waitFor(() => { expect(h.registry.read('session-1')).toEqual({ debateId: 'd1', observedAt: 4242 }) })
  })

  test('a non-create verb never arms a pairing', async () => {
    const h = observerFor()
    for (const command of ['aw debate list', 'aw debate wait --debate-id d1', 'aw debate generate-id']) {
      h.observe('session-1', 'tool/call', callPayload('c1', command))
      h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1')))
    }
    await Promise.resolve()
    expect(h.registry.read('session-1')).toBeUndefined()
  })

  test('a result whose call was never matched is ignored', async () => {
    const h = observerFor()
    h.observe('session-1', 'tool/result', resultPayload('c-other', createOutput('d1')))
    await Promise.resolve()
    expect(h.registry.read('session-1')).toBeUndefined()
  })

  test('a matched call is consumed, so its result is inspected once', async () => {
    const h = observerFor()
    h.observe('session-1', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1')))
    await vi.waitFor(() => { expect(h.registry.read('session-1')).toBeDefined() })
    // A duplicate result for the same call must not be read a second time.
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d2')))
    await Promise.resolve()
    expect(h.registry.read('session-1')?.debateId).toBe('d1')
  })

  test('a non-bash tool is ignored', async () => {
    const h = observerFor()
    h.observe('session-1', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1', 'job_output'))
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1')))
    await Promise.resolve()
    expect(h.registry.read('session-1')).toBeUndefined()
  })

  test('a failed create is a silent miss, not an attachment', async () => {
    const h = observerFor()
    h.observe('session-1', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1', 3)))
    await Promise.resolve()
    expect(h.registry.read('session-1')).toBeUndefined()
    expect(h.notes).toHaveLength(1)
  })

  test('an unparseable payload is a silent miss', async () => {
    const h = observerFor()
    h.observe('session-1', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
    h.observe('session-1', 'tool/result', resultPayload('c1', '[stderr]\nboom'))
    await Promise.resolve()
    expect(h.registry.read('session-1')).toBeUndefined()
    expect(h.notes).toHaveLength(1)
  })

  test('an unconfirmed debate id is not recorded', async () => {
    const h = observerFor({ confirm: async () => false })
    h.observe('session-1', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1')))
    await vi.waitFor(() => { expect(h.notes).toHaveLength(1) })
    expect(h.registry.read('session-1')).toBeUndefined()
  })

  test('a confirmation that throws is contained', async () => {
    const h = observerFor({ confirm: async () => { throw new Error('upstream down') } })
    h.observe('session-1', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
    h.observe('session-1', 'tool/result', resultPayload('c1', createOutput('d1')))
    await vi.waitFor(() => { expect(h.notes).toHaveLength(1) })
    expect(h.registry.read('session-1')).toBeUndefined()
    expect(h.notes[0]).toContain('upstream down')
  })

  test('a create delegated to a subagent attaches where the user is looking', async () => {
    const lineage = new Map<string, SessionLineage>([
      ['child', { id: 'child', parentSession: 'root', origin: 'subagent' }],
      ['root', { id: 'root' }],
    ])
    const h = observerFor({ lineage: id => lineage.get(id) })
    h.observe('child', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
    h.observe('child', 'tool/result', resultPayload('c1', createOutput('d1')))
    await vi.waitFor(() => { expect(h.registry.read('root')).toBeDefined() })
    expect(h.registry.read('child')?.debateId).toBe('d1')
    expect(h.registry.read('root')?.debateId).toBe('d1')
  })

  test('an event that is neither a tool call nor a tool result touches no parser', () => {
    const h = observerFor()
    const parse = vi.spyOn(JSON, 'parse')
    const create = vi.spyOn(CREATE_COMMAND_PATTERN, 'test')
    const extract = vi.spyOn(DEBATE_ID_PATTERN, 'exec')
    try {
      for (const type of ['assistant/message', 'turn/end', 'user/message', 'request/header', 'agent/status']) {
        h.observe('session-1', type, { anything: 'aw debate create debate_id' })
      }
      // The claim "no work on unrelated events" is asserted, not narrated: the
      // parse and both regexes are never reached.
      expect(parse).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      expect(extract).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
      create.mockRestore()
      extract.mockRestore()
    }
  })

  test('an event without a readable Session id is ignored', () => {
    const h = observerFor()
    const parse = vi.spyOn(JSON, 'parse')
    try {
      h.observe('', 'tool/call', callPayload('c1', 'aw debate create --debate-id d1'))
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  test('the remembered call-id set is bounded', async () => {
    const h = observerFor()
    for (let index = 0; index < MAX_PENDING_CALL_IDS + 5; index += 1) {
      h.observe('session-1', 'tool/call', callPayload(`c${String(index)}`, 'aw debate create --debate-id d1'))
    }
    // The oldest ids were evicted, so their results can no longer attach.
    h.observe('session-1', 'tool/result', resultPayload('c0', createOutput('d-old')))
    await Promise.resolve()
    expect(h.registry.read('session-1')).toBeUndefined()
    // While the newest pairing still works.
    const newest = `c${String(MAX_PENDING_CALL_IDS + 4)}`
    h.observe('session-1', 'tool/result', resultPayload(newest, createOutput('d-new')))
    await vi.waitFor(() => { expect(h.registry.read('session-1')?.debateId).toBe('d-new') })
  })
})
