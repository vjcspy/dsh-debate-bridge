/**
 * The browser half's client for the four fenced reads.
 *
 * Every call goes to the Host's own `/api/dsh-debate/…` paths, never to the
 * debate server directly: the channel's admission (the browser cookie, and a
 * `Host` the deployment trusts) is what makes the read allowed, and the page
 * cannot satisfy it against `127.0.0.1:3456` at all.
 *
 * Decoding is deliberately defensive — these are wire values — but bounded: the
 * fields the board renders are validated, and a row that fails validation is
 * dropped rather than rendered half-built.
 *
 * @module dsh-debate-bridge/client/lib/debate-api
 */
import {
  ARENA_PAGE_LIMIT,
  ATTACH_PATH,
  ATTACH_SESSION_PARAM,
  DETAIL_ID_PARAM,
  DETAIL_PATH,
  LIST_PATH,
  PROVIDER_OUTPUT_PATH,
  PROVIDER_OUTPUT_SINCE_PARAM,
} from '../../config.ts'

/** One debate as the arena list and the detail envelope both report it. */
export interface DebateRow {
  readonly id: string
  readonly title: string
  readonly debateType: string
  readonly state: string
  readonly proposerProvider: string | null
  readonly opponentProvider: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * One entry of a debate's transcript: the motion, or an argument.
 *
 * `type` and `role` stay verbatim wire tokens (`CLAIM`, `proposer`, …): they are
 * the debate machine's own vocabulary, not product copy, and translating them
 * would break the correspondence a Human reads against `debate-web`.
 */
export interface DebateEntry {
  readonly id: string
  readonly type: string
  readonly role: string
  readonly content: string
  readonly seq: number
  readonly createdAt: string
}

/**
 * One entry of the running Opponent harness's own output buffer.
 *
 * A different vocabulary from {@link DebateEntry}: this is the harness's process
 * output, not the debate's argument transcript. `timestamp` is fixed-width
 * millisecond UTC (`new Date().toISOString()`), and `type` is the provider's own
 * token (`terminal`, `status`, `error`). `content` is presentation, never a
 * contract: it may carry ANSI escapes and `\r\n`, and the panel treats anything
 * it does not recognise as plain text.
 */
export interface ProviderOutputEntry {
  readonly timestamp: string
  readonly type: string
  readonly content: string
}

/** One debate's full transcript. */
export interface DebateTranscript {
  readonly debate: DebateRow
  /** The opening motion, or `null` when the debate carries none. */
  readonly motion: DebateEntry | null
  /** Arguments in the order the server reports them. */
  readonly entries: readonly DebateEntry[]
}

/** One page of the arena. */
export interface ArenaPage {
  readonly debates: readonly DebateRow[]
  readonly total: number
}

/** The attachment answer: `null` is the normal "this Session owns no debate". */
export interface AttachmentAnswer {
  readonly debateId: string | null
}

/** Why a read produced no value. */
export type TransportFailureKind =
  /** The request never reached the Host (offline, aborted, DNS). */
  | 'unreachable'
  /** The Host or the debate server answered with a refusal status. */
  | 'refused'
  /** A body arrived but did not carry the fields this half reads. */
  | 'malformed'

/** A failed read. */
export interface TransportFailure {
  readonly kind: TransportFailureKind
  /** HTTP status, or `0` when no response arrived. */
  readonly status: number
  /** Human-readable reason; the debate server's own message when it sent one. */
  readonly message: string
}

/** A read's outcome. */
export type TransportResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: TransportFailure }

/**
 * Report whether a value is a non-null object.
 * @param value - candidate.
 * @returns whether it can be read field by field.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one string field, or `null` when it is absent or not a string.
 * @param record - source object.
 * @param field - field name.
 * @returns the string, or `null`.
 */
function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field]
  return typeof value === 'string' ? value : null
}

/**
 * Decode one debate row.
 * @param value - candidate row.
 * @returns the row, or `undefined` when the fields the board renders are missing.
 */
