/**
 * Composition harness: the BUILT plugin artifact mounted on a real Cordis
 * context with a real `WebServer` bound to an ephemeral loopback port, driven
 * over real HTTP.
 *
 * Two things are proven here that a source-only unit test cannot:
 * - `lib/index.js` — the file a profile install actually loads — is what runs,
 *   so a packaging error (missing export, bad entry point) fails here;
 * - the plugin composes through a real `cordis.yml` read by the real Loader,
 *   in the same shape `cordis.patch.yml` inserts into a profile.
 *
 * The services the plugin injects are provided as recording stubs, INCLUDING
 * `connection`: the browser half's reads are registered on the shared `/api`
 * channel, and a stub is enough to prove that registration because the channel
 * — not this plugin — owns admission. That is deliberate: the subjects under
 * test are the plugin's OWN contract (registration, validation, ordering, error
 * bodies), its loopback self-check, and the read policy, not the harness's
 * session stack or the channel's own admission.
 */

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** Repository root of this plugin package. */
export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The artifact a profile install loads. */
export const builtEntry = join(packageRoot, 'lib', 'index.js')

/** One `session/event` payload as this plugin reads it. */
export interface SessionEventLike {
  /** Event discriminant. */
  readonly type: string
  /** Event payload. */
  readonly data?: unknown
}

/** One root `session/event` listener, as the host dispatches it. */
export type SessionEventListener = (session: { readonly id: string }, event: SessionEventLike) => void

/** One recorded call, in arrival order. */
export interface Call {
  readonly what: string
  readonly detail?: unknown
}

/** One fake Agent, shaped for exactly the surface `src/session.ts` touches. */
export interface FakeAgent {
  readonly session: { readonly id: string }
  readonly ctx: { on(event: string, listener: (payload: { status: 'idle' | 'running' }) => void): () => void }
  status: 'idle' | 'running'
  /** Drive one synthetic status edge, as the real loop's `agent/status` would. */
  emitStatus(status: 'idle' | 'running'): void
  /** Every message admitted through `followup`, in order. */
  readonly followups: Array<{ content: Array<{ type: string; text: string }>; source: unknown }>
  readonly cancels: string[]
  /** Admit one message, mirroring `Agent.followup`. */
  followup(message: { content: Array<{ type: string; text: string }>; source: unknown }): void
  /** Record one cancellation cause, mirroring `Agent.cancel`. */
  cancel(cause: { kind: string }): void
}

/**
 * Create one fake Agent for `id`, recording follow-ups and cancellations.
 * @param id - session id the Agent reports.
 * @param status - initial status; the loop reports `idle` before the first turn.
 * @param record - optional sink appended to when a turn is admitted, so a spec
 *   can prove `followup` is the LAST step of the create sequence.
 */
