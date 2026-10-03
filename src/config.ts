/**
 * Constants shared by the Host half and the browser half.
 *
 * This module is deliberately dependency-free apart from the pure session-id
 * convention in `./request.ts`: the browser bundle imports it, so anything added
 * here ships to the page. The Host-only schema that validates operator
 * configuration lives in `./schema.ts`; it builds on the bounds declared here.
 *
 * The route table has ONE home. The Host registers an exact Fetch route per
 * fenced path below and forwards it upstream, and the browser half addresses the
 * same four paths — a second table would drift.
 *
 * @module dsh-debate-bridge/config
 */

export { SESSION_ID_PREFIX, deriveSessionId } from './request.ts'

/** Package id: the Loader registration id, the tab kind's implementation id, and the body's slot key. */
export const PLUGIN_ID = 'dsh-debate-bridge'

/** Right-sidebar tab kind this plugin owns. */
export const TAB_KIND = 'dsh-debate-arena'

/** Guide-page entry identity contributed by the tab kind; unique within this provider. */
export const GUIDE_ENTRY_ID = 'dsh-debate-arena'

/** Ascending position of the guide entry among every registered type's entries. */
export const GUIDE_ENTRY_ORDER = 45

/** Locale namespace owning every product-visible string this plugin renders. */
export const LOCALE_NAMESPACE = 'dshDebateArena'

/** Route prefix below `/api`; every fenced path this plugin registers sits under it. */
export const FENCED_PREFIX = '/api/dsh-debate'

/** Fenced path answering the arena list. Forwards to {@link UPSTREAM_DEBATES_PATH}. */
export const LIST_PATH = `${FENCED_PREFIX}/debates`

/** Fenced path answering one debate's transcript. Forwards to `/debates/<id>`. */
export const DETAIL_PATH = `${FENCED_PREFIX}/debate`

/**
 * Fenced path answering the running Opponent harness's own output buffer.
 *
 * Forwards to `/debates/<id>/provider/output` — the same buffer `debate-web`
 * renders in the terminal at the bottom of its debate conversation. It is the
 * fourth fenced read and the only one that carries more than one caller value.
 */
export const PROVIDER_OUTPUT_PATH = `${FENCED_PREFIX}/provider-output`

/**
 * Fenced path answering the Session → debate attachment.
 *
 * Served from the Host's own in-memory registry, never forwarded: the
 * attachment is established by observing this host's Sessions, which no upstream
 * knows about.
 */
export const ATTACH_PATH = `${FENCED_PREFIX}/attach`

/**
 * Query parameter carrying the debate id on {@link DETAIL_PATH} and
 * {@link PROVIDER_OUTPUT_PATH}.
 *
 * `ConnectionFetchRoute.path` is an exact string, so the id travels as a query
 * parameter and the Host folds it into the upstream path; nothing the caller
 * sends is ever used to spell an upstream path beyond this one validated value.
 */
export const DETAIL_ID_PARAM = 'id'

/**
 * Query parameter carrying the exclusive watermark on {@link PROVIDER_OUTPUT_PATH}.
 *
 * Optional: absent means "the whole buffer", which is exactly what opening a
 * collapsed panel asks for.
 */
export const PROVIDER_OUTPUT_SINCE_PARAM = 'since'

/** Query parameter carrying the Session id on {@link ATTACH_PATH}. */
export const ATTACH_SESSION_PARAM = 'sessionId'

/** Upstream collection the arena list reads. */
export const UPSTREAM_DEBATES_PATH = '/debates'

/**
 * Upstream suffix appended after the `/debates/<id>` segment on
 * {@link PROVIDER_OUTPUT_PATH}.
 */
export const UPSTREAM_PROVIDER_OUTPUT_SUFFIX = '/provider/output'

/**
 * The exact shape a debate id must have before it reaches an upstream path.
 *
 * ANCHORED and case-insensitive. Anchoring is what stops a partial match from
 * smuggling a path segment: an unanchored pattern would accept a value whose
 * leading characters merely look like a UUID. Every accepted value is exactly a
 * UUID — no `.`, no `/`, no `?` — so the dot-segment escape measured against the
 * old non-blank check (`encodeURIComponent('..') === '..'`, which resolves
 * `http://host/debates/..` to the origin root) is unreachable by construction
 * and needs no separate rule. Case-insensitive because a UUID's hex digits carry
 * no case meaning: an upper-cased id names the same debate.
 */