function decodeDebate(value: unknown): DebateRow | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value, 'id')
  const title = stringField(value, 'title')
  const state = stringField(value, 'state')
  if (id === null || title === null || state === null) return undefined
  return {
    id,
    title,
    state,
    debateType: stringField(value, 'debate_type') ?? '',
    proposerProvider: stringField(value, 'proposer_provider'),
    opponentProvider: stringField(value, 'opponent_provider'),
    createdAt: stringField(value, 'created_at') ?? '',
    updatedAt: stringField(value, 'updated_at') ?? '',
  }
}

/**
 * Decode one transcript entry.
 * @param value - candidate entry.
 * @returns the entry, or `undefined` when it carries no readable identity.
 */
function decodeEntry(value: unknown): DebateEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value, 'id')
  if (id === null) return undefined
  const seq = value['seq']
  return {
    id,
    type: stringField(value, 'type') ?? '',
    role: stringField(value, 'role') ?? '',
    content: stringField(value, 'content') ?? '',
    seq: typeof seq === 'number' && Number.isFinite(seq) ? seq : 0,
    createdAt: stringField(value, 'created_at') ?? '',
  }
}

/**
 * Read one fenced path and decode its envelope.
 *
 * The debate server wraps every answer as `{ success, data }` and every failure
 * as `{ success: false, error: { code, message } }`; a refusal's message is
 * carried through so the board can show the server's own reason.
 *
 * Transport is deliberately separated from shape: `data` comes back as `unknown`
 * and each fetcher validates what it expects. The arena list and the detail read
 * carry an object; the provider-output read carries an ARRAY, which an
 * object-only reader would reject at both runtime and type level.
 * @param path - fenced pathname, query string included.
 * @param signal - abort signal owned by the caller's effect.
 * @returns the undecoded `data` payload, or the failure to report.
 */
async function readEnvelope(path: string, signal: AbortSignal): Promise<TransportResult<unknown>> {
  let response: Response
  try {
    response = await fetch(path, { headers: { accept: 'application/json' }, signal })
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'unreachable', status: 0, message: describe(error) } }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // A body that is not JSON is a failure of the path under test, reported with
    // its status so a proxy page is diagnosable.
    return {
      ok: false,
      failure: { kind: 'malformed', status: response.status, message: `HTTP ${String(response.status)} with no JSON body` },
    }
  }
  if (!response.ok) {
    return { ok: false, failure: { kind: 'refused', status: response.status, message: readErrorMessage(body, response.status) } }
  }
  if (!isRecord(body) || body['success'] !== true || !('data' in body)) {
    return { ok: false, failure: { kind: 'malformed', status: response.status, message: 'the envelope carried no data' } }
  }
  return { ok: true, value: body['data'] }
}

/**
 * Read the server's own error message out of a refusal body.
 * @param body - decoded body, of any shape.
 * @param status - the refusal status.
 * @returns the server's message, or a status-only fallback.
 */
function readErrorMessage(body: unknown, status: number): string {
  if (isRecord(body) && isRecord(body['error'])) {
    const message = stringField(body['error'], 'message')
    if (message !== null) return message
  }
  return `HTTP ${String(status)}`
}

/**
 * Describe a thrown value without assuming it is an `Error`.
 * @param error - the caught value.
 * @returns the value's name and message, or its string form.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Read one page of the arena.
 * @param offset - rows to skip.
 * @param signal - abort signal owned by the caller's effect.
 * @returns the decoded page, or the failure to report.
 */
export async function fetchArena(offset: number, signal: AbortSignal): Promise<TransportResult<ArenaPage>> {
  const query = new URLSearchParams({ limit: String(ARENA_PAGE_LIMIT), offset: String(offset) })
  const envelope = await readEnvelope(`${LIST_PATH}?${query.toString()}`, signal)
  if (!envelope.ok) return envelope
  const data = envelope.value
  if (!isRecord(data)) {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the arena page carried no debates array' } }
  }
  const rows = data['debates']
  if (!Array.isArray(rows)) {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the arena page carried no debates array' } }
  }
  const total = data['total']
  return {
    ok: true,
    value: {
      debates: rows.map(decodeDebate).filter((row): row is DebateRow => row !== undefined),
      total: typeof total === 'number' && Number.isFinite(total) ? total : rows.length,
    },
  }
}

