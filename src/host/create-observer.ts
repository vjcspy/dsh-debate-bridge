/**
 * The Proposer-side attach observer.
 *
 * DSH acting as Proposer creates a debate by running `aw debate create` through
 * the shell tool inside an ordinary Session. Nothing links that debate back to
 * the Session, so this module establishes the link observationally: it pairs the
 * `tool/call` of a `debate create` invocation with its `tool/result` by
 * `callId`, extracts the `debate_id` the CLI itself echoes, confirms it against
 * the debate server, and records `sessionId → debateId`.
 *
 * **The anchor is the create RESULT, not the command line.** `aw debate create`
 * echoes `debate_id` in its success payload, and that stdout is the model-facing
 * result text. Parsing the command line instead would miss the common
 * `ID=$(pnpm aw debate generate-id)` → `--debate-id $ID` flow, because `create`
 * performs no id-format validation.
 *
 * **Cost on the hot path.** `session/event` fires for every Session in the host,
 * including subagent children. The first statement is therefore the discriminant
 * filter: no allocation, no parse and no regex runs for any other event type.
 *
 * The module imports nothing from the harness and reads the event
 * structurally, so its rules run in milliseconds under `test/unit`.
 *
 * @module dsh-debate-bridge/host/create-observer
 */
import { MAX_PENDING_CALL_IDS } from '../config.ts'
import { attachTargets, type AttachRegistry, type SessionLineage } from './attach-registry.ts'

/** The shell tool whose calls carry an `aw debate create` command. */
export const SHELL_TOOL_NAME = 'bash'

/**
 * The command that anchors an attachment.
 *
 * Form-agnostic by construction: the prefix may be a bare global `aw …` or a
 * `cd … && pnpm aw …`, and `\s+` spans the newline a multi-line command may
 * carry. Every other `aw debate` verb (`wait`, `submit`, `get-context`, `list`,
 * `appeal`, `ruling`, …) is explicitly not an anchor.
 */
export const CREATE_COMMAND_PATTERN = /\baw\s+debate\s+create\b/

/**
 * The debate id inside a create payload.
 *
 * A whole-string JSON parse would fail: the payload is pretty-printed multi-line
 * JSON wrapped in the tool's own envelope, which may also carry a `[stderr]`
 * section and an `[exit code: N]` marker. This pattern reads across all of them.
 */
export const DEBATE_ID_PATTERN = /"debate_id"\s*:\s*"([^"]+)"/u

/**
 * The tool's exit marker, which precedes the reason the remainder is ignored.
 *
 * `renderResult` emits a marker only for a NON-ZERO exit code, so a successful
 * create carries none; a failed one carries `[exit code: 7]` or a signal/timeout
 * marker alongside whatever partial output preceded the failure.
 */
export const EXIT_CODE_PATTERN = /\[exit code: (\d+)\]/u

/** Marks an interrupted call (`[timed out after …]`, `[killed by signal: …]`). */
const INTERRUPTED_PATTERN = /\[(?:timed out after|killed by signal:|stopped:)/u

/** One session event, read structurally: this module acts on two of its types only. */
export interface SessionEventLike {
  /** Event discriminant. */
  readonly type: string
  /** Event payload, validated field by field before use. */
  readonly data?: unknown
}

/** The Session a `session/event` emission came from. */
export interface EmittingSession {
  /** The emitting Session's id. */
  readonly id: string
}

/** Facts one matched `aw debate create` tool call yields. */
export interface MatchedCreateCall {
  /** The tool-call identity that pairs this call with its result. */
  readonly callId: string
}

/** Facts one inspected `tool/result` yields. */
export interface InspectedResult {
  /** The tool-call identity this result answers. */
  readonly callId: string
  /** The model-facing result text, or `undefined` when it carries no text block. */
  readonly text: string | undefined
}

/** Observer collaborators, all injected so the rules are testable without a host. */
export interface CreateObserverOptions {
  /** The registry an observed create writes to. */
  readonly registry: AttachRegistry
  /**
   * Resolve one Session's lineage.
   * @param sessionId - the Session to resolve.
   * @returns its lineage, or `undefined` when it is unknown (the walk then stops).
   */
  readonly lineageOf: (sessionId: string) => SessionLineage | undefined
  /**
   * Confirm a candidate debate id against the debate server.
   * @param debateId - the id found in the tool output.
   * @returns whether the debate server serves it.
   */
  readonly confirm: (debateId: string) => Promise<boolean>
  /** Debug-level sink for silent misses; never user-facing. */
  readonly note: (message: string) => void
  /** Clock used to stamp a recorded attachment. */
  readonly now: () => number
}

/** The running observer. */
export interface CreateObserver {
  /**
   * Handle one `session/event` emission.
   * @param session - the emitting Session.
   * @param event - the appended event.
   */
  observe(session: EmittingSession, event: SessionEventLike): void
}

/**
 * Read the create identity out of a `tool/call` payload.
 *
 * A `tool/call` is model-facing JSON, so every field is validated before use:
 * the raw `arguments` string is matched, never evaluated.
 * @param data - the event's payload.
 * @returns the call identity when this is a shell call, or `undefined`.
 */
export function readToolCall(data: unknown): MatchedCreateCall | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as { name?: unknown; callId?: unknown; arguments?: unknown }
  // The tool name is checked before anything is parsed or allocated.
  if (record.name !== SHELL_TOOL_NAME) return undefined
  if (typeof record.callId !== 'string' || record.callId === '') return undefined
  if (typeof record.arguments !== 'string') return undefined
  if (!isCreateCommand(record.arguments)) return undefined
  return { callId: record.callId }
}

