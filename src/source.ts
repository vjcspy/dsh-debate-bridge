/**
 * The `debate-opponent` message source.
 *
 * `MessageSourceMap` is a merge-extensible interface in `@deepseek-ai/dsh-llm`
 * (`packages/llm/llm/src/message.ts:180-185`), and a third-party producer must
 * declare its own `kind` before `createUserMessage` type-checks. The webhook is
 * the shipped precedent and the mechanism mirrored here verbatim:
 * `packages/webhook/webhook/src/types.ts:71-83` declares `webhook` inside
 * `declare module '@deepseek-ai/dsh-llm'`.
 *
 * A distinct kind — rather than reusing `plugin` or `user` — is a
 * non-interference property, not a cosmetic one: any reconciliation pass that
 * keys off `message.source.kind` must be able to tell a bridge-admitted
 * Opponent turn apart from operator input and from another plugin's pending
 * context. It says nothing to the model; the prompt text does that.
 *
 * @module dsh-debate-bridge/source
 */

/** The one `kind` every message this plugin admits carries. */
export const DEBATE_OPPONENT_SOURCE_KIND = 'debate-opponent'

/**
 * Source of one bridge-admitted Opponent turn.
 *
 * `form: 'notice'` mirrors the webhook's own choice
 * (`packages/webhook/webhook/src/types.ts:78`) rather than inventing a value:
 * the vocabulary is semantic and none of the six shipped forms describes
 * "an external orchestrator commands this session to act", while `notice` is
 * the documented shape for one-off programmatic input and gives the GUI a
 * collapsed one-line row carrying `summary`
 * (`packages/llm/llm/src/message.ts:57-71`).
 */
export interface DebateOpponentSource {
  readonly kind: 'debate-opponent'
  /** Debate this turn belongs to; the same value that derived the session id. */
  readonly debateId: string
  readonly form: 'notice'
  /** One-line account shown without expanding the transcript row. */
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'debate-opponent': DebateOpponentSource
  }
}
