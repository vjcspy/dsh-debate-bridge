/**
 * The Session → debate attachment registry.
 *
 * A Proposer-created debate has no linkage to the DSH Session that created it:
 * `debate_providers.session_id` is written for the Opponent only, and the debate
 * server knows nothing about DSH Sessions. This registry is that missing link,
 * established by {@link createCreateObserver} observing the `aw debate create`
 * tool result inside the host that ran it.
 *
 * It is deliberately IN-MEMORY and deliberately knows nothing about events: the
 * observer hands it a resolved id, so the store is a pure, unit-testable map.
 * Persisting the attachment through the session log is not an option — a custom
 * event type appended with `Session.append` cannot be marked `ignorable`, and
 * `validateStoredEvents` refuses to interpret a log containing an unknown
 * non-ignorable type, which would make the Session unloadable.
 *
 * @module dsh-debate-bridge/host/attach-registry
 */

/** One recorded attachment. */
export interface DebateAttachment {
  /** The debate this Session created. */
  readonly debateId: string
  /** Epoch milliseconds the Host observed and confirmed it. */
  readonly observedAt: number
}

/** The attachment store. */
export interface AttachRegistry {
  /**
   * Read the attachment of one Session.
   * @param sessionId - the Session to look up.
   * @returns its attachment, or `undefined` when none was ever recorded.
   */
  read(sessionId: string): DebateAttachment | undefined
  /**
   * Record an attachment, replacing any earlier one for that Session.
   * @param sessionId - the Session the debate belongs to.
   * @param debateId - the confirmed debate id.
   * @param observedAt - epoch milliseconds the Host confirmed it.
   */
  record(sessionId: string, debateId: string, observedAt: number): void
}

/**
 * Create the in-memory attachment registry.
 *
 * Latest wins per Session: replaying a create with the same ids re-prints the
 * same `debate_id`, and a Session that creates a second debate should point at
 * the newer one.
 * @returns the registry.
 */
export function createAttachRegistry(): AttachRegistry {
  const bySession = new Map<string, DebateAttachment>()
  return {
    read: sessionId => bySession.get(sessionId),
    record: (sessionId, debateId, observedAt) => { bySession.set(sessionId, { debateId, observedAt }) },
  }
}

/** The lineage fields this module walks. Mirrors `SessionHeader` without importing it. */
export interface SessionLineage {
  /** The Session's own id. */
  readonly id: string
  /** The Session this one was forked from, if any. */
  readonly parentSession?: string
  /** Set to `'subagent'` on a session created as a subagent child. */
  readonly origin?: 'subagent'
}

/** Longest ancestor walk accepted, so a malformed lineage cannot loop. */
export const MAX_LINEAGE_HOPS = 16

/**
 * Resolve every Session an observed create should attach to.
 *
 * A create delegated to a subagent runs in the CHILD Session, but the Human is
 * looking at the parent, so the attachment is recorded under the emitting
 * Session and then walked up `parentSession` while the current Session's own
 * `origin` is `'subagent'`. The walk keys on `origin` rather than on
 * `parentSession` alone because a fork also records `parentSession` and must NOT
 * inherit its parent's attachment. `delegationDepth` is deliberately not used:
 * the walk stops at the first ancestor that is not itself a subagent child,
 * which is the Session a Human can be looking at.
 * @param lineage - the emitting Session's lineage.
 * @param lookup - resolves one ancestor's lineage; an unknown hop stops the walk.
 * @returns the emitting Session's id first, then its subagent ancestors in order.
 */
export function attachTargets(
  lineage: SessionLineage,
  lookup: (sessionId: string) => SessionLineage | undefined,
): readonly string[] {
  const targets: string[] = [lineage.id]
  let current = lineage
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    if (current.origin !== 'subagent') break
    const parentId = current.parentSession
    if (parentId === undefined || targetSeen(targets, parentId)) break
    const parent = lookup(parentId)
    if (parent === undefined) break
    targets.push(parent.id)
    current = parent
  }
  return targets
}

/**
 * Report whether an id is already in the resolved chain.
 * @param targets - ids resolved so far.
 * @param candidate - the id to test.
 * @returns whether the chain already names it.
 */
function targetSeen(targets: readonly string[], candidate: string): boolean {
  return targets.includes(candidate)
}
