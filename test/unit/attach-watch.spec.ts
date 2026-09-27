/**
 * The always-on attachment watcher: what opens the board, and what must not.
 *
 * The rules are driven directly (`poll()`), so no timer decides a test's outcome;
 * `start()`'s own wiring is covered by one fake-timer case. The C1 regression
 * this file protects is the Proposer trigger: the user is ALREADY inside the
 * Session, `mounted` never changes, and only a CHANGE of the recorded attachment
 * may pop the board open.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  autoOpenKey,
  autoOpenTarget,
  createAttachWatch,
  type AttachmentRead,
  type DebateAttachmentSnapshot,
} from '../../src/client/attach-watch.ts'

/** A controllable stand-in for `ctx.sidebarRight.mounted`. */
function mountedSource(initial: string | undefined): {
  getSnapshot: () => string | undefined
  subscribe: (fn: () => void) => () => void
  set: (next: string | undefined) => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (next) => { value = next; for (const listener of [...listeners]) listener() },
  }
}

/** A watcher plus everything it did. */
interface Harness {
  readonly watch: ReturnType<typeof createAttachWatch>
  readonly mounted: ReturnType<typeof mountedSource>
  readonly opens: number[]
  readonly toggles: number[]
  readonly reads: string[]
  readonly notes: string[]
  /** Script the next reads for a Session, in order; the last answer repeats. */
  script(...answers: AttachmentRead[]): void
}

/**
 * Build a watcher whose controller face and reads are scripted.
 * @param options.mounted - the initially mounted Session id.
 * @param options.expanded - what `isExpanded()` answers, mutable via `expandedOf`.
 * @param options.narrow - what `isNarrow()` answers.
 * @param options.openThrows - make `openTab` throw, reproducing "no session surface is mounted".
 * @returns the harness.
 */
function watchFor(options: {
  readonly mounted?: string | undefined
  readonly expanded?: boolean
  readonly narrow?: boolean
  readonly openThrows?: boolean
} = {}): Harness & { state: { expanded: boolean } } {
  const mounted = mountedSource(options.mounted)
  const state = { expanded: options.expanded ?? true }
  const opens: number[] = []
  const toggles: number[] = []
  const reads: string[] = []
  const notes: string[] = []
  let queue: AttachmentRead[] = []
  const harness: Harness & { state: { expanded: boolean } } = {
    mounted,
    opens,
    toggles,
    reads,
    notes,
    state,
    script: (...answers) => { queue = [...answers] },
    watch: undefined as unknown as ReturnType<typeof createAttachWatch>,
  }
  const built = createAttachWatch({
    mounted,
    openTab: () => {
      if (options.openThrows === true) throw new Error('sidebarRight: no session surface is mounted')
      opens.push(opens.length + 1)
    },
    isExpanded: () => state.expanded,
    toggleExpanded: () => { toggles.push(toggles.length + 1) },
    isNarrow: () => options.narrow ?? false,
    readAttachment: async (sessionId) => {
      reads.push(sessionId)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      return next ?? { ok: true, debateId: null }
    },
    note: message => { notes.push(message) },
    intervalMs: 25,
  })
  Object.defineProperty(harness, 'watch', { value: built, enumerable: true })
  return harness
}

afterEach(() => {
  vi.useRealTimers()
})

