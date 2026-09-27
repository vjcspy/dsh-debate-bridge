/**
 * The always-on attachment watcher.
 *
 * The mounted-Session subscription alone cannot drive auto-open. In the Proposer
 * case the user is ALREADY viewing the Session when the agent runs
 * `aw debate create`: `mounted` never changes, and the tab is closed so nothing
 * in a body is polling. The attachment would land in the Host registry with no
 * client reading it and the board would appear only after leaving and
 * re-entering the Session. This watcher therefore runs from `apply`, in the
 * plugin's own world, and reads the attachment for whatever Session is mounted.
 *
 * It keys on DERIVED sources only — the Opponent prefix rule and the recorded
 * attachment never move when the user clicks a debate — so a click can never
 * re-issue an open.
 *
 * Two recorded residuals, both accepted:
 * - a repeat trigger in a SPLIT layout lands a second copy in the active pane,
 *   because page deduplication is per pane rather than per surface;
 * - the attachment is in-memory, so a Host restart mid-debate loses it and the
 *   board falls back to the arena with no selection.
 *
 * @module dsh-debate-bridge/client/attach-watch
 */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'

import { ATTACH_POLL_INTERVAL_MS } from '../config.ts'
import { debateIdFromSessionId } from './lib/debate-session.ts'

/**
 * Viewport widths strictly below this present an expanded right column
 * fullscreen, so a background activation must park it again.
 */
export const NARROW_MAX_WIDTH = 768

/** The reactive fact the registration's `hooks` compartment publishes. */
export interface DebateAttachmentSnapshot {
  /** The Session the snapshot describes, or `undefined` while no seat is mounted. */
  readonly sessionId: string | undefined
  /** Its recorded debate, or `null` when it owns none (or the read failed). */
  readonly debateId: string | null
}

/** One attachment read. */
export interface AttachmentRead {
  /** Whether the read succeeded; a failed read never moves the baseline. */
  readonly ok: boolean
  /** The recorded debate, or `null` when the Session owns none. */
  readonly debateId: string | null
}

/** What the auto-open rule reads. */
export interface AutoOpenInput {
  /** The Session whose seat is mounted. */
  readonly mountedSessionId: string | undefined
  /** Its attachment, or `undefined` when no read has arrived for it yet. */
  readonly attachment: string | null | undefined
  /** The attachment recorded when this Session's baseline was armed, or `undefined` before that. */
  readonly baseline: string | null | undefined
  /** `(sessionId, debateId)` keys already auto-opened in this page load. */
  readonly opened: ReadonlySet<string>
}

/**
 * The auto-open key for one activation.
 * @param sessionId - the Session.
 * @param debateId - the debate opened for it.
 * @returns the key used to rate-limit that activation to once per page load.
 */
export function autoOpenKey(sessionId: string, debateId: string): string {
  return `${sessionId}\u0000${debateId}`
}

/**
 * Resolve whether this read should open the board, and on which debate.
 *
 * Two derived triggers, in order:
 * 1. the Opponent prefix rule, which resolves the moment a
 *    `dsh-debate-<debateId>` Session is mounted;
 * 2. a CHANGE of the recorded attachment away from the Session's baseline, which
 *    is what fires while the user stays inside an ordinary Session.
 *
 * The manual pick is deliberately absent: a user click writes the store, and a
 * click must never re-issue an open.
 * @param input - the mounted Session, its attachment, its baseline, and what was already opened.
 * @returns the debate to open on, or `undefined` to leave the layout alone.
 */
export function autoOpenTarget(input: AutoOpenInput): string | undefined {
  const sessionId = input.mountedSessionId
  if (sessionId === undefined) return undefined
  const fromPrefix = debateIdFromSessionId(sessionId)
  if (fromPrefix !== undefined) {
    return input.opened.has(autoOpenKey(sessionId, fromPrefix)) ? undefined : fromPrefix
  }
  if (input.attachment === undefined || input.attachment === null) return undefined
  // An unarmed baseline is arming on this very read; only the prefix rule may
  // act on it. A page load never pops the board open on pre-existing state.
  if (input.baseline === undefined) return undefined
  if (input.baseline === input.attachment) return undefined
  return input.opened.has(autoOpenKey(sessionId, input.attachment)) ? undefined : input.attachment
}

