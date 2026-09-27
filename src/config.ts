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
 * same three paths — a second table would drift.
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
 * Fenced path answering the Session → debate attachment.
 *
 * Served from the Host's own in-memory registry, never forwarded: the
 * attachment is established by observing this host's Sessions, which no upstream
 * knows about.
 */
export const ATTACH_PATH = `${FENCED_PREFIX}/attach`

/**
 * Query parameter carrying the debate id on {@link DETAIL_PATH}.
 *
 * `ConnectionFetchRoute.path` is an exact string, so the id travels as a query
 * parameter and the Host folds it into the upstream path; nothing the caller
 * sends is ever used to spell an upstream path beyond this one validated value.
 */
export const DETAIL_ID_PARAM = 'id'

/** Query parameter carrying the Session id on {@link ATTACH_PATH}. */
export const ATTACH_SESSION_PARAM = 'sessionId'

/** Upstream collection the arena list reads. */
export const UPSTREAM_DEBATES_PATH = '/debates'

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
