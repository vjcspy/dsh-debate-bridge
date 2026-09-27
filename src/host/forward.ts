/**
 * The fenced reads' policy: path allowlist, upstream URL derivation, the bearer,
 * and the status mapping a caller sees.
 *
 * Everything here is pure, or takes the upstream call as a parameter, so the
 * whole policy is testable without a network: {@link planForward} decides from
 * request facts alone, and {@link forwardToUpstream} uses the `fetch` it is
 * given.
 *
 * Three mappings are explicit rather than inherited from the channel:
 * - an unreachable debate server is `502` with a machine-readable body, never a
 *   `200` carrying nothing, because a Human reading an empty arena would take it
 *   for "no debates" rather than for a server that is down;
 * - a method these read paths do not implement is `405` with `Allow`, not the
 *   channel's `404`, because the path exists and only the verb is wrong;
 * - every upstream status and body is passed through verbatim, so the debate
 *   server's own envelope (`{ success, data }` / `{ success: false, error }`)
 *   reaches the board unaltered.
 *
 * The upstream path is NEVER caller-supplied. One route derives it from a single
 * validated query parameter ({@link DETAIL_PATH}), and the other two use a fixed
 * table entry, so this half cannot be turned into an open proxy.
 *
 * @module dsh-debate-bridge/host/forward
 */
import {
  DETAIL_ID_PARAM,
  DETAIL_PATH,
  LIST_PATH,
  UPSTREAM_DEBATES_PATH,
} from '../config.ts'

/** One row of the allowlist: a fenced pathname and the upstream URL it reaches. */
interface FencedRead {
  /** Exact fenced pathname the channel matched. */
  readonly path: string
  /**
   * Query parameter whose value becomes a path segment upstream, or `undefined`
   * for a route whose upstream path is fixed.
   */
  readonly pathParam: string | undefined
}

/**
 * The two fenced paths that reach the debate server.
 *
 * {@link ATTACH_PATH} is deliberately absent: it is answered from the Host's own
 * attachment registry, so it has no upstream to allowlist.
 */
const FENCED_READS: readonly FencedRead[] = [
  { path: LIST_PATH, pathParam: undefined },
  { path: DETAIL_PATH, pathParam: DETAIL_ID_PARAM },
]

/** The request facts this policy reads. */
export interface ForwardRequest {
  /** Request method, as the channel dispatched it. */
  readonly method: string
  /** Full request URL; its query string is forwarded verbatim on a fixed path. */
  readonly url: string
}

/** One read resolved from a request, ready to forward. */
export interface ForwardPlan {
  /** Absolute upstream URL. */
  readonly upstreamUrl: string
  /** Bearer token to attach, or `undefined` when the deployment configures none. */
  readonly token: string | undefined
}

/** Machine-readable refusal body, shaped like the debate server's own error envelope. */
export interface RefusalPayload {
  readonly success: false
  readonly error: { readonly code: string; readonly message: string }
}

/** A request refused before any upstream call. */
export interface ForwardRefusal {
  /** HTTP status to answer with. */
  readonly status: number
  /** `Allow` header value; present only on a `405`. */
  readonly allow: string | undefined
  readonly payload: RefusalPayload
}

/** What a request resolves to: an upstream call, or a refusal. */
export type ForwardDecision =
  | { readonly ok: true; readonly plan: ForwardPlan }
  | { readonly ok: false; readonly refusal: ForwardRefusal }