/**
 * Test whether a shell tool call's raw arguments carry a `debate create` command.
 *
 * The `includes` pre-check runs before the parse so the common case (a shell call
 * that never mentions the debate CLI) costs one substring search.
 * @param argumentsText - the tool's raw `arguments` JSON.
 * @returns whether the call's `command` invokes `aw debate create`.
 */
export function isCreateCommand(argumentsText: string): boolean {
  if (!argumentsText.includes('debate')) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(argumentsText)
  } catch {
    // Malformed model arguments are simply not a create call.
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const command = (parsed as { command?: unknown }).command
  return typeof command === 'string' && CREATE_COMMAND_PATTERN.test(command)
}

/**
 * Read the pair identity and text out of a `tool/result` payload.
 * @param data - the event's payload.
 * @returns the call identity and result text, or `undefined` when unreadable.
 */
export function readToolResult(data: unknown): InspectedResult | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return undefined
  const callId = (source as { callId?: unknown }).callId
  if (typeof callId !== 'string' || callId === '') return undefined
  return { callId, text: readResultText(message) }
}

/**
 * Join the text blocks of a model-facing tool-result message.
 * @param message - the `ToolResultMessage` payload.
 * @returns the joined text, or `undefined` when it carries no text block.
 */
function readResultText(message: object): string | undefined {
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * Report whether a result text describes a call that failed or was interrupted.
 *
 * A non-zero `[exit code: N]` marker means the command did not complete, so the
 * `debate_id` anywhere in its partial output is not a created debate. A timeout,
 * signal or external stop is the same conclusion.
 * @param text - the model-facing result text.
 * @returns whether the result must be ignored.
 */
export function isFailedResult(text: string): boolean {
  if (INTERRUPTED_PATTERN.test(text)) return true
  const exit = EXIT_CODE_PATTERN.exec(text)
  return exit !== null && exit[1] !== '0'
}

/**
 * Extract the debate id a create payload echoes.
 * @param text - the model-facing result text.
 * @returns the id, or `undefined` when no payload reached the result.
 */
export function extractDebateId(text: string): string | undefined {
  const match = DEBATE_ID_PATTERN.exec(text)
  return match?.[1]
}

/**
 * Create the observer.
 *
 * Remembered `callId`s are bounded ({@link MAX_PENDING_CALL_IDS}) and dropped
 * when their result arrives, so a long Session cannot grow the set without
 * bound and a duplicate result is never inspected twice.
 * @param options - registry, lineage lookup, confirmation, and sinks.
 * @returns the observer.
 */
export function createCreateObserver(options: CreateObserverOptions): CreateObserver {
  const pending = new Set<string>()
  return {
    observe(session, event) {
      // Filter FIRST: nothing below runs for any other event type, which is what
      // keeps this listener affordable on the host's hottest feed.
      if (event.type !== 'tool/call' && event.type !== 'tool/result') return
      const sessionId = session.id
      if (typeof sessionId !== 'string' || sessionId === '') return

      if (event.type === 'tool/call') {
        const call = readToolCall(event.data)
        if (call === undefined) return
        pending.delete(call.callId)
        pending.add(call.callId)
        for (const stale of pending) {
          if (pending.size <= MAX_PENDING_CALL_IDS) break
          pending.delete(stale)
        }
        return
      }

      const result = readToolResult(event.data)
      if (result === undefined) return
      // Consume the pairing: only a result answering a matched create is read.
      if (!pending.delete(result.callId)) return
      if (result.text === undefined) return
      if (isFailedResult(result.text)) {
        options.note(`aw debate create failed in session "${sessionId}"; no attachment recorded`)
        return
      }
      const debateId = extractDebateId(result.text)
      if (debateId === undefined) {
        options.note(`aw debate create produced no debate_id in session "${sessionId}"; no attachment recorded`)
        return
      }
      void confirmAndRecord(options, sessionId, debateId)
    },
  }
}

/**
 * Confirm a candidate id upstream, then attach it to the emitting Session and
 * its subagent ancestors.
 *
 * A rejected or failed confirmation is a silent miss: the board simply shows the
 * arena without a selection, and nothing reaches the debate flow.
 * @param options - the observer's collaborators.
 * @param sessionId - the Session that ran the create.
 * @param debateId - the id read out of the tool result.
 */
async function confirmAndRecord(
  options: CreateObserverOptions,
  sessionId: string,
  debateId: string,
): Promise<void> {
  try {
    if (!await options.confirm(debateId)) {
      options.note(`debate "${debateId}" was not served by the debate server; no attachment recorded`)
      return
    }
  } catch (error: unknown) {
    options.note(`could not confirm debate "${debateId}": ${String(error)}`)
    return
  }
  const lineage = options.lineageOf(sessionId) ?? { id: sessionId }
  const observedAt = options.now()
  for (const target of attachTargets(lineage, options.lineageOf)) {
    options.registry.record(target, debateId, observedAt)
  }
}
