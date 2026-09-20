/**
 * The bridge's model catalog: the routes the running host can actually serve.
 *
 * Why this lives in the PLUGIN and not in `debate-server`: the option list is a
 * property of the host's live LLM registry, which exists only in-process. The
 * server cannot enumerate it, so the Settings editor asks over the loopback
 * route this module backs.
 *
 * `buildModelCatalog` is the SAME function the Web GUI's `/model` popup uses
 * through the `session/modelCatalog` RPC, deliberately: the operator's pick-list
 * and the GUI's picker are then one projection and cannot disagree. It also
 * already isolates per-provider failures (`listModels` may be network-bound for a
 * third-party adapter), so a broken provider degrades to a reported failure
 * rather than taking the whole list down.
 *
 * It does NOT read `~/.dsh/plugins/subscriptions/models.json`: that file is a
 * third-party plugin's private discovery cache for its own providers, silent by
 * design on corruption, and written by nothing in this checkout.
 *
 * @module dsh-debate-bridge/models
 */

import type { Context } from '@deepseek-ai/cordis'
import { buildModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
// Side-effect type import: declares the `llm` member this module reads.
import type {} from '@deepseek-ai/dsh-llm'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { RouteHost } from './session.ts'

/** One selectable route, as the debate server's Settings editor needs it. */
export interface ProviderModelOption {
  /** The wire value the routing rule stores: `provider/model`. */
  readonly value: string
  /** What the operator reads. */
  readonly label: string
}

/** One provider whose catalog could not be loaded. */
export interface ModelCatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** The models verb's response body. */
export interface ModelCatalogResponse {
  readonly models: readonly ProviderModelOption[]
  readonly failures: readonly ModelCatalogFailure[]
}

/**
 * Read the host's routable model routes.
 *
 * Never throws and never answers a non-2xx for a host-side problem: the operator
 * must still be able to open Settings (and type a route by hand) while an adapter
 * is down, so every failure is reported in `failures` with `models: []`.
 * @param ctx - host context.
 * @returns the provider-grouped routes plus the isolated per-provider failures.
 */
export async function listProviderModels(ctx: Context): Promise<ModelCatalogResponse> {
  try {
    if (readOptionalService<LlmService>(ctx, 'llm') === undefined) {
      // `buildModelCatalog` dereferences `ctx.llm` unguarded, so a deployment
      // that mounts no LLM service is REPORTED rather than thrown: the operator
      // must still be able to open Settings and type a route by hand.
      return {
        models: [],
        failures: [{
          id: '',
          name: 'dsh',
          message: 'model catalog unavailable: this host mounts no llm service',
        }],
      }
    }
    const catalog = await buildModelCatalog(ctx)
    return {
      models: catalog.groups.flatMap((group) => group.models.map((model) => ({
        value: `${group.id}/${model.id}`,
        label: `${model.name} (${group.id})`,
      }))),
      failures: catalog.failures.map((failure) => ({
        id: failure.id,
        name: failure.name,
        message: failure.message,
      })),
    }
  } catch (error: unknown) {
    return {
      models: [],
      failures: [{
        id: '',
        name: 'dsh',
        message: `model catalog unavailable: ${errorChain(error)}`,
      }],
    }
  }
}

/** The `llm` service as this module needs it, resolved optionally. */
interface LlmService {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  resolveCallConfig(config: { readonly provider: string; readonly model: string }): Promise<unknown>
}

/** The reflection surface Cordis exposes for an UNGUARDED service lookup. */
interface ReflectSurface {
  get(name: string, strict?: boolean): unknown
}

/**
 * Read a service WITHOUT the inject guard, or `undefined` when it is absent.
 *
 * `ctx.get(name)` is NOT an unguarded lookup: the context proxy serves `get`
 * itself, so `ctx.get('llm')` resolves to an accessor that throws
 * `cannot get property "llm" without inject` before any absence check can run
 * (measured — a boot against the real `web` profile answered
 * `model catalog unavailable: cannot get property "llm" without inject`).
 * `ctx.reflect.get(name, false)` is the real optional read: it returns
 * `undefined` instead of throwing, which is what makes "this deployment mounts
 * no LLM service" a normal state rather than a broken bridge.
 * @param ctx - host context.
 * @param name - service name.
 * @returns the service value, or `undefined`.
 */
function readOptionalService<T>(ctx: Context, name: string): T | undefined {
  const reflect = (ctx as unknown as { reflect?: ReflectSurface }).reflect
  if (reflect === undefined) return undefined
  try {
    return (reflect.get(name, false) as T | undefined) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build the route check {@link resolveModelRoute} runs before anything is
 * created.
 *
 * The harness does NOT perform this check itself: `agents.create` accepts any
 * route, and the agent loop *swallows* `NO_ADAPTER`
 * (`packages/core/agent-loop/src/agent.ts:536-548`), so a typo'd provider id
 * yields a green 200 and a session whose every turn silently dies. The check is
 * the same one `commands.selectModel` makes
 * (`packages/api/session-controller/src/commands.ts:133-143`).
 *
 * Two deliberate limits:
 *
 * - **Only `NO_ADAPTER` refuses.** The model dimension is advisory ("an adapter
 *   may accept unlisted model ids, and consumers must not turn absence into
 *   request rejection", `packages/llm/llm/src/index.ts`), so an unlisted model id
 *   inside a known provider is NOT a refusal.
 * - **Absent `llm` never refuses.** A deployment that mounts no LLM service
 *   cannot be asked the question, and refusing every route there would break a
 *   host that works. The service is read through {@link readOptionalService}
 *   rather than added to `inject`, because a required inject would turn "no LLM
 *   mounted" into "the bridge never activates".
 * @param ctx - host context.
 * @returns a check, or `null` when this host cannot answer it.
 */
export function createRouteHost(ctx: Context): RouteHost | null {
  const llm = readOptionalService<LlmService>(ctx, 'llm')
  if (llm === undefined) return null

  return {
    async checkRoute(provider: string, model: string): Promise<string | null> {
      try {
        await llm.resolveCallConfig({ provider, model })
        return null
      } catch (error: unknown) {
        const code = (error as { code?: unknown } | null)?.code
        if (code !== 'NO_ADAPTER') {
          // A model-level rejection is the model's own business (see above), and
          // any other failure is not a statement that the provider is missing.
          return null
        }
        return `provider "${provider}" has no adapter registered in the DSH host; `
          + `routable providers: ${llm.listProviders().map((p) => p.id).join(', ') || '(none)'}`
      }
    },
  }
}