describe('autoOpenTarget', () => {
  test('opens on the Opponent prefix rule the moment such a Session is mounted', () => {
    expect(autoOpenTarget({
      mountedSessionId: 'dsh-debate-abc',
      attachment: undefined,
      baseline: undefined,
      opened: new Set(),
    })).toBe('abc')
  })

  test('does not open while no seat is mounted', () => {
    expect(autoOpenTarget({
      mountedSessionId: undefined,
      attachment: 'abc',
      baseline: null,
      opened: new Set(),
    })).toBeUndefined()
  })

  test('arms on the first read instead of opening on pre-existing state', () => {
    expect(autoOpenTarget({
      mountedSessionId: 'session-1',
      attachment: 'debate-old',
      baseline: undefined,
      opened: new Set(),
    })).toBeUndefined()
  })

  test('opens when the attachment moves away from the baseline', () => {
    expect(autoOpenTarget({
      mountedSessionId: 'session-1',
      attachment: 'debate-new',
      baseline: 'debate-old',
      opened: new Set(),
    })).toBe('debate-new')
  })

  test('a Session that owns no debate never opens', () => {
    expect(autoOpenTarget({
      mountedSessionId: 'session-1',
      attachment: null,
      baseline: 'debate-old',
      opened: new Set(),
    })).toBeUndefined()
  })

  test('a repeat of the same activation does not open again', () => {
    expect(autoOpenTarget({
      mountedSessionId: 'session-1',
      attachment: 'debate-new',
      baseline: 'debate-old',
      opened: new Set([autoOpenKey('session-1', 'debate-new')]),
    })).toBeUndefined()
  })

  test('the same debate in another Session is a distinct activation', () => {
    expect(autoOpenTarget({
      mountedSessionId: 'session-2',
      attachment: 'debate-new',
      baseline: 'debate-old',
      opened: new Set([autoOpenKey('session-1', 'debate-new')]),
    })).toBe('debate-new')
  })
})

