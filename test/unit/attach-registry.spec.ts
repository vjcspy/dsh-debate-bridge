/**
 * The Session → debate attachment store and the ancestor walk.
 *
 * The store is deliberately event-free, so everything here is pure state: latest
 * wins per Session, no cross-Session bleed, and a walk that follows `origin`
 * rather than `parentSession` alone.
 */
import { describe, expect, test } from 'vitest'

import {
  attachTargets,
  createAttachRegistry,
  MAX_LINEAGE_HOPS,
  type SessionLineage,
} from '../../src/host/attach-registry.ts'

describe('createAttachRegistry', () => {
  test('reports nothing for a Session that never created a debate', () => {
    expect(createAttachRegistry().read('session-1')).toBeUndefined()
  })

  test('keeps one entry per Session', () => {
    const registry = createAttachRegistry()
    registry.record('session-1', 'debate-a', 100)
    registry.record('session-2', 'debate-b', 200)
    expect(registry.read('session-1')).toEqual({ debateId: 'debate-a', observedAt: 100 })
    expect(registry.read('session-2')).toEqual({ debateId: 'debate-b', observedAt: 200 })
  })

  test('latest wins for one Session', () => {
    const registry = createAttachRegistry()
    registry.record('session-1', 'debate-a', 100)
    registry.record('session-1', 'debate-b', 200)
    expect(registry.read('session-1')).toEqual({ debateId: 'debate-b', observedAt: 200 })
  })
})

describe('attachTargets', () => {
  /** A lineage table keyed by id, as a live Agent registry would answer. */
  function table(...rows: SessionLineage[]): (id: string) => SessionLineage | undefined {
    const byId = new Map(rows.map(row => [row.id, row]))
    return id => byId.get(id)
  }

  test('a root Session attaches only to itself', () => {
    const root: SessionLineage = { id: 'root' }
    expect(attachTargets(root, table(root))).toEqual(['root'])
  })

  test('a fork does NOT inherit its parent attachment', () => {
    // A fork records `parentSession` with no `origin`, and the walk keys on
    // `origin`: a fork is a new conversation, not a delegation.
    const forked: SessionLineage = { id: 'fork', parentSession: 'root' }
    expect(attachTargets(forked, table(forked, { id: 'root' }))).toEqual(['fork'])
  })

  test('a subagent child attaches to its parent, emitting first', () => {
    const child: SessionLineage = { id: 'child', parentSession: 'root', origin: 'subagent' }
    expect(attachTargets(child, table(child, { id: 'root' }))).toEqual(['child', 'root'])
  })

  test('a nested subagent attaches through every subagent ancestor', () => {
    const grandchild: SessionLineage = { id: 'gc', parentSession: 'child', origin: 'subagent' }
    const child: SessionLineage = { id: 'child', parentSession: 'root', origin: 'subagent' }
    expect(attachTargets(grandchild, table(grandchild, child, { id: 'root' })))
      .toEqual(['gc', 'child', 'root'])
  })

  test('an unknown hop stops the walk instead of guessing', () => {
    const child: SessionLineage = { id: 'child', parentSession: 'gone', origin: 'subagent' }
    expect(attachTargets(child, table(child))).toEqual(['child'])
  })

  test('a malformed cycle terminates at the hop ceiling', () => {
    const a: SessionLineage = { id: 'a', parentSession: 'b', origin: 'subagent' }
    const b: SessionLineage = { id: 'b', parentSession: 'a', origin: 'subagent' }
    const targets = attachTargets(a, table(a, b))
    expect(targets).toEqual(['a', 'b'])
    expect(targets.length).toBeLessThanOrEqual(MAX_LINEAGE_HOPS + 1)
  })
})
