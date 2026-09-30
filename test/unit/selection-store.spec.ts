/**
 * The board's selection rule and the viewing state its store owns.
 *
 * The rule is the whole reason the store exists: an explicit click must win over
 * a derived answer, but only while the attachment it was made against still
 * holds — otherwise a debate created later in the same Session would be hidden
 * behind an older click.
 *
 * The store's own tests describe ONE instance. The renderer resolves one per
 * Session key, because the slot this half registers into is declared
 * `scope: 'session'`, so nothing here may assume a process-wide singleton.
 */
import { describe, expect, test } from 'vitest'

import { createDebateSelectionStore, resolveSelectedDebate } from '../../src/client/selection-store.ts'

describe('createDebateSelectionStore', () => {
  test('one instance starts with no pick and a collapsed list', () => {
    const instance = createDebateSelectionStore().create()
    expect(instance.getSnapshot()).toEqual({ manual: {}, listExpanded: false })
  })

  test('records one pick per Session', () => {
    const instance = createDebateSelectionStore().create()
    instance.actions.choose('session-1', 'debate-a', null)
    instance.actions.choose('session-2', 'debate-b', 'debate-a')
    expect(instance.getSnapshot().manual).toEqual({
      'session-1': { debateId: 'debate-a', basis: null },
      'session-2': { debateId: 'debate-b', basis: 'debate-a' },
    })
  })

  test('a later pick in one Session replaces the earlier one', () => {
    const instance = createDebateSelectionStore().create()
    instance.actions.choose('session-1', 'debate-a', null)
    instance.actions.choose('session-1', 'debate-b', null)
    expect(instance.getSnapshot().manual['session-1']).toEqual({ debateId: 'debate-b', basis: null })
  })

  test('notifies subscribers of a pick', () => {
    const instance = createDebateSelectionStore().create()
    let notified = 0
    instance.subscribe(() => { notified += 1 })
    instance.actions.choose('session-1', 'debate-a', null)
    expect(notified).toBe(1)
  })

  test('records the list visibility the user asked for, in both directions', () => {
    const instance = createDebateSelectionStore().create()
    instance.actions.setListExpanded(true)
    expect(instance.getSnapshot().listExpanded).toBe(true)
    instance.actions.setListExpanded(false)
    expect(instance.getSnapshot().listExpanded).toBe(false)
  })

  test('keeps the pick and the list visibility as separate facts', () => {
    const instance = createDebateSelectionStore().create()
    instance.actions.choose('session-1', 'debate-a', null)
    instance.actions.setListExpanded(true)
    expect(instance.getSnapshot()).toEqual({
      manual: { 'session-1': { debateId: 'debate-a', basis: null } },
      listExpanded: true,
    })
  })

  test('notifies subscribers of a list toggle', () => {
    const instance = createDebateSelectionStore().create()
    let notified = 0
    instance.subscribe(() => { notified += 1 })
    instance.actions.setListExpanded(true)
    expect(notified).toBe(1)
  })

  test('two handles are independent instances, list visibility included', () => {
    const first = createDebateSelectionStore().create()
    const second = createDebateSelectionStore().create()
    first.actions.choose('session-1', 'debate-a', null)
    first.actions.setListExpanded(true)
    expect(second.getSnapshot()).toEqual({ manual: {}, listExpanded: false })
  })
})

describe('resolveSelectedDebate', () => {
  test('a manual pick wins while its basis still holds', () => {
    expect(resolveSelectedDebate({
      sessionId: 'session-1',
      manual: { debateId: 'picked', basis: 'attached' },
      attachment: 'attached',
    })).toBe('picked')
  })

  test('a newer attachment supersedes an older pick', () => {
    // The C1-adjacent case: the user clicked a debate, then the agent created
    // another one in the SAME Session. The board must open on the new one.
    expect(resolveSelectedDebate({
      sessionId: 'session-1',
      manual: { debateId: 'picked', basis: 'attached' },
      attachment: 'created-later',
    })).toBe('created-later')
  })

  test('a pick made with no attachment survives while the Session still owns none', () => {
    expect(resolveSelectedDebate({
      sessionId: 'session-1',
      manual: { debateId: 'picked', basis: null },
      attachment: null,
    })).toBe('picked')
  })

  test('an Opponent Session resolves through the prefix, over a stale pick', () => {
    expect(resolveSelectedDebate({
      sessionId: 'dsh-debate-abc',
      manual: undefined,
      attachment: null,
    })).toBe('abc')
  })

  test('the attachment is the last derived source', () => {
    expect(resolveSelectedDebate({
      sessionId: 'session-1',
      manual: undefined,
      attachment: 'attached',
    })).toBe('attached')
  })

  test('a Session with nothing to show resolves to no selection', () => {
    expect(resolveSelectedDebate({
      sessionId: 'session-1',
      manual: undefined,
      attachment: null,
    })).toBeUndefined()
  })
})
