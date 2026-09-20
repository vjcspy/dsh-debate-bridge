/**
 * Pure request validation and identity derivation for the debate bridge.
 *
 * This module imports NOTHING from the harness, on purpose: every rule the
 * bridge enforces on a request body is decided here, so `test/unit` runs in
 * milliseconds and independently of the harness build. Anything that needs a
 * live service (preset existence, workspace existence, session creation) stays
 * out — see `session.ts` and `index.ts`.
 *
 * @module dsh-debate-bridge/request
 */

/** Prefix of every session id this plugin mints, so a session is self-describing. */
export const SESSION_ID_PREFIX = 'dsh-debate-'

/** Longest accepted `debateId`. */
export const MAX_DEBATE_ID_CHARS = 128

/** Longest accepted `sessionId` supplied by a caller. */
export const MAX_SESSION_ID_CHARS = 256

/** Longest retained `title`, in characters. */
export const MAX_TITLE_CHARS = 120

/** Longest accepted raw `title` on the wire, before {@link buildSessionTitle} truncates it. */
export const MAX_TITLE_INPUT_CHARS = 4096

/** Longest accepted `prompt`, in characters. */
export const MAX_PROMPT_CHARS = 64 * 1024

/** Longest accepted `workspacePath`, in characters. */
export const MAX_PATH_CHARS = 4096

/** Longest accepted `model` route, in characters. */
export const MAX_MODEL_CHARS = 256

/**
 * Shape of one identifier that becomes a session id AND a directory name in the
 * session store. Anchoring the first character at an alphanumeric rejects `.`,
 * `..` and any leading separator, so no traversal spelling can survive
 * validation; the remaining set excludes `/`, `\` and whitespace.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** A validated `POST /dsh-debate/opponent` body. */
export interface StartRequest {
  /** Debate this Opponent turn belongs to. */
  readonly debateId: string
  /**
   * Session identity to target when the caller already persisted one. Omitted
   * (the normal case) targets the deterministic `dsh-debate-<debateId>`.
   */
  readonly sessionId?: string
  /** Session title. Non-blank; bounded to {@link MAX_TITLE_CHARS}. */
  readonly title: string
  /** First user turn / nudge text. Non-blank; bounded to {@link MAX_PROMPT_CHARS}. */
  readonly prompt: string
  /** Model route for the session; omitted means the agent preset / host default. */
  readonly model?: string
  /** Agent preset name, or `''` for the host default. Existence is checked live. */
  readonly agentPreset: string
  /** Permission preset name, or `''` for the host default. Existence is checked live. */
  readonly permissionPreset: string
  /** Absolute directory the session belongs to. */
  readonly workspacePath: string
}

/** A validated `POST /dsh-debate/opponent/stop` body. */
export interface StopRequest {
  /** Exact live session to cancel. */
  readonly sessionId: string
}

/** A validated `POST /dsh-debate/opponent/status` body. */
export interface StatusRequest {
  /** Exact session to report on. */
  readonly sessionId: string
}

/** Outcome of validating one request body: a value, or one machine-readable reason. */
export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

/**
 * Parse a request body as a JSON object.
 *
 * Kept pure — and kept here — because "not an object" is a validation failure
 * exactly like "field has the wrong type", and the route must answer both with
 * the same 4xx `{ error }` body.
 * @param text - the decoded request body.
 * @returns the object, or `undefined` when the text is not a JSON object.
 */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // A non-JSON body is exactly the undefined case; the caller owns the 4xx.
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

/**
 * Read one optional bounded string field.
 * @param record - the request object.
 * @param field - field name.
 * @param max - inclusive character ceiling.
 * @returns the trimmed value, `undefined` when the field is absent or `null`,
 *   or an error message when present but not a usable string.
 */
function optionalString(
  record: Record<string, unknown>,
  field: string,
  max: number,
): { readonly value: string | undefined } | { readonly error: string } {
  const raw = record[field]
  if (raw === undefined || raw === null) return { value: undefined }
  if (typeof raw !== 'string') return { error: `${field} must be a string` }
  if (raw.length > max) return { error: `${field} must be at most ${max} characters` }
  return { value: raw }
}

/**
 * Read one required, non-blank, bounded string field.
 * @param record - the request object.
 * @param field - field name.
 * @param max - inclusive character ceiling.
 * @returns the trimmed value, or an error message.
 */
function requiredString(
  record: Record<string, unknown>,
  field: string,
  max: number,
): { readonly value: string } | { readonly error: string } {
  const raw = record[field]
  if (raw === undefined || raw === null) return { error: `${field} is required` }
  if (typeof raw !== 'string') return { error: `${field} must be a string` }
  if (raw.length > max) return { error: `${field} must be at most ${max} characters` }
  if (raw.trim() === '') return { error: `${field} must not be blank` }
  return { value: raw.trim() }
}

/**
 * Read one optional identifier field and check it against {@link ID_PATTERN}.
 * @param record - the request object.
 * @param field - field name.
 * @param max - inclusive character ceiling.
 * @returns the value, `undefined` when absent, or an error message.
 */
