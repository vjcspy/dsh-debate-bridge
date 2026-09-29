/**
 * dsh-debate-bridge: the loopback HTTP bridge that runs the debate Opponent as
 * a live Session inside the already-running `dsh web` host, plus the browser
 * half's three fenced reads and the observer that links a Proposer-created
 * debate to the Session that created it.
 *
 * Four `exact` routes, all OUTSIDE `/api` so no cookie or Origin fence
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
 * assumption into a local invariant, and it gates the whole plugin — the
 * browser half's reads are useless without the GUI that draws them.
 *
 * The browser half's reads are registered instead on the admission-fenced `/api`
 * channel, which is a different fence for a different caller: see
 * `host/fenced-routes.ts`.
 *
 * A fifth, non-HTTP contribution rides the same mount: the optional
 * `ctx.shellEnv` contributor that publishes the calling session's ACTIVE route
 * as `DSH_PROPOSER_MODEL` (`src/shell-env.ts`).
 *
 * @module dsh-debate-bridge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type imports: these declare the `webServer`, `agents`,
// `agentDefaultModel`, `workspaceRegistry`, `permissionPresets`, `sessionTitle`,
// `agentPresets`, `connection` and `shellEnv` members this module reads.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createAttachRegistry } from './host/attach-registry.ts'
import { createCreateObserver } from './host/create-observer.ts'
import { registerFencedRoutes } from './host/fenced-routes.ts'
import { createDebateConfirmer, normalizeBaseUrl } from './host/forward.ts'
import { createRouteHost, listProviderModels } from './models.ts'
import {
  parseJsonObject,
  parseStartRequest,
  parseStatusRequest,
  parseStopRequest,
  type StartRequest,
} from './request.ts'
import type { Config } from './schema.ts'
import { createDebateSessions, resolveModelRoute, type SessionStatus } from './session.ts'
import { createProposerModelContributor, DSH_PROPOSER_MODEL_ENV } from './shell-env.ts'

export { Config } from './schema.ts'

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
 *
 * `connection` carries the browser half's three fenced reads, and is required for
 * the same mechanical reason: a route registered on an uninjected service is
 * refused by the context proxy. `agents` is already injected for the session
 * lifecycle and is what resolves a Session's lineage for the attach observer.
 */
export const inject = ['webServer', 'agents', 'workspaceRegistry', 'permissionPresets', 'sessionTitle', 'agentDefaultModel', 'agentPresets', 'llm', 'connection']

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
 * Register the four bridge routes and the browser half's Host side, or nothing
 * at all.
 *
 * Registers nothing unless the resolved `webServer` host is exactly
 * {@link LOOPBACK_HOST}; the refusal is written to BOTH the Cordis logger and
 * stderr, because the composed `web` profile mounts no logger exporter and a
 * logger-only refusal would be invisible.
 * @param ctx - host context.
 * @param config - validated live configuration resolved by the Loader.
 */
export function apply(ctx: Context, config: Config): void {
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

  // ── The browser half's Host side ───────────────────────────────────────────
  // The attachment store, the three fenced reads that serve it and the debate
  // server, and the observer that establishes a Proposer attachment from the
  // `aw debate create` tool result. None of it exists without the GUI, and none
  // of it is reachable from outside the admitted `/api` channel.
  const baseUrl = normalizeBaseUrl(config.debateServer.baseUrl)
  const timeoutMs = config.debateServer.requestTimeoutMs
  const token = resolveBearer(config.debateServer.authTokenEnv)
  const registry = createAttachRegistry()
  registerFencedRoutes(ctx, { baseUrl, timeoutMs, token, registry })

  const observer = createCreateObserver({
    registry,
    // The walk needs each hop's own header, and only a live Agent holds one: a
    // create runs in a live Session whose ancestors are live too, so an unknown
    // hop simply stops the walk.
    lineageOf: (sessionId) => {
      const header = ctx.agents.get(brandString<SessionId>(sessionId))?.session.header
      if (header === undefined) return undefined
      return {
        id: header.id,
        ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
        ...header.origin === undefined ? {} : { origin: header.origin },
      }
    },
    confirm: createDebateConfirmer({
      baseUrl,
      timeoutMs,
      token,
      fetch: async (url, call) => await fetch(url, {
        method: call.method,
        headers: { ...call.headers },
        signal: call.signal,
      }),
    }),
    note: message => { ctx.logger.debug(message) },
    now: () => Date.now(),
  })
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => { observer.observe(session, event) })
    return () => { dispose() }
  }, 'dsh-debate-bridge: create observer')

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

  // ── The managed shell env ──────────────────────────────────────────────────
  // Publishes the ACTIVE route of the Agent that runs a shell call, so a debate
  // proposed from DSH carries its model into `aw debate create`.
  //
  // A NESTED, OPTIONAL inject on purpose — the root `inject` list above is
  // all-required, so naming `shellEnv` there would make every debate route
  // unavailable on a composition that mounts no shell-env service, which is a
  // far worse failure than a missing env variable. `shellEnv` is an optional
  // peer for the same reason: the contributor is a bonus fact, not a
  // precondition. The `ctx.effect` wrapper owns disposal, so a plugin reload
  // releases the registration (and the registry's per-key ownership) before the
  // replacement registers.
  ctx.inject(['shellEnv'], (shellEnvCtx) => {
    shellEnvCtx.effect(() => {
      const dispose = shellEnvCtx.shellEnv.register(createProposerModelContributor())
      return () => { dispose() }
    }, `dsh-debate-bridge: ${DSH_PROPOSER_MODEL_ENV} contributor`)
  })
}

/**
 * Resolve the configured bearer from the environment variable it names.
 *
 * Declared here rather than imported from `host/forward.ts` so the entry module
 * states what the deployment must provide; the resolution rule itself is shared.
 * @param authTokenEnv - environment variable name, or the empty string.
 * @returns the token, or `undefined` when none is configured.
 */
function resolveBearer(authTokenEnv: string): string | undefined {
  const name = authTokenEnv.trim()
  if (name === '') return undefined
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

export type { OpenSessionInput, SessionStatus, RouteHost } from './session.ts'
export type { ModelCatalogFailure, ModelCatalogResponse, ProviderModelOption } from './models.ts'
export { createRouteHost, listProviderModels } from './models.ts'
export type { StartRequest, StatusRequest, StopRequest } from './request.ts'
export type { DebateAttachment, AttachRegistry, SessionLineage } from './host/attach-registry.ts'
export { createAttachRegistry } from './host/attach-registry.ts'
export type { CreateObserver, CreateObserverOptions } from './host/create-observer.ts'
export { createCreateObserver } from './host/create-observer.ts'
export type { DebateOpponentSource } from './source.ts'
export { DEBATE_OPPONENT_SOURCE_KIND } from './source.ts'