export const DEBATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The exact shape the watermark on {@link PROVIDER_OUTPUT_PATH} must have.
 *
 * Deliberately NOT generic ISO-8601. The debate server compares timestamps as
 * raw strings (`entries.filter((e) => e.timestamp > since)`) and every entry's
 * timestamp comes from `new Date().toISOString()` — fixed-width millisecond UTC.
 * An ISO value without milliseconds compares GREATER than every entry of that
 * second, because `'.' < 'Z'`, so accepting one would trade a loud `400` for a
 * silently empty transcript.
 */
export const PROVIDER_OUTPUT_SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Opponent providers whose provider-output buffer this plugin renders.
 *
 * ONE constant, because it is the single widening point: `codex-cli` and
 * `opencode-cli` emit the same entry shape and are a one-word change here. The
 * value is a PROVIDER name, not a proposer harness token — `claudecode` is the
 * latter and never appears in `opponent_provider`, so a gate written against it
 * could never match. It approximates `debate-web`'s own capability gate
 * (`observability === 'terminal'`), narrowed to Claude Code on purpose.
 */
export const TRANSCRIPT_PROVIDER_ALLOWLIST: readonly string[] = ['claude-cli']

/**
 * How often the browser half re-reads the Opponent's output while the panel is
 * open, in milliseconds.
 *
 * Tighter than the board's own poll because the panel is opt-in, short-lived and
 * collapsed by default: while it is closed it costs nothing at all.
 */
export const TRANSCRIPT_POLL_INTERVAL_MS = 1500

/**
 * Milliseconds subtracted from the newest seen timestamp to build the watermark.
 *
 * The server's filter is a strict `>`, so a watermark equal to the newest
 * timestamp drops every sibling entry sharing that millisecond — measured on a
 * real run: four entries shared one millisecond, and `?since=<that timestamp>`
 * returned 20 of the 24 entries visible at or after it. One millisecond of
 * re-fetch is cheaper than losing text.
 */
export const TRANSCRIPT_SINCE_BACKOFF_MS = 1

/**
 * Ceiling on retained transcript lines.
 *
 * The buffer is a view, not a log: the panel shows the newest output, and the
 * oldest lines are dropped once this bound is reached.
 */
export const TRANSCRIPT_MAX_LINES = 1000

/**
 * Per-ENTRY character budget, applied before any line cap.
 *
 * A global line cap alone is not enough: tool results are emitted untruncated,
 * and one measured entry carried 38,771 characters across 451 newlines — a
 * line-capped buffer would evict all model prose after a few file reads. Each
 * entry is clamped head-and-tail to this budget first, and the global line cap
 * then applies to what survives.
 */
export const TRANSCRIPT_ENTRY_MAX_CHARS = 4000

/**
 * Marker standing where an over-budget entry was clamped head-and-tail.
 *
 * A single visible character, so the clamp neither hides the loss nor invents
 * structure, and plain text because the panel renders every entry as text.
 */
export const TRANSCRIPT_ENTRY_ELISION = '…'

/** Debate-server origin applied when configuration names none. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3456'

/** Upstream deadline applied when configuration names none, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 8000

/** Shortest accepted upstream deadline, in milliseconds. */
export const REQUEST_TIMEOUT_MS_MIN = 100

/** Longest accepted upstream deadline, in milliseconds. */
export const REQUEST_TIMEOUT_MS_MAX = 600_000

/**
 * How often the browser half re-reads the attachment for the mounted Session,
 * in milliseconds.
 *
 * A poll rather than a push because the attachment is established by the Host
 * observing a tool result, and the tab body may be closed and therefore
 * subscribed to nothing; the read is an in-memory `Map` lookup.
 */
export const ATTACH_POLL_INTERVAL_MS = 2500

/**
 * Deadline for one attachment read from the browser half, in milliseconds.
 *
 * Shorter than the poll interval's tolerance is not required, but a read that
 * never settles must not stop the watcher from observing later reads.
 */
export const ATTACH_READ_TIMEOUT_MS = 5000

/** How often the browser half re-reads the selected debate's transcript while its tab is visible. */
export const DETAIL_POLL_INTERVAL_MS = 3000

/** Debates requested per arena page. */
export const ARENA_PAGE_LIMIT = 25

/**
 * Ceiling on remembered `tool/call` ids awaiting their result.
 *
 * The set exists only to prove that a `tool/result` answers a matched
 * `aw debate create` call. A Session that never produced a result would
 * otherwise grow it without bound; entries are also dropped when consumed.
 */
export const MAX_PENDING_CALL_IDS = 256
