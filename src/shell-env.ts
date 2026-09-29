/**
 * The `DSH_PROPOSER_MODEL` shell-env contributor: publishes the ACTIVE model
 * route of the Agent running a shell call, so `aw debate create` — which reads
 * `DSH_PROPOSER_MODEL` after `AWEAVE_PROPOSER_MODEL` — records the model that
 * actually proposed the debate, not the route its session was created with.
 *
 * Two things about the source are load-bearing:
 *
 * - The ACTIVE route is `session.requestHeader()?.config`, NOT `agent.options`.
 *   Options are stamped once at Agent creation
 *   (`packages/api/session-controller/src/agent.ts:485-499`), so a model switched
 *   in the composer mid-session leaves them stale and this contributor would
 *   publish the CREATION route — a silently wrong `(dsh, model)` routing key
 *   that a fresh-session probe cannot catch. The harness's own inheritance
 *   helper resolves it the same way, header first
 *   (`packages/subagent/subagent/src/child-agent.ts:61-86`).
 * - Before the first request there is no header, and `options` IS the live
 *   route; with no Agent at all (a shell call outside any session) the
 *   contributor publishes nothing.
 *
 * The variable name is mirrored as a literal in `debate-machine`'s
 * `DSH_PROPOSER_MODEL_ENV` (`proposer-tokens.ts`), which reads it. The two
 * packages cannot import each other, so a rename must land on both sides.
 *
 * @module dsh-debate-bridge/shell-env
 */

import type { BashEnvContributor } from '@deepseek-ai/dsh-shell-env'

/**
 * Managed shell variable carrying the proposer's `provider/model` route.
 *
 * `DSH_*` is not a style choice: `ctx.shellEnv` accepts only that namespace and
 * reserves the five built-ins (`packages/shell/shell-env/src/index.ts:76-82`),
 * so the OpenCode-side name (`AWEAVE_PROPOSER_MODEL`) is unavailable here.
 */
export const DSH_PROPOSER_MODEL_ENV = 'DSH_PROPOSER_MODEL' as const

/**
 * Stable contributor name. The registry keys both its duplicate detection and
 * its per-key ownership on this, so it is part of the deployment contract.
 */
export const PROPOSER_MODEL_CONTRIBUTOR = 'dsh-debate-bridge.proposer-model'

/**
 * Build the `DSH_PROPOSER_MODEL` contributor.
 *
 * `resolve` returns `{}` — never a throw, never a non-string and never a
 * partial route — whenever the route is unresolvable: the registry validates
 * the returned map at COLLECT time, i.e. inside the model's own shell call, and
 * an undeclared key or a non-string value aborts that call. A blank half is
 * treated as unresolvable for the same reason the value exists at all: the
 * consumer accepts only `provider/model`, so `/model` would be a malformed
 * claim where silence is a truthful one.
 * @returns the contributor to register with `ctx.shellEnv`.
 */
export function createProposerModelContributor(): BashEnvContributor {
  return {
    name: PROPOSER_MODEL_CONTRIBUTOR,
    variables: {
      [DSH_PROPOSER_MODEL_ENV]: {
        description: 'Active model route (`provider/model`) of the DeepSeek Harness session running this command.',
      },
    },
    resolve: (execution) => {
      // The header, once it exists, is authoritative even when it is
      // incomplete: falling back to `options` there would publish a route the
      // session has already left.
      const active = execution.agent?.session.requestHeader()?.config
      const route = active === undefined
        ? routeOf(execution.agent?.options)
        : routeOf(active)
      return route === undefined ? {} : { [DSH_PROPOSER_MODEL_ENV]: route }
    },
  }
}

/**
 * Render one route as `provider/model`.
 *
 * Both halves are read defensively: the header's config is typed as complete,
 * but this value is produced by whatever the host last dispatched, and a
 * non-string or blank half must degrade to "no contribution" rather than reach
 * the shell as `undefined/model`.
 * @param route - candidate route, or `undefined` when no source exists.
 * @returns the rendered route, or `undefined` when either half is unusable.
 */
function routeOf(route: { readonly provider?: string; readonly model?: string } | undefined): string | undefined {
  if (route === undefined) return undefined
  const provider = route.provider
  const model = route.model
  if (typeof provider !== 'string' || provider === '') return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return `${provider}/${model}`
}
