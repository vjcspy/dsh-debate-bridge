/**
 * The `DSH_PROPOSER_MODEL` contribution over the BUILT artifact, in BOTH
 * compositions: one that mounts the real shell-env service, and one that does
 * not.
 *
 * The ABSENT case is the load-bearing half. `shellEnv` is deliberately not in
 * the plugin's root `inject` list, and a stub-free absence is what proves the
 * difference: with no shell-env service the plugin must still register every
 * debate route, because such a composition is a normal deployment rather than a
 * broken one. The present case runs the REAL registry, so the declaration is
 * validated by the service that owns the rules — the `DSH_` namespace, the
 * reserved built-ins, and the non-empty description.
 */

import { afterEach, expect, test } from 'vitest'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import { boot, post, type Composition } from './harness.ts'

/** The execution shape `collect` receives — derived, so the spec needs no `dsh-tools` dependency. */
type Execution = Parameters<ShellEnvRegistry['collect']>[0]

/** Route literals on purpose: this spec proves the ARTIFACT, not a shared constant. */
const STATUS = '/dsh-debate/opponent/status'
const MODELS = '/dsh-debate/models'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.dispose()
  composition = undefined
})

/**
 * One shell execution whose Agent reports the given live route.
 * @param provider - provider id the session is running on.
 * @param model - model id the session is running on.
 * @returns an execution shaped for the registry's `collect`.
 */
function execution(provider: string, model: string): Execution {
  return {
    agent: {
      options: {},
      // `collect` reads the session id for its own `DSH_SESSION_ID` built-in.
      session: { header: { id: 'session-spec' }, requestHeader: () => ({ config: { provider, model } }) },
    },
  } as unknown as Execution
}

test('the real registry accepts the declaration and collects the active route', async () => {
  composition = await boot()
  const declared = composition.ctx.shellEnv.list()
  expect(declared).toHaveLength(1)
  expect(declared[0]?.key).toBe('DSH_PROPOSER_MODEL')
  expect(declared[0]?.contributor).toBe('dsh-debate-bridge.proposer-model')
  expect(declared[0]?.description.trim()).not.toBe('')
  expect(composition.ctx.shellEnv.collect(execution('deepseek-official', 'deepseek-flash')).DSH_PROPOSER_MODEL)
    .toBe('deepseek-official/deepseek-flash')
}, 60_000)

test('without the service, every debate route still registers', async () => {
  composition = await boot({ withShellEnv: false })
  // The service is genuinely absent — read through `get`, the safe accessor, so
  // this assertion cannot itself trip the context access guard.
  expect(composition.ctx.get('shellEnv')).toBeUndefined()
  // ...and the routes that must not depend on it are all live.
  const status = await post(composition, STATUS, { sessionId: 'dsh-debate-absent' })
  expect(status.status).toBe(200)
  const models = await fetch(`http://127.0.0.1:${String(composition.port)}${MODELS}`)
  expect(models.status).toBe(200)
}, 60_000)