/** One upstream call, as the policy issues it. */
export interface UpstreamCall {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

/** Upstream transport; a parameter so the mapping is testable without a network. */
export type UpstreamFetch = (url: string, call: UpstreamCall) => Promise<Response>

/** Facts one forward needs beyond the plan. */
export interface ForwardOptions {
  /** Upstream deadline, in milliseconds. */
  readonly timeoutMs: number
  /** Upstream transport. */
  readonly fetch: UpstreamFetch
}

/**
 * Strip the trailing slashes from a configured debate-server origin.
 * @param baseUrl - configured origin.
 * @returns the origin without a trailing slash, so a derived path is appended once.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * Resolve the bearer token a deployment configured.
 *
 * The config field names an environment variable rather than carrying a token:
 * this repository is public, so a literal secret in a config row would be
 * published. The value is read per request, so a rotation needs no reload.
 * @param authTokenEnv - environment variable name, or the empty string.
 * @param environment - environment to read; defaults to the process environment.
 * @returns the token, or `undefined` when none is configured or the name is unset.
 */
export function resolveAuthToken(
  authTokenEnv: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const name = authTokenEnv.trim()
  if (name === '') return undefined
  const value = environment[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Decide what one request does: which upstream URL it reaches, or why it is refused.
 * @param request - the request facts the policy reads.
 * @param baseUrl - configured debate-server origin.
 * @param token - bearer to attach, or `undefined` for none.
 * @returns the forward plan, or the refusal to answer with.
 */
export function planForward(
  request: ForwardRequest,
  baseUrl: string,
  token: string | undefined,
): ForwardDecision {
  const url = new URL(request.url)
  const entry = FENCED_READS.find(candidate => candidate.path === url.pathname)
  if (entry === undefined) {
    return {
      ok: false,
      refusal: {
        status: 404,
        allow: undefined,
        payload: { success: false, error: { code: 'NOT_FOUND', message: `no fenced read for ${url.pathname}` } },
      },
    }
  }
  if (request.method !== 'GET') {
    return {
      ok: false,
      refusal: {
        status: 405,
        allow: 'GET',
        payload: {
          success: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} is not implemented on ${entry.path}` },
        },
      },
    }
  }
  const origin = normalizeBaseUrl(baseUrl)
  if (entry.pathParam === undefined) {
    // The caller's query string rides through unchanged: the arena list is the
    // debate server's own paginated collection endpoint.
    return { ok: true, plan: { upstreamUrl: `${origin}${UPSTREAM_DEBATES_PATH}${url.search}`, token } }
  }
  const value = url.searchParams.get(entry.pathParam)
  if (value === null || value.trim() === '') {
    return {
      ok: false,
      refusal: {
        status: 400,
        allow: undefined,
        payload: {
          success: false,
          error: { code: 'INVALID_INPUT', message: `${entry.path} requires a non-blank ${entry.pathParam} parameter` },
        },
      },
    }
  }
  // The id becomes one ENCODED path segment, so no value can add a segment or a
  // query string of its own.
  return {
    ok: true,
    plan: { upstreamUrl: `${origin}${UPSTREAM_DEBATES_PATH}/${encodeURIComponent(value.trim())}`, token },
  }
}

/**
 * Answer a refusal.
 * @param refusal - the refusal {@link planForward} resolved.
 * @returns the response to write, with `Allow` present exactly on a `405`.
 */
export function refusalResponse(refusal: ForwardRefusal): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (refusal.allow !== undefined) headers.allow = refusal.allow
  return new Response(JSON.stringify(refusal.payload), { status: refusal.status, headers })
}

/**
 * Call the debate server and map the outcome onto a response.
 * @param plan - the forward plan.
 * @param options - upstream deadline and transport.
 * @returns the upstream status and body passed through, or a `502` naming the failure.
 */
export async function forwardToUpstream(plan: ForwardPlan, options: ForwardOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (plan.token !== undefined) headers.authorization = `Bearer ${plan.token}`
  try {
    const upstream = await options.fetch(plan.upstreamUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (error: unknown) {
    return new Response(JSON.stringify({
      success: false,
      error: {
        code: 'UPSTREAM_UNREACHABLE',
        message: `the debate server did not answer GET ${plan.upstreamUrl}: ${describe(error)}`,
      },
    }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

/** Facts the upstream confirmation needs. */
export interface ConfirmOptions {
  /** Debate-server origin. */
  readonly baseUrl: string
  /** Upstream deadline, in milliseconds. */
  readonly timeoutMs: number
  /** Bearer to attach, or `undefined` when the deployment configures none. */
  readonly token: string | undefined
  /** Upstream transport. */
  readonly fetch: UpstreamFetch
}

/**
 * Build the confirmation an observed create must pass before it is recorded.
 *
 * A `debate_id` found in tool output is a CLAIM: the command may have printed a
 * payload for a debate the server never accepted, and a stale or hand-typed id
 * reaches the same text. The board selects a debate only after the server
 * confirms it serves that id, so a false positive degrades to no selection
 * rather than to an empty board that looks like a data loss.
 * @param options - origin, deadline, bearer and transport.
 * @returns a predicate that resolves whether the debate server serves an id.
 */
export function createDebateConfirmer(options: ConfirmOptions): (debateId: string) => Promise<boolean> {
  const origin = normalizeBaseUrl(options.baseUrl)
  return async (debateId) => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
    try {
      const response = await options.fetch(
        `${origin}${UPSTREAM_DEBATES_PATH}/${encodeURIComponent(debateId)}`,
        { method: 'GET', headers, signal: AbortSignal.timeout(options.timeoutMs) },
      )
      if (!response.ok) return false
      const body: unknown = await response.json()
      return typeof body === 'object' && body !== null && (body as { success?: unknown }).success === true
    } catch {
      // An unconfirmed id is a silent miss by design; the caller logs at debug.
      return false
    }
  }
}

/**
 * Describe a thrown value without assuming it is an `Error`.
 * @param error - the caught value.
 * @returns the value's name and message, or its string form.
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
