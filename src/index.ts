/**
 * dsh-debate-bridge: the loopback HTTP bridge that runs the debate Opponent as
 * a live Session inside the already-running `dsh web` host.
 *
 * Three `exact` routes, all OUTSIDE `/api` so no cookie or Origin fence
 * applies — the trust fence is applied per-channel in `HostConnectionService`
 * and the mux upgrade (`packages/client/connection/src/rpc-host.ts:97-100`,
 * `packages/api/gateway/src/index.ts:215`), not globally:
 *
 *   `POST /dsh-debate/opponent`         → `{ sessionId }`
 *   `POST /dsh-debate/opponent/stop`    → `{ stopped }`
 *   `POST /dsh-debate/opponent/status`  → `{ live, idle, lastActivityAt }`
 *   `GET  /dsh-debate/models`           → `{ models, failures }`
 *
 * **The loopback self-check is load-bearing.** `ctx.webServer` accepts
 * `host: '0.0.0.0'` as a first-class config value
 * (`packages/host/webserver/src/index.ts:61,294`); the refusal lives one layer
 * up, in the `web-app` CLI's argument parsing
 * (`packages/bundle/web-app/src/startup.ts:74-75`), whose own error text names
 * the risk ("it would expose remote code execution to the network"). These
 * routes accept an arbitrary `prompt`, an arbitrary `workspacePath` and a
 * `danger-full-access` preset, i.e. exactly that risk, so this plugin refuses
 * to register unless the RESOLVED host is loopback. That converts an inherited
 * assumption into a local invariant.
 *
 * @module dsh-debate-bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: these declare the `webServer`, `agents`,
// `agentDefaultModel`, `workspaceRegistry`, `permissionPresets`, `sessionTitle`
// and `agentPresets` members this module reads.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { createRouteHost, listProviderModels } from './models.ts'
import {
  parseJsonObject,
  parseStartRequest,
  parseStatusRequest,
  parseStopRequest,
  type StartRequest,
} from './request.ts'
import { createDebateSessions, resolveModelRoute, type SessionStatus } from './session.ts'

export const name = 'dsh-debate-bridge'

/**
 * Services this plugin cannot function without.
 *
 * `agentDefaultModel` is required rather than optional: it is the ONLY source of
 * a complete `provider` + `model` route for a request that does not spell one,
 * and creating a session without a route produces a green 200 followed by a
 * session whose every turn dies (`agent "<id>" has no provider/model`). Refusing
 * to activate without it is a loud failure in place of that silent one.
 *
 * `agentPresets` is required for the same fail-loud reason: the `setup` step
 * (`ctx.agentPresets.mount`, see `src/session.ts`) is what joins the session
 * to its tool/AGENTS.md/persona composition, and without it the bridge would
 * mint a healthy-looking session whose Opponent can never act. A composition
 * that mounts no agent presets must not mount this bridge either, because such
 * a host cannot produce a Web-UI-equivalent session at all.
 *
 * `llm` IS required, and that is forced by the Cordis access guard rather than by
 * preference: the models verb hands `ctx` to `buildModelCatalog`, which
 * dereferences `ctx.llm.listProviders()` / `.listModels()` / `.resolveModelInfo()`
 * (and `ctx.agentDefaultModel`), and the context proxy refuses any property whose
 * service is not injected — measured on a real `web`-profile boot as
 * `cannot get property "llm" without inject`. An UNGUARDED read
 * (`ctx.reflect.get('llm', false)`) yields the service object, but the forwarded
 * access still trips the guard, so no optional-read trick can substitute. The
 * consequence is intended and explicit: a composition that mounts no LLM service
 * must not mount this bridge, because such a host can neither enumerate model
 * routes nor create a runnable session. The `web` profile mounts
 * `@deepseek-ai/dsh-llm`.
 */
export const inject = ['webServer', 'agents', 'workspaceRegistry', 'permissionPresets', 'sessionTitle', 'agentDefaultModel', 'agentPresets', 'llm']

/** The only bind host on which these routes may be registered. */
export const LOOPBACK_HOST = '127.0.0.1'

/** Exact path of the open/adopt verb. */
export const OPEN_ROUTE = '/dsh-debate/opponent'

/** Exact path of the stop verb. */
export const STOP_ROUTE = '/dsh-debate/opponent/stop'

/** Exact path of the status verb. */
export const STATUS_ROUTE = '/dsh-debate/opponent/status'