/** Everything the watcher reads and does. */
export interface AttachWatchOptions {
  /** The mounted-Session source owned by the right-sidebar controller. */
  readonly mounted: ObservableSnapshot<string | undefined>
  /** Open this plugin's tab kind in the mounted Session's layout. */
  readonly openTab: () => void
  /** Whether the right column currently shows its panel. */
  readonly isExpanded: () => boolean
  /** Collapse the column, or expand it and focus its active dock pane. */
  readonly toggleExpanded: () => void
  /** Whether the viewport is narrow enough for an expanded column to be fullscreen. */
  readonly isNarrow: () => boolean
  /**
   * Read one Session's attachment.
   * @param sessionId - the Session to read.
   * @returns the read outcome; `ok: false` leaves the baseline untouched.
   */
  readonly readAttachment: (sessionId: string) => Promise<AttachmentRead>
  /** Debug-level sink for a failed read or a refused open. */
  readonly note: (message: string) => void
  /** Poll interval, in milliseconds. */
  readonly intervalMs?: number
}

/** The running watcher. */
export interface AttachWatch {
  /** The bare observable the registration's `hooks` compartment publishes. */
  readonly source: ObservableSnapshot<DebateAttachmentSnapshot>
  /** Subscribe to the mounted Session and start polling. */
  start(): void
  /**
   * Take one read now.
   * @returns a promise that settles when the read and any activation are done.
   */
  poll(): Promise<void>
  /** Stop polling and release the subscription. */
  dispose(): void
}

/** The state published while no seat is mounted. */
const NO_SESSION: DebateAttachmentSnapshot = { sessionId: undefined, debateId: null }

/**
 * Create the attachment watcher.
 * @param options - the controller face, the read, and the sinks.
 * @returns the watcher; the caller owns `start()` and `dispose()`.
 */
export function createAttachWatch(options: AttachWatchOptions): AttachWatch {
  const intervalMs = options.intervalMs ?? ATTACH_POLL_INTERVAL_MS
  let snapshot: DebateAttachmentSnapshot = NO_SESSION
  let currentSession: string | undefined
  /** Sessions whose baseline has been armed, with the attachment observed then. */
  const baselines = new Map<string, string | null>()
  /** `(sessionId, debateId)` activations already issued in this page load. */
  const opened = new Set<string>()
  let unsubscribe: (() => void) | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false
  /** One read at a time: a hung read must not stack further polls behind it. */
  let inFlight = false

  const listeners = new Set<() => void>()

  const publish = (next: DebateAttachmentSnapshot): void => {
    // Identity is stable between changes: the renderer caches its hook binding
    // per source, and a fresh object every read would re-render the board on
    // every poll.
    if (next.sessionId === snapshot.sessionId && next.debateId === snapshot.debateId) return
    snapshot = next
    listeners.forEach(listener => { listener() })
  }

  /**
   * Open the tab, parking the column again when it was collapsed on a narrow
   * viewport.
   *
   * `openTab` expands the column as part of placing the tab, and below the
   * narrow breakpoint the host draws that column fullscreen, which would cover
   * the conversation. The read-then-restore pair lands both commits in one React
   * batch, so the intermediate state never renders.
   */
  const activate = (): void => {
    const wasCollapsed = !options.isExpanded()
    try {
      options.openTab()
    } catch (error: unknown) {
      options.note(`could not open the debate arena tab: ${String(error)}`)
      return
    }
    if (wasCollapsed && options.isNarrow()) options.toggleExpanded()
  }

  const poll = async (): Promise<void> => {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const sessionId = options.mounted.getSnapshot()
      if (sessionId === undefined) {
        publish(NO_SESSION)
        currentSession = undefined
        return
      }
      // A Session switch voids the previous baseline: the effect that consumed it
      // no longer describes what is on screen.
      if (sessionId !== currentSession) {
        currentSession = sessionId
        baselines.delete(sessionId)
      }
      const read = await options.readAttachment(sessionId)
      if (disposed) return
      if (!read.ok) {
        // Never treat an unreadable attachment as "none": that would re-arm the
        // baseline on the next successful read and could open the board on a
        // debate that was already there.
        options.note(`attachment read for session "${sessionId}" failed; keeping the previous baseline`)
        return
      }
      publish({ sessionId, debateId: read.debateId })
      const armed = baselines.has(sessionId)
      const baseline = baselines.get(sessionId)
      if (!armed) baselines.set(sessionId, read.debateId)
      const target = autoOpenTarget({
        mountedSessionId: sessionId,
        attachment: read.debateId,
        baseline: armed ? baseline : undefined,
        opened,
      })
      if (target === undefined) return
      opened.add(autoOpenKey(sessionId, target))
      activate()
    } finally {
      inFlight = false
    }
  }

  return {
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    start: () => {
      if (disposed || unsubscribe !== undefined) return
      unsubscribe = options.mounted.subscribe(() => { void poll() })
      timer = setInterval(() => { void poll() }, intervalMs)
      void poll()
    },
    poll,
    dispose: () => {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      unsubscribe?.()
      unsubscribe = undefined
      listeners.clear()
    },
  }
}
