/**
 * The `DSH_PROPOSER_MODEL` contributor against the REAL registry.
 *
 * The registry is the subject here, not a stub: it is what validates a
 * contributor's declared key at registration and its returned map at COLLECT
 * time — i.e. inside the model's own shell call — so the declaration, the
 * reserved-key rules and the "never a non-string" contract are exercised rather
 * than assumed.
 *
 * The route cases mirror the measurement that chose the source
 * (`session.requestHeader()?.config` first, `agent.options` only before the
 * first request): the header pair below is the mid-session switch that was
 * measured, where `options` still reported the route the session was CREATED
 * with.
 */
import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ShellEnvRegistry, type BashEnvContributor } from '@deepseek-ai/dsh-shell-env'
import {
  createProposerModelContributor,
  DSH_PROPOSER_MODEL_ENV,
  PROPOSER_MODEL_CONTRIBUTOR,
} from '../../src/shell-env.ts'

/** The execution shape `resolve` receives — derived, so the spec needs no `dsh-tools` dependency. */
type Execution = Parameters<BashEnvContributor['resolve']>[0]

/** One Agent view as the contributor reads it: a request header and/or creation options. */
interface AgentView {
  /** What `session.requestHeader()` reports; `undefined` before the first request. */
  readonly header?: { readonly provider?: unknown; readonly model?: unknown }
  /** Creation-time options, stamped once when the Agent was created. */
  readonly options?: { readonly provider?: unknown; readonly model?: unknown }
}

/**
 * Build one tool execution carrying the given Agent view.
 * @param agent - the Agent view, or `undefined` for a shell call outside any session.
 * @returns an execution shaped for the contributor's resolver.
 */
function execution(agent?: AgentView): Execution {
  if (agent === undefined) return {} as unknown as Execution
  return {
    agent: {
      options: agent.options ?? {},
      session: {
        // `collect` reads the session id for its own `DSH_SESSION_ID` built-in,
        // so the fake carries the minimum header a live Agent always has.
        header: { id: 'session-spec' },
        requestHeader: () => agent.header === undefined ? undefined : { config: agent.header },
      },
    },
  } as unknown as Execution
}

/**
 * A real registry with the contributor registered, as the plugin mounts it.
 * @returns the registry holding the `DSH_PROPOSER_MODEL` contribution.
 */
function registered(): ShellEnvRegistry {
  const registry = new ShellEnvRegistry(new Context(), { dshHome: './spec-dsh-home' })
  registry.register(createProposerModelContributor())
  return registry
}

describe('the DSH_PROPOSER_MODEL contributor', () => {
  test('declares one DSH_-namespaced variable, with a description', () => {
    const declared = registered().list()
    expect(declared).toHaveLength(1)
    expect(declared[0]?.key).toBe(DSH_PROPOSER_MODEL_ENV)
    expect(declared[0]?.contributor).toBe(PROPOSER_MODEL_CONTRIBUTOR)
    // A blank description is rejected by the registry, so this also pins the
    // registration itself: it survived validation.
    expect(declared[0]?.description.trim()).not.toBe('')
  })

  test('publishes the ACTIVE request-header route, not the creation route', () => {
    const collected = registered().collect(execution({
      header: { provider: 'deepseek-official', model: 'deepseek-flash' },
      options: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    }))
    expect(collected[DSH_PROPOSER_MODEL_ENV]).toBe('deepseek-official/deepseek-flash')
    // Built-ins still ride along: the contribution is additive.
    expect(collected.DSH_SHELL).toBe('1')
  })

  test('falls back to the creation options before the first request', () => {
    const collected = registered().collect(execution({
      options: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    }))
    expect(collected[DSH_PROPOSER_MODEL_ENV]).toBe('opencode-go/muse-spark-1.3-contributor')
  })

  test('contributes nothing when no Agent is available', () => {
    const collected = registered().collect(execution())
    expect(DSH_PROPOSER_MODEL_ENV in collected).toBe(false)
    expect(collected.DSH_HOME).toBeTruthy()
  })

  test('contributes nothing rather than a malformed route, and never throws', () => {
    const registry = registered()
    // A header that exists but is incomplete is still authoritative: the stale
    // creation route must NOT be published in its place.
    expect(DSH_PROPOSER_MODEL_ENV in registry.collect(execution({
      header: { provider: 'deepseek-official', model: '' },
      options: { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' },
    }))).toBe(false)
    // A non-string half is REJECTED by the registry at collect time, which is
    // exactly why the resolver drops it instead of forwarding it.
    expect(DSH_PROPOSER_MODEL_ENV in registry.collect(execution({
      header: { provider: 'deepseek-official', model: 42 },
    }))).toBe(false)
    expect(DSH_PROPOSER_MODEL_ENV in registry.collect(execution({ options: {} }))).toBe(false)
  })

  test('disposal releases the key, so a reload can register it again', () => {
    const registry = new ShellEnvRegistry(new Context(), { dshHome: './spec-dsh-home' })
    const dispose = registry.register(createProposerModelContributor())
    // The reason the plugin wraps registration in `ctx.effect`: without
    // disposal a reload would fail on the still-owned name and key.
    expect(() => registry.register(createProposerModelContributor())).toThrow(/already registered/)
    dispose()
    registry.register(createProposerModelContributor())
    expect(registry.collect(execution({ header: { provider: 'a', model: 'b' } }))[DSH_PROPOSER_MODEL_ENV]).toBe('a/b')
  })
})
