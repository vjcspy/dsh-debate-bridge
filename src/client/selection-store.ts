/**
 * The board's selection store, and the rule that resolves which debate is shown.
 *
 * Only the MANUAL pick is store state. The Opponent prefix rule and the Host's
 * attachment are stateless reads of facts the plugin already has, so storing
 * them would mirror an external snapshot into a second store; the client rules
 * keep business data in its owning service and let a declared store carry
 * viewing state only.
 *
 * The store exists at all because `keepMounted` is `false`: the dock renders a
 * body only while its tab is visited, retained or selected in the active pane,
 * so switching to another tab in the same pane unmounts the board. A pick stored
 * in component state would be lost on every such switch.
 *
 * @module dsh-debate-bridge/client/selection-store
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

import { debateIdFromSessionId } from './lib/debate-session.ts'

/**
 * One manual pick, with the attachment it was chosen against.
 *
 * `basis` is what keeps the pick from outliving its context: stored bare, a
 * click would beat a debate created LATER in the same Session, so the Proposer
 * board would open on the previously clicked debate instead of the new one.
 */
export interface ManualPick {
  /** The debate the user clicked. */
  readonly debateId: string
  /** The Session's attachment at click time, or `null` when it had none. */
  readonly basis: string | null
}

/** State: the manual picks, keyed by Session id. */
export interface DebateSelectionState {
  /** One entry per Session the user has picked a debate in. */
  readonly manual: Record<string, ManualPick>
}

/** The store's complete write set: a click, and nothing else. */
type DebateSelectionActions = {
  /**
   * Record the user's pick for one Session.
   * @param draft - store draft.
   * @param sessionId - the Session shown when the pick was made.
   * @param debateId - the debate clicked.
   * @param basis - that Session's attachment at click time.
   */
  choose: (draft: DebateSelectionState, sessionId: string, debateId: string, basis: string | null) => void
}

/**
 * Declare the manual-pick state and its write surface.
 *
 * A factory rather than a module-level handle: a module-level store would be a
 * de-facto singleton shared across activations.
 * @returns the store handle, to be created once in `apply` and passed to the
 *   tab-body registration.
 */
export function createDebateSelectionStore(): EngineStoreHandle<DebateSelectionState, DebateSelectionActions> {
  return defineStore({
    init: (): DebateSelectionState => ({ manual: {} }),
    actions: {
      choose: (draft, sessionId, debateId, basis) => {
        draft.manual[sessionId] = { debateId, basis }
      },
    },
  })
}

/** Everything the selection rule reads. */
export interface SelectionInput {
  /** The Session the board is rendering for. */
  readonly sessionId: string
  /** That Session's manual pick, when the user has made one. */
  readonly manual: ManualPick | undefined
  /** That Session's recorded attachment, or `null` when it owns no debate. */
  readonly attachment: string | null
}

/**
 * Resolve the debate the board shows, first match wins.
 *
 * An explicit user choice beats a derived one, but only while it still applies:
 * the manual entry is honoured only when its `basis` equals the CURRENT
 * attachment, so a debate created later in the same Session supersedes an older
 * click instead of being hidden behind it.
 * @param input - the Session, its manual pick, and its attachment.
 * @returns the debate to show, or `undefined` for the arena with no selection.
 */
export function resolveSelectedDebate(input: SelectionInput): string | undefined {
  if (input.manual !== undefined && input.manual.basis === input.attachment) return input.manual.debateId
  const fromPrefix = debateIdFromSessionId(input.sessionId)
  if (fromPrefix !== undefined) return fromPrefix
  return input.attachment ?? undefined
}