export function fakeAgent(
  id: string,
  status: 'idle' | 'running' = 'idle',
  record?: (what: string) => void,
): FakeAgent {
  const listeners = new Set<(payload: { status: 'idle' | 'running' }) => void>()
  const agent = {
    session: { id },
    ctx: {
      on(_event: string, listener: (payload: { status: 'idle' | 'running' }) => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    status,
    followups: [] as FakeAgent['followups'],
    cancels: [] as string[],
    emitStatus(next: 'idle' | 'running') {
      agent.status = next
      for (const listener of [...listeners]) listener({ status: next })
    },
    followup(message: FakeAgent['followups'][number]) {
      record?.('agent.followup')
      agent.followups.push(message)
    },
    cancel(cause: { kind: string }) {
      record?.('agent.cancel')
      agent.cancels.push(cause.kind)
    },
  }
  return agent
}

/** Everything a composition spec needs to drive the bridge. */
export interface Composition {
  /** The booted context; assigned during {@link boot}. */
  ctx: Context
  /** Loopback port the real `WebServer` bound; known only once it has listened. */
  port: number
  /** Every service call the plugin made, in order. */
  readonly calls: Call[]
  /** The fake Agent the stub `agents.get` currently reports, when any. */
  live: FakeAgent | undefined
  /** Resolve `agents.resume` with this Agent instead of the absent-session error. */
  resumeWith: FakeAgent | undefined
  /**
   * Scripted answers for `agents.get`, consumed one per call, falling back to
   * {@link Composition.live}. Used to reproduce the lost create race: the first
   * live check sees nothing, and the check after a failed `create` sees the
   * winner.
   */
  readonly getAnswers: Array<FakeAgent | undefined>
  /** Make `agents.create` throw this error instead of succeeding. */
  createThrows: unknown
  /**
   * Every fenced route the plugin registered on `connection.fetch`, in
   * registration order.
   */
  readonly routes: ConnectionFetchRoute[]
  /** Bearer resolved for the fenced reads, when a spec configured one. */
  bearer: string | undefined
  /**
   * The plugin's root `session/event` listeners, captured as the host's own
   * dispatch would call them. Driving them directly keeps a spec independent of
   * Cordis scope-filtered dispatch, which is the host's concern, not this
   * plugin's.
   */
  readonly sessionListeners: SessionEventListener[]
  /**
   * What the stub `agentDefaultModel.currentSelection()` reports. Mutable so a
   * spec can reproduce a host whose default model is complete, and one where it
   * is blank in either half — the latter must refuse the request rather than
   * mint a session whose every turn dies.
   */
  defaultModel: { provider: string; model: string }
  /**
   * The stub LLM registry the plugin reads for two purposes: the route check
   * (`resolveCallConfig`) and the model catalog (`listProviders` +
   * `listModels` + `resolveModelInfo`).
   *
   * `resolveCall` decides what `resolveCallConfig` does: `null` resolves, a code
   * string throws an error carrying that `code` (so `NO_ADAPTER` can be
   * reproduced), and `'absent'` removes the whole `llm` service from the context
   * — the deployment the plugin must not refuse routes on.
   */
  llm: {
    /**
     * What `resolveCallConfig` does: `null` resolves, any other value throws an
     * error carrying that `code` (so `NO_ADAPTER` is reproducible).
     */
    resolveCall: null | string
    providers: Array<{
      id: string
      name: string
      models: Array<{ id: string; name: string }>
      /** Simulates an adapter whose model discovery fails. */
      brokenModels?: boolean
    }>
  }
  dispose(): Promise<void>
}

/** Provide one service on the root context without the typed `Context` surface. */
export function provide(ctx: Context, name: string, value: unknown): void {
  (ctx as unknown as { provide(name: string, value: unknown): () => void }).provide(name, value)
}

/** Options for {@link boot}. */
export interface BootOptions {
  /** Mount the bridge entry in the generated `cordis.yml`; default `true`. */
  readonly withBridge?: boolean
  /**
   * Debate-server origin written into the plugin's `config` row, so a spec can
   * point the fenced reads at a real local server.
   */
  readonly debateServerUrl?: string
  /** Environment name the plugin resolves its bearer from, written into the same row. */
  readonly authTokenEnv?: string
  /**
   * Publish the stub `llm` service; default `true`. `false` reproduces a
   * deployment that mounts no LLM service, where the route check cannot run.
   */
  readonly withLlm?: boolean
}

/**
 * Boot the real Web composition: a real `cordis.yml` read by the real Loader,
 * the real `WebServer` on `127.0.0.1:0`, stub services, built plugin.
 * @param options - whether the generated config mounts the bridge.
 * @returns the booted composition; the caller owns `dispose()`.
 */
export async function boot(options: BootOptions = {}): Promise<Composition> {
  if (!existsSync(builtEntry)) throw new Error(`built artifact missing: ${builtEntry} — run \`pnpm run build\` first`)
  const withBridge = options.withBridge ?? true
  const root = await mkdtemp(join(tmpdir(), 'dsh-debate-bridge-'))
  const calls: Call[] = []
  const record = (what: string, detail?: unknown): void => { calls.push(detail === undefined ? { what } : { what, detail }) }

  const composition: Composition = {
    ctx: undefined as unknown as Context,
    port: 0,
    calls,
    live: undefined,
    resumeWith: undefined,
    getAnswers: [],
    createThrows: undefined,
    routes: [],
    bearer: undefined,
    sessionListeners: [],
    defaultModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    llm: {
      resolveCall: null,
      providers: [{
        id: 'deepseek-official',
        name: 'DeepSeek Official',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      }],
    },
    dispose: async () => { await rm(root, { recursive: true, force: true }) },
  }

  const ctx = new Context()
  composition.ctx = ctx

  // `session/event` is delivered through Cordis scope-filtered dispatch, which
  // needs a live Session carrier. The plugin's own listener is what these specs
  // exercise, so it is captured here and called directly.
  const eventHost = ctx as unknown as {
    on(name: string, listener: SessionEventListener): () => void
  }
  const originalOn = eventHost.on.bind(ctx)
  eventHost.on = (name, listener) => {
    if (name === 'session/event') composition.sessionListeners.push(listener)
    return originalOn(name, listener)
  }

  // The canonical directory the registry would report for a request path. It is
  // deliberately DIFFERENT from the request spelling: `meta.cwd` must come from
  // the returned Workspace, never from the raw request string.
  const canonicalPath = join(root, 'canonical', 'aweave')
  const attachSession = async (sessionId: string): Promise<void> => { record('workspace.attachSession', sessionId) }
  provide(ctx, 'workspaceRegistry', {
    async create(path: string) {
      record('workspaceRegistry.create', path)
      return {
        path: canonicalPath,
        attachSession,
        detachSession: async (sessionId: string) => { record('workspace.detachSession', sessionId) },
      }
    },
  })
  provide(ctx, 'agents', {
    get(id: string) {
      record('agents.get', id)
      if (composition.getAnswers.length > 0) return composition.getAnswers.shift()
      // Keyed by identity, like the real registry: a live Agent is only visible
      // under its own id, so a status/stop probe for an unknown id finds
      // nothing rather than whatever happens to be live.
      return composition.live?.session.id === id ? composition.live : undefined
    },
    async resume(options: { resumeSessionId: string; agentOptions?: unknown; setup?: unknown }) {
      record('agents.resume', { sessionId: options.resumeSessionId, agentOptions: options.agentOptions, hasSetup: typeof options.setup === 'function' })
      if (composition.resumeWith !== undefined) {
        const resumed = composition.resumeWith
        if (typeof options.setup === 'function') {
          await (options.setup as (agentCtx: unknown, agent: unknown) => unknown)(
            { on: () => () => {} },
            resumed,
          )
        }
        const admit = resumed.followup.bind(resumed)
        resumed.followup = (message) => { record('agent.followup'); admit(message) }
        return { agent: resumed, dispose: async () => {} }
      }
      const { SessionPersistenceNotFoundError } = await import('@deepseek-ai/dsh-session-persistence')
      throw new SessionPersistenceNotFoundError(options.resumeSessionId as never)
    },
    async create(options: { sessionId: string; meta?: unknown; agentOptions?: unknown; setup?: unknown }) {
      record('agents.create', { sessionId: options.sessionId, meta: options.meta, agentOptions: options.agentOptions, hasSetup: typeof options.setup === 'function' })
      if (composition.createThrows !== undefined) throw composition.createThrows
      const agent = fakeAgent(options.sessionId, 'idle', record)
      if (typeof options.setup === 'function') {
        // Run the real setup against the stub registry so `agentPresets.mount`
        // is proven, not just asserted present. The fake agentCtx only needs
        // the `on()` surface `installInitialModelSelection` touches.
        await (options.setup as (agentCtx: unknown, agent: unknown) => unknown)(
          { on: () => () => {} },
          agent,
        )
      }
      composition.live = agent
      return { agent, dispose: async () => { record('agents.handle.dispose') } }
    },
  })
  provide(ctx, 'permissionPresets', {
    defaultPreset: 'workspace-write',
    resolve(name: string) {
      if (name !== 'danger-full-access' && name !== 'workspace-write') {
        throw new Error(`permission: unknown preset "${name}" (known: workspace-write, danger-full-access)`)
      }
      return { sandbox: name, approval: name === 'danger-full-access' ? 'never' : 'ask' }
    },
    set(session: { id: string }, name: string) { record('permissionPresets.set', { session: session.id, name }) },
  })
  provide(ctx, 'sessionTitle', {
    rename(session: { id: string }, title: string) { record('sessionTitle.rename', { session: session.id, title }) },
  })
  provide(ctx, 'agentPresets', {
    async resolve(id?: string) {
      const effective = id ?? 'standard'
      if (effective !== 'standard') throw new Error(`agent-presets: preset "${effective}" not found (available: standard)`)
      return { id: effective }
    },
    async mount(agentCtx: unknown, id?: string) {
      record('agentPresets.mount', id ?? 'standard')
      return { id: id ?? 'standard' }
    },
  })
  // The shared `/api` channel's host registry. Admission belongs to the real
  // channel and is verified in the browser; what these specs prove is that the
  // plugin registers THROUGH this seam rather than on `webServer`, which is what
  // makes the channel's admission apply at all.
  provide(ctx, 'connection', {
    fetch: {
      register(route: ConnectionFetchRoute) {
        record('connection.fetch.register', route.path)
        composition.routes.push(route)
        return async () => {}
      },
    },
  })
  if (options.authTokenEnv !== undefined) {
    process.env[options.authTokenEnv] = 'spec-token'
    composition.bearer = 'spec-token'
  }

  provide(ctx, 'agentDefaultModel', {
    currentSelection() {
      record('agentDefaultModel.currentSelection')
      return { ...composition.defaultModel }
    },
  })

  // A stub LLM registry, delegated per call so a spec can re-script it after the
  // mount (the plugin resolves the service ONCE at mount time).
  const llmMethods = {
    listProviders() {
      record('llm.listProviders')
      return composition.llm.providers.map(({ id, name }) => ({ id, name }))
    },
    async listModels(provider: string) {
      record('llm.listModels', provider)
      const found = composition.llm.providers.find((p) => p.id === provider)
      if (found === undefined) throw new Error(`no adapter registered for provider "${provider}"`)
      if (found.brokenModels === true) throw new Error(`model discovery failed for "${provider}"`)
      return found.models.map((model) => ({ ...model }))
    },
    async resolveModelInfo(provider: string, model: string) {
      record('llm.resolveModelInfo', { provider, model })
      return { provider, id: model, name: model }
    },
    async resolveCallConfig(config: { provider: string; model: string }) {
      record('llm.resolveCallConfig', config)
      const scripted = composition.llm.resolveCall
      if (scripted !== null && scripted !== 'absent') {
        const error = new Error(`stub LlmError(${scripted})`) as Error & { code: string }
        error.code = scripted
        throw error
      }
      return config
    },
  }
  // Mounted unless the spec asks for a deployment WITHOUT an LLM service: a host
  // that mounts none cannot be asked about routes, and must not refuse them.
  if (options.withLlm ?? true) provide(ctx, 'llm', llmMethods)

  // The real Loader over a real `cordis.yml`, importing the BUILT artifact.
  const built: unknown = await import(pathToFileURL(builtEntry).href)
  const Loader = (await import('@deepseek-ai/cordis-plugin-loader')).default
  const Include = (await import('@deepseek-ai/cordis-plugin-include')).default
  const WebServer = (await import('@deepseek-ai/dsh-host-webserver')).default
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: \'@deepseek-ai/dsh-host-webserver\'',
    '  config:',
    '    host: \'127.0.0.1\'',
    '    port: 0',
    ...withBridge
      // Exactly the entry `cordis.patch.yml` inserts, plus the `config` row the
      // plugin now accepts.
      ? [
        '- id: dsh-debate-bridge',
        '  name: \'dsh-debate-bridge\'',
        ...options.debateServerUrl === undefined && options.authTokenEnv === undefined
          ? []
          : [
            '  config:',
            '    debateServer:',
            ...options.debateServerUrl === undefined ? [] : [`      baseUrl: '${options.debateServerUrl}'`],
            ...options.authTokenEnv === undefined ? [] : [`      authTokenEnv: '${options.authTokenEnv}'`],
          ],
      ]
      : [],
    '',
  ].join('\n'), 'utf8')

  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (specifier === 'dsh-debate-bridge') return built
      if (specifier === '@deepseek-ai/dsh-host-webserver') return WebServer
      throw new Error(`unexpected Loader import: ${specifier}`)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()

  composition.port = ctx.webServer.port
  const previousDispose = composition.dispose
  composition.dispose = async () => {
    await ctx.fiber.dispose()
    if (options.authTokenEnv !== undefined) delete process.env[options.authTokenEnv]
    await previousDispose()
  }
  return composition
}