function optionalId(
  record: Record<string, unknown>,
  field: string,
  max: number,
): { readonly value: string | undefined } | { readonly error: string } {
  const read = optionalString(record, field, max)
  if ('error' in read) return read
  if (read.value === undefined) return { value: undefined }
  if (!ID_PATTERN.test(read.value)) {
    return { error: `${field} must match ${String(ID_PATTERN)}` }
  }
  return { value: read.value }
}

/**
 * Derive the deterministic session id for one debate.
 *
 * Determinism is the whole idempotency story: a repeated start for a live debate
 * resolves to the same session, so the route adopts instead of duplicating.
 * @param debateId - validated debate identity.
 * @returns the `dsh-debate-<debateId>` session id.
 */
export function deriveSessionId(debateId: string): string {
  return `${SESSION_ID_PREFIX}${debateId}`
}

/**
 * Normalize the session title: collapse internal whitespace runs and truncate
 * at {@link MAX_TITLE_CHARS}, ellipsized when cut — the same convention
 * `boundContextSummary` uses for its one-line rows.
 * @param title - raw, already-validated non-blank title.
 * @returns the title as it will be persisted.
 */
export function buildSessionTitle(title: string): string {
  const collapsed = title.trim().replace(/\s+/gu, ' ')
  if (collapsed.length <= MAX_TITLE_CHARS) return collapsed
  return `${collapsed.slice(0, MAX_TITLE_CHARS - 1)}…`
}

/**
 * Validate a `POST /dsh-debate/opponent` body.
 *
 * Shape only. `agentPreset` / `permissionPreset` are accepted as names here and
 * resolved against the live registries by the route, because a name is unknown
 * only relative to a running host.
 * @param body - the parsed request object.
 * @returns the validated request, or one machine-readable reason.
 */
export function parseStartRequest(body: Record<string, unknown>): Parsed<StartRequest> {
  const debateId = requiredString(body, 'debateId', MAX_DEBATE_ID_CHARS)
  if ('error' in debateId) return { ok: false, error: debateId.error }
  if (!ID_PATTERN.test(debateId.value)) {
    return { ok: false, error: `debateId must match ${String(ID_PATTERN)}` }
  }

  const title = requiredString(body, 'title', MAX_TITLE_INPUT_CHARS)
  if ('error' in title) return { ok: false, error: title.error }

  const prompt = requiredString(body, 'prompt', MAX_PROMPT_CHARS)
  if ('error' in prompt) return { ok: false, error: prompt.error }

  const workspacePath = requiredString(body, 'workspacePath', MAX_PATH_CHARS)
  if ('error' in workspacePath) return { ok: false, error: workspacePath.error }

  // Absent means "host default"; a present-but-non-string value is a mistake
  // and must not silently read as the default.
  const agentPreset = optionalString(body, 'agentPreset', MAX_DEBATE_ID_CHARS)
  if ('error' in agentPreset) return { ok: false, error: agentPreset.error }
  const permissionPreset = optionalString(body, 'permissionPreset', MAX_DEBATE_ID_CHARS)
  if ('error' in permissionPreset) return { ok: false, error: permissionPreset.error }

  const sessionId = optionalId(body, 'sessionId', MAX_SESSION_ID_CHARS)
  if ('error' in sessionId) return { ok: false, error: sessionId.error }

  const model = optionalString(body, 'model', MAX_MODEL_CHARS)
  if ('error' in model) return { ok: false, error: model.error }
  if (model.value !== undefined && model.value.trim() === '') {
    return { ok: false, error: 'model must not be blank when present' }
  }

  return {
    ok: true,
    value: {
      debateId: debateId.value,
      ...sessionId.value === undefined ? {} : { sessionId: sessionId.value },
      title: title.value,
      prompt: prompt.value,
      ...model.value === undefined ? {} : { model: model.value.trim() },
      agentPreset: (agentPreset.value ?? '').trim(),
      permissionPreset: (permissionPreset.value ?? '').trim(),
      workspacePath: workspacePath.value,
    },
  }
}

/**
 * Validate a `POST /dsh-debate/opponent/stop` body.
 * @param body - the parsed request object.
 * @returns the validated request, or one machine-readable reason.
 */
export function parseStopRequest(body: Record<string, unknown>): Parsed<StopRequest> {
  const sessionId = requiredString(body, 'sessionId', MAX_SESSION_ID_CHARS)
  if ('error' in sessionId) return { ok: false, error: sessionId.error }
  if (!ID_PATTERN.test(sessionId.value)) {
    return { ok: false, error: `sessionId must match ${String(ID_PATTERN)}` }
  }
  return { ok: true, value: { sessionId: sessionId.value } }
}

/**
 * Validate a `POST /dsh-debate/opponent/status` body.
 * @param body - the parsed request object.
 * @returns the validated request, or one machine-readable reason.
 */
export function parseStatusRequest(body: Record<string, unknown>): Parsed<StatusRequest> {
  const sessionId = requiredString(body, 'sessionId', MAX_SESSION_ID_CHARS)
  if ('error' in sessionId) return { ok: false, error: sessionId.error }
  if (!ID_PATTERN.test(sessionId.value)) {
    return { ok: false, error: `sessionId must match ${String(ID_PATTERN)}` }
  }
  return { ok: true, value: { sessionId: sessionId.value } }
}