/**
 * Read one debate's transcript.
 * @param debateId - the debate to read.
 * @param signal - abort signal owned by the caller's effect.
 * @returns the decoded transcript, or the failure to report.
 */
export async function fetchDebate(debateId: string, signal: AbortSignal): Promise<TransportResult<DebateTranscript>> {
  const query = new URLSearchParams({ [DETAIL_ID_PARAM]: debateId })
  const envelope = await readEnvelope(`${DETAIL_PATH}?${query.toString()}`, signal)
  if (!envelope.ok) return envelope
  const data = envelope.value
  if (!isRecord(data)) {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the transcript carried no readable debate' } }
  }
  const debate = decodeDebate(data['debate'])
  if (debate === undefined) {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the transcript carried no readable debate' } }
  }
  const rows = data['arguments']
  const entries = Array.isArray(rows)
    ? rows.map(decodeEntry).filter((entry): entry is DebateEntry => entry !== undefined)
    : []
  return {
    ok: true,
    value: { debate, motion: decodeEntry(data['motion']) ?? null, entries },
  }
}

/**
 * Read which debate one Session owns.
 *
 * A Host that never observed a create answers `{ debateId: null }`, which is a
 * success: "this Session owns no debate" is the ordinary state.
 * @param sessionId - the Session to look up.
 * @param signal - abort signal owned by the caller's effect.
 * @returns the attachment, or the failure to report.
 */
export async function fetchAttachment(sessionId: string, signal: AbortSignal): Promise<TransportResult<AttachmentAnswer>> {
  const query = new URLSearchParams({ [ATTACH_SESSION_PARAM]: sessionId })
  const envelope = await readEnvelope(`${ATTACH_PATH}?${query.toString()}`, signal)
  if (!envelope.ok) return envelope
  const data = envelope.value
  if (!isRecord(data)) {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the attachment answer carried no debateId' } }
  }
  const debateId = data['debateId']
  if (debateId !== null && typeof debateId !== 'string') {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the attachment answer carried no debateId' } }
  }
  return { ok: true, value: { debateId } }
}

/**
 * Decode one provider-output entry.
 * @param value - candidate entry.
 * @returns the entry, or `undefined` when it is not the declared shape.
 */
function decodeProviderOutputEntry(value: unknown): ProviderOutputEntry | undefined {
  if (!isRecord(value)) return undefined
  const timestamp = stringField(value, 'timestamp')
  const type = stringField(value, 'type')
  const content = stringField(value, 'content')
  if (timestamp === null || type === null || content === null) return undefined
  return { timestamp, type, content }
}

/**
 * Read the running Opponent's own output buffer.
 *
 * `since` is exclusive upstream and optional here: omitting it asks for the whole
 * buffer, which is what opening a collapsed panel needs. A `400` comes back
 * rather than an empty list when the watermark is malformed — the host refuses
 * such a value instead of forwarding it, precisely so an invalid watermark cannot
 * look like an idle harness.
 *
 * A malformed ROW is dropped while the rest of the array survives, matching this
 * module's tolerance elsewhere: one odd entry must not blank the transcript.
 * @param debateId - the debate whose Opponent is being watched.
 * @param since - watermark to resume from, or `undefined` for the whole buffer.
 * @param signal - abort signal owned by the caller's effect.
 * @returns the decoded entries, or the failure to report.
 */
export async function fetchProviderOutput(
  debateId: string,
  since: string | undefined,
  signal: AbortSignal,
): Promise<TransportResult<readonly ProviderOutputEntry[]>> {
  const query = new URLSearchParams({ [DETAIL_ID_PARAM]: debateId })
  if (since !== undefined) query.set(PROVIDER_OUTPUT_SINCE_PARAM, since)
  const envelope = await readEnvelope(`${PROVIDER_OUTPUT_PATH}?${query.toString()}`, signal)
  if (!envelope.ok) return envelope
  const rows = envelope.value
  if (!Array.isArray(rows)) {
    return { ok: false, failure: { kind: 'malformed', status: 200, message: 'the provider output was not an entry list' } }
  }
  return {
    ok: true,
    value: rows.map(decodeProviderOutputEntry).filter((entry): entry is ProviderOutputEntry => entry !== undefined),
  }
}