/** POST one JSON body to a route on a booted composition. */
export async function post(
  composition: Composition,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly json: Record<string, unknown>; readonly text: string }> {
  const response = await fetch(`http://127.0.0.1:${String(composition.port)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
  } catch {
    // A non-JSON body is a failure of the route under test, surfaced by `text`.
  }
  return { status: response.status, json, text }
}

/**
 * Call one fenced route through the registry the plugin registered into.
 *
 * The real channel would have applied admission before reaching this point; the
 * stub stands in for that layer, so a spec here asserts the read policy and the
 * registration, never admission (which is proven in the browser).
 * @param composition - a booted composition.
 * @param target - fenced pathname plus query string.
 * @param method - HTTP method to dispatch.
 * @returns the route's response.
 */
export async function callFenced(
  composition: Composition,
  target: string,
  method = 'GET',
): Promise<Response> {
  const url = new URL(target, `http://127.0.0.1:${String(composition.port)}`)
  const route = composition.routes.find(candidate => candidate.path === url.pathname)
  if (route === undefined) throw new Error(`no fenced route registered for ${url.pathname}`)
  return await route.fetch(new Request(url, { method }))
}

/** A valid start body for the given debate. */
export function startBody(debateId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    debateId,
    title: `Debate ${debateId} — Opponent`,
    prompt: 'You are the Opponent. Run `pnpm aw debate get-context` first.',
    agentPreset: '',
    permissionPreset: 'danger-full-access',
    workspacePath: '/Users/example/aweave',
    ...overrides,
  }
}

/** The generated config's own text, for the "same shape as cordis.patch.yml" assertion. */
export function patchFileText(): string {
  return readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
}