/**
 * Exact path of the model-catalog verb.
 *
 * A GET, unlike the three verbs above: it is a read with no body and no
 * session-scoped effect, and it is the only route the debate server polls while an
 * operator edits Settings. `GET /dsh-debate/opponent/models` would read as a
 * per-session verb, which it is not.
 */
export const MODELS_ROUTE = '/dsh-debate/models'

/**
 * Request-body ceiling. A body past it is refused after draining, never
 * buffered further, so an unbounded prompt cannot grow host memory.
 */
export const MAX_BODY_BYTES = 64 * 1024

/** Write one JSON response and end the exchange. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.end(text)
}

/** Refuse a method, naming the one route verbs accept. */
function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param req - the incoming request.
 * @returns the decoded text, or `null` past {@link MAX_BODY_BYTES} (stream drained).
 */
async function readBoundedBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** One request's resolved preset names. */
interface ResolvedPresets {
  /** Canonical agent-preset id, ALWAYS concrete (empty wire value resolves the host default). */
  readonly agentPresetId: string
  /** Permission preset to apply; never blank, so `set` is always called. */
  readonly permissionPreset: string
}

/**
 * Resolve both preset names against the live registries, fail-closed.
 *
 * An unknown name is refused rather than silently ignored: the sibling defect
 * class this guards is a green-looking session that quietly ran on a default.
 *
 * The agent preset ALWAYS resolves to a concrete id — `''` on the wire means
 * "host default" and is resolved via `agentPresets.resolve(undefined)`,
 * exactly like the Web UI's `composeAgent`
 * (`packages/api/session-controller/src/agent.ts:389`). The resolved id is
 * then carried in `meta.agentPreset` AND joined in `setup` (`src/session.ts`),
 * which together are what make the session Web-UI-equivalent. Returning
 * `undefined` here would publish the agent on the empty global layer.
 * @param ctx - host context.
 * @param request - validated request.
 * @returns the resolved names, or one machine-readable reason.
 */
async function resolvePresets(
  ctx: Context,
  request: StartRequest,
): Promise<{ readonly ok: true; readonly value: ResolvedPresets } | { readonly ok: false; readonly error: string }> {
  // `''` means "host default", resolved to a CONCRETE name so the mandated
  // `permissionPresets.set` step still runs: an explicitly applied default is
  // observable, an omitted one is not.
  const permissionPreset = request.permissionPreset === ''
    ? ctx.permissionPresets.defaultPreset
    : request.permissionPreset
  try {
    ctx.permissionPresets.resolve(permissionPreset)
  } catch (error: unknown) {
    return { ok: false, error: `unknown permissionPreset: ${errorChain(error)}` }
  }

  try {
    // `resolve` throws on an unknown id and reports a failed activation as
    // `broken`; `setup` mounts the preset, so no standing scope is taken here
    // (DSH 0.1.7 removed `standingKeyFor`).
    const preset = await ctx.agentPresets.resolve(
      request.agentPreset === '' ? undefined : request.agentPreset,
    )
    if (preset.broken !== undefined) {
      return { ok: false, error: `unknown agentPreset: ${preset.id} is broken: ${JSON.stringify(preset.broken)}` }
    }
    return { ok: true, value: { agentPresetId: preset.id, permissionPreset } }
  } catch (error: unknown) {
    return { ok: false, error: `unknown agentPreset: ${errorChain(error)}` }
  }
}

/**
 * Read and validate one JSON body, answering the exchange on any failure.
 * @param req - the incoming request.
 * @param res - the response being written.
 * @param parse - the verb's pure validator.
 * @returns the validated value, or `undefined` when a refusal was already sent.
 */