describe('createAttachWatch', () => {
  test('opens the board on a dsh-debate Session without any attachment', async () => {
    const h = watchFor({ mounted: 'dsh-debate-abc' })
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
    expect(h.watch.source.getSnapshot()).toEqual({ sessionId: 'dsh-debate-abc', debateId: null })
  })

  test('a Proposer create opens the board while the user stays in the Session', async () => {
    const h = watchFor({ mounted: 'session-1' })
    h.script({ ok: true, debateId: null })
    await h.watch.poll()
    expect(h.opens).toEqual([])
    h.script({ ok: true, debateId: 'debate-1' })
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
    // The same attachment on the next poll is not a new activation.
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
    expect(h.watch.source.getSnapshot()).toEqual({ sessionId: 'session-1', debateId: 'debate-1' })
  })

  test('a page load with a pre-existing attachment never pops the board open', async () => {
    const h = watchFor({ mounted: 'session-1' })
    h.script({ ok: true, debateId: 'debate-old' })
    await h.watch.poll()
    expect(h.opens).toEqual([])
    expect(h.watch.source.getSnapshot()).toEqual({ sessionId: 'session-1', debateId: 'debate-old' })
  })

  test('a failed read never re-arms the baseline', async () => {
    const h = watchFor({ mounted: 'session-1' })
    h.script({ ok: false, debateId: null })
    await h.watch.poll()
    expect(h.opens).toEqual([])
    // The first SUCCESSFUL read arms the baseline; it must not open on the value
    // that was already there while the read was failing.
    h.script({ ok: true, debateId: 'debate-old' })
    await h.watch.poll()
    expect(h.opens).toEqual([])
    expect(h.notes[0]).toContain('keeping the previous baseline')
  })

  test('reports no Session while no seat is mounted, and picks up a later mount', async () => {
    const h = watchFor({ mounted: undefined })
    await h.watch.poll()
    expect(h.watch.source.getSnapshot()).toEqual({ sessionId: undefined, debateId: null })
    expect(h.reads).toEqual([])
    h.mounted.set('dsh-debate-xyz')
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
  })

  test('a Session switch drops the previous baseline', async () => {
    const h = watchFor({ mounted: 'session-a' })
    h.script({ ok: true, debateId: 'a1' })
    await h.watch.poll()
    h.mounted.set('session-b')
    h.script({ ok: true, debateId: 'b1' })
    await h.watch.poll()
    // Arming for the new Session: no open on its pre-existing attachment.
    expect(h.opens).toEqual([])
    h.script({ ok: true, debateId: 'b2' })
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
  })

  test('republishes one snapshot reference while nothing changes', async () => {
    const h = watchFor({ mounted: 'session-1' })
    h.script({ ok: true, debateId: 'debate-1' })
    await h.watch.poll()
    const first: DebateAttachmentSnapshot = h.watch.source.getSnapshot()
    await h.watch.poll()
    expect(h.watch.source.getSnapshot()).toBe(first)
  })

  test('notifies subscribers only when the snapshot moves', async () => {
    const h = watchFor({ mounted: 'session-1' })
    let notifications = 0
    const unsubscribe = h.watch.source.subscribe(() => { notifications += 1 })
    h.script({ ok: true, debateId: null })
    await h.watch.poll()
    expect(notifications).toBe(1)
    await h.watch.poll()
    expect(notifications).toBe(1)
    h.script({ ok: true, debateId: 'debate-1' })
    await h.watch.poll()
    expect(notifications).toBe(2)
    unsubscribe()
  })

  test('parks the column again on a narrow viewport it had collapsed', async () => {
    const h = watchFor({ mounted: 'dsh-debate-abc', expanded: false, narrow: true })
    await h.watch.poll()
    expect(h.opens).toHaveLength(1)
    expect(h.toggles).toHaveLength(1)
  })

  test('leaves an expanded column alone on a narrow viewport', async () => {
    const h = watchFor({ mounted: 'dsh-debate-abc', expanded: true, narrow: true })
    await h.watch.poll()
    expect(h.toggles).toEqual([])
  })

  test('leaves a wide viewport to the host', async () => {
    const h = watchFor({ mounted: 'dsh-debate-abc', expanded: false, narrow: false })
    await h.watch.poll()
    expect(h.toggles).toEqual([])
  })

  test('a refused open is contained and does not toggle the column', async () => {
    const h = watchFor({ mounted: 'dsh-debate-abc', expanded: false, narrow: true, openThrows: true })
    await h.watch.poll()
    expect(h.toggles).toEqual([])
    expect(h.notes[0]).toContain('no session surface is mounted')
  })

  test('one read is in flight at a time', async () => {
    const h = watchFor({ mounted: 'session-1' })
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const reads: string[] = []
    const built = createAttachWatch({
      mounted: h.mounted,
      openTab: () => {},
      isExpanded: () => true,
      toggleExpanded: () => {},
      isNarrow: () => false,
      readAttachment: async (sessionId) => {
        reads.push(sessionId)
        await blocked
        return { ok: true, debateId: null }
      },
      note: () => {},
    })
    const first = built.poll()
    const second = built.poll()
    release?.()
    await Promise.all([first, second])
    expect(reads).toHaveLength(1)
    built.dispose()
  })

  test('start() subscribes to the mounted Session and polls on an interval', async () => {
    vi.useFakeTimers()
    const h = watchFor({ mounted: 'session-1' })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.reads).toEqual(['session-1'])
    await vi.advanceTimersByTimeAsync(30)
    expect(h.reads.length).toBeGreaterThan(1)
    h.mounted.set('dsh-debate-abc')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.opens).toHaveLength(1)
    h.watch.dispose()
    const afterDispose = h.reads.length
    await vi.advanceTimersByTimeAsync(100)
    expect(h.reads).toHaveLength(afterDispose)
  })

  test('dispose() is idempotent and stops further reads', async () => {
    vi.useFakeTimers()
    const h = watchFor({ mounted: 'session-1' })
    h.watch.start()
    await vi.advanceTimersByTimeAsync(0)
    const before = h.reads.length
    h.watch.dispose()
    h.watch.dispose()
    await vi.advanceTimersByTimeAsync(100)
    // A disposed watcher neither polls on its interval nor on a late mount
    // change; the interleaved call also proves dispose() cannot throw twice.
    h.mounted.set('dsh-debate-abc')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.reads).toHaveLength(before)
    expect(h.opens).toEqual([])
  })
})
