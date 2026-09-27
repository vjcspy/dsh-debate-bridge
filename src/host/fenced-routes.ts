/**
 * Registration of the three fenced reads on the shared `/api` channel.
 *
 * The channel — not this plugin — owns admission: `connection.admit` runs in the
 * `/api` prefix handler before any route lookup, so a foreign `Host` is refused
 * with `403` and a request without the browser cookie with `401`, whether or not
 * the fenced path exists. Registering through `ctx.connection.fetch.register` is
 * therefore what fences these reads; a raw `ctx.webServer.register` route would
 * receive no admission at all and would publish the debate server through the
 * deployment's tunnel.
 *
 * The READ policy itself lives in `host/forward.ts`; this module is only the
 * wiring, and it is kept separate so the policy stays unit-testable without a
 * Cordis context.
 *
 * Each registration is an effect of this context, so plugin teardown removes the
 * routes even on a hot unload.
 *
 * @module dsh-debate-bridge/host/fenced-routes
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

import {
  ATTACH_PATH,
  ATTACH_SESSION_PARAM,
  DETAIL_PATH,
  LIST_PATH,
} from '../config.ts'
import { MAX_SESSION_ID_CHARS } from '../request.ts'
import type { AttachRegistry } from './attach-registry.ts'
import { forwardToUpstream, planForward, refusalResponse, type UpstreamFetch } from './forward.ts'

/**
 * Methods registered on every fenced read.
 *
 * The channel matches a pathname first and a method second, so both channel
 * verbs are declared: the handler then answers the verb it does not implement
 * with `405` plus `Allow`, instead of the channel's blanket `404`, which would
 * claim the path does not exist.
 */
export const CHANNEL_METHODS: readonly ('GET' | 'POST')[] = ['GET', 'POST']

/** Upstream transport: the host's global `fetch`, with the Node `Response` it returns. */
const upstreamFetch: UpstreamFetch = async (url, call) => await fetch(url, {
  method: call.method,
  headers: { ...call.headers },
  signal: call.signal,
})

/** Host-configurable facts one registration needs. */
export interface FencedRouteOptions {
  /** Debate-server origin every forwarded read reaches. */
  readonly baseUrl: string
  /** Upstream deadline per forwarded request, in milliseconds. */
  readonly timeoutMs: number
  /** Bearer to attach, or `undefined` when the deployment configures none. */
  readonly token: string | undefined
  /** The Session → debate attachment store the attach read answers from. */
  readonly registry: AttachRegistry
}

/**
 * Build the route that forwards one fenced read to the debate server.
 * @param path - the exact fenced pathname.
 * @param options - origin, deadline and bearer.
 * @returns the route to register.
 */
function forwardRoute(path: string, options: FencedRouteOptions): ConnectionFetchRoute {
  return {
    path,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      const decision = planForward(
        { method: request.method, url: request.url },
        options.baseUrl,
        options.token,
      )
      if (!decision.ok) return refusalResponse(decision.refusal)
      return await forwardToUpstream(decision.plan, { timeoutMs: options.timeoutMs, fetch: upstreamFetch })
    },
  }
}

/**
 * Build the route that answers a Session's attachment from the host registry.
 *
 * A Session with no attachment is the normal state, not an error: the board
 * shows the arena with no selection, so the answer is always `200` with a `null`
 * `debateId` rather than a `404` the client would have to treat as expected.
 * @param options - the registry the read answers from.
 * @returns the route to register.
 */
function attachRoute(options: FencedRouteOptions): ConnectionFetchRoute {
  return {
    path: ATTACH_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') {
        return refusalResponse({
          status: 405,
          allow: 'GET',
          payload: {
            success: false,
            error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} is not implemented on ${ATTACH_PATH}` },
          },
        })
      }
      const sessionId = new URL(request.url).searchParams.get(ATTACH_SESSION_PARAM)
      if (sessionId === null || sessionId.trim() === '' || sessionId.length > MAX_SESSION_ID_CHARS) {
        return refusalResponse({
          status: 400,
          allow: undefined,
          payload: {
            success: false,
            error: {
              code: 'INVALID_INPUT',
              message: `${ATTACH_PATH} requires a non-blank ${ATTACH_SESSION_PARAM} parameter of at most ${MAX_SESSION_ID_CHARS} characters`,
            },
          },
        })
      }
      const attachment = options.registry.read(sessionId.trim())
      return new Response(JSON.stringify({
        success: true,
        data: {
          sessionId: sessionId.trim(),
          debateId: attachment?.debateId ?? null,
          observedAt: attachment?.observedAt ?? null,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    },
  }
}

/**
 * Register every fenced read this plugin publishes.
 * @param ctx - Host context owning the `connection` service.
 * @param options - origin, deadline, bearer and attachment registry.
 */
export function registerFencedRoutes(ctx: Context, options: FencedRouteOptions): void {
  for (const route of [
    forwardRoute(LIST_PATH, options),
    forwardRoute(DETAIL_PATH, options),
    attachRoute(options),
  ]) {
    ctx.effect(() => {
      // `register` already owns the route on this context's fiber; the extra
      // effect states that ownership where the channel's own teardown runs, so a
      // plugin unload cannot leave a route behind.
      const dispose = ctx.connection.fetch.register(route)
      return () => { void dispose() }
    }, `dsh-debate-bridge: ${route.path}`)
  }
}