async function readValidated<T>(
  req: IncomingMessage,
  res: ServerResponse,
  parse: (body: Record<string, unknown>) => { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string },
): Promise<T | undefined> {
  const text = await readBoundedBody(req)
  if (text === null) {
    sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` })
    return undefined
  }
  const body = parseJsonObject(text)
  if (body === undefined) {
    sendJson(res, 400, { error: 'request body must be a JSON object' })
    return undefined
  }
  const parsed = parse(body)
  if (!parsed.ok) {
    sendJson(res, 400, { error: parsed.error })
    return undefined
  }
  return parsed.value
}

/**
 * Register the three bridge routes, or nothing at all.
 *
 * Registers nothing unless the resolved `webServer` host is exactly
 * {@link LOOPBACK_HOST}; the refusal is written to BOTH the Cordis logger and
 * stderr, because the composed `web` profile mounts no logger exporter and a
 * logger-only refusal would be invisible.
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  const host = ctx.webServer.host
  if (host !== LOOPBACK_HOST) {
    const refusal = `dsh-debate-bridge: refusing to register — webServer is bound to "${host}", not "${LOOPBACK_HOST}". `
      + 'These routes accept an arbitrary prompt, an arbitrary workspace path and a danger-full-access permission preset, '
      + 'so exposing them beyond loopback would expose remote code execution to the network. Register nothing.'
    ctx.logger.error(refusal)
    process.stderr.write(`dsh-debate-bridge: ${refusal}\n`)
    return
  }

  const sessions = createDebateSessions({ warn: message => { ctx.logger.warn(message) } })
  // Every registration is an effect of this context, so plugin teardown removes
  // the routes and the status listeners even on a hot unload.
  ctx.effect(() => () => { sessions.dispose() }, 'dsh-debate-bridge.sessions()')

  // Resolved ONCE per mount: the route check reads the host's live LLM registry
  // (or is absent when this deployment mounts none), and neither changes while
  // the plugin is mounted.
  const routeHost = createRouteHost(ctx)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const request = await readValidated(req, res, parseStartRequest)
      if (request === undefined) return
      const presets = await resolvePresets(ctx, request)
      if (!presets.ok) {
        sendJson(res, 400, { error: presets.error })
        return
      }
      // Resolved BEFORE anything is created: a route the loop cannot run must
      // refuse the request, never mint a session whose every turn dies. The
      // provider half is checked against the host's live registry — the harness
      // itself accepts any route and swallows `NO_ADAPTER`.
      const route = await resolveModelRoute(ctx, request, routeHost)
      if (!route.ok) {
        sendJson(res, 400, { error: route.error })
        return
      }
      try {
        const sessionId = await sessions.open(ctx, {
          request,
          agentPresetId: presets.value.agentPresetId,
          permissionPreset: presets.value.permissionPreset,
          modelRoute: route.value,
        })
        sendJson(res, 200, { sessionId })
      } catch (error: unknown) {
        // Never a thrown 500 without a body the caller can log.
        sendJson(res, 500, { error: errorChain(error) })
      }
    },
  }), `dsh-debate-bridge: POST ${OPEN_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STOP_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const request = await readValidated(req, res, parseStopRequest)
      if (request === undefined) return
      try {
        sendJson(res, 200, { stopped: sessions.stop(ctx, request.sessionId) })
      } catch (error: unknown) {
        sendJson(res, 500, { error: errorChain(error) })
      }
    },
  }), `dsh-debate-bridge: POST ${STOP_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST')
        return
      }
      const request = await readValidated(req, res, parseStatusRequest)
      if (request === undefined) return
      try {
        const status: SessionStatus = sessions.status(ctx, request.sessionId)
        sendJson(res, 200, status)
      } catch (error: unknown) {
        sendJson(res, 500, { error: errorChain(error) })
      }
    },
  }), `dsh-debate-bridge: POST ${STATUS_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: MODELS_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET')
        return
      }
      // A pure read with no body: unlike the three verbs above, there is nothing
      // to validate and nothing to create. A host-side catalog problem is
      // reported IN the body (with a 200), because the caller must still be able
      // to open Settings and type a route by hand while the host is degraded.
      try {
        sendJson(res, 200, await listProviderModels(ctx))
      } catch (error: unknown) {
        // Unreachable (the reader catches internally) but kept so no code path
        // can produce a thrown 500 without a machine-readable body.
        sendJson(res, 200, {
          models: [],
          failures: [{ id: '', name: 'dsh', message: errorChain(error) }],
        })
      }
    },
  }), `dsh-debate-bridge: GET ${MODELS_ROUTE}`)
}

export type { OpenSessionInput, SessionStatus, RouteHost } from './session.ts'
export type { ModelCatalogFailure, ModelCatalogResponse, ProviderModelOption } from './models.ts'
export { createRouteHost, listProviderModels } from './models.ts'
export type { StartRequest, StatusRequest, StopRequest } from './request.ts'
export type { DebateOpponentSource } from './source.ts'
export { DEBATE_OPPONENT_SOURCE_KIND } from './source.ts'
