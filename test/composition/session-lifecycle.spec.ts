/**
 * Session lifecycle, over the BUILT artifact and real HTTP.
 *
 * The subjects here are the defects two debate rounds were spent on:
 * - the create sequence must be `create → attachSession → permissionPresets.set
 *   → sessionTitle.rename → followup`, with `followup` LAST and the preset step
 *   present at all (omitting it fails SILENTLY: the sidebar row appears, the id
 *   is returned, and the session runs on `workspace-write` / `approval: 'ask'`);
 * - `meta.cwd` must come from the created `Workspace`, never the raw request
 *   string, because `attachSession` compares resolved directories;
 * - a live debate must ADOPT instead of duplicating, and a cold-but-persisted id
 *   must fall through `resume` rather than 5xx;
 * - `idle` must be an observed status EDGE, never an elapsed-time predicate.
 */

import { afterEach, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionAlreadyExistsError } from '@deepseek-ai/dsh-session-persistence'
import {
  boot,
  builtEntry,
  fakeAgent,
  packageRoot,
  post,
  provide,
  startBody,
  type Composition,
} from './harness.ts'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const OPEN = '/dsh-debate/opponent'
const STOP = '/dsh-debate/opponent/stop'
const STATUS = '/dsh-debate/opponent/status'

/** The five mutating steps of the create path, in the mandated order. */
const CREATE_SEQUENCE = [
  'workspaceRegistry.create',
  'agents.create',
  'workspace.attachSession',
  'permissionPresets.set',
  'sessionTitle.rename',
  'agent.followup',
]

let composition: Composition | undefined

afterEach(async () => {
  await composition?.dispose()
  composition = undefined
  vi.restoreAllMocks()
})

test('a cold debate creates the session in the exact mandated order, followup last', async () => {
  composition = await boot()
  const opened = await post(composition, OPEN, startBody('order-1', { model: 'deepseek/deepseek-v3' }))
  expect(opened.status).toBe(200)
  expect(opened.json['sessionId']).toBe('dsh-debate-order-1')

  const mutating = composition.calls.filter(call => CREATE_SEQUENCE.includes(call.what)).map(call => call.what)
  expect(mutating).toEqual(CREATE_SEQUENCE)

  const create = composition.calls.find(call => call.what === 'agents.create')?.detail as {
    sessionId: string
    meta: { cwd: string; agentPreset?: string }
    agentOptions: { model?: string }
  }
  expect(create.sessionId).toBe('dsh-debate-order-1')
  // The canonical path the Workspace reported, NOT the request's spelling.
  expect(create.meta.cwd).not.toBe('/Users/example/aweave')
  expect(create.meta.cwd).toContain(join('canonical', 'aweave'))
  // "" means host default, so the carrier must stay ABSENT rather than be set
  // to an empty string the loop would have to interpret.
  expect('agentPreset' in create.meta).toBe(false)
  expect(create.agentOptions).toEqual({ model: 'deepseek/deepseek-v3' })

  const preset = composition.calls.find(call => call.what === 'permissionPresets.set')?.detail as {
    session: string
    name: string
  }
  expect(preset).toEqual({ session: 'dsh-debate-order-1', name: 'danger-full-access' })
  const title = composition.calls.find(call => call.what === 'sessionTitle.rename')?.detail as { title: string }
  expect(title.title).toBe('Debate order-1 — Opponent')

  // The admitted turn carries this plugin's own source kind, so a
  // reconciliation pass in another plugin cannot mistake it for its own input.
  const agent = composition.live
  expect(agent?.followups).toHaveLength(1)
  expect(agent?.followups[0]?.source).toMatchObject({ kind: 'debate-opponent', debateId: 'order-1', form: 'notice' })
  expect(agent?.followups[0]?.content[0]?.text).toContain('debate get-context')
}, 60_000)

test('a non-empty agentPreset is resolved to its canonical id and carried in meta', async () => {
  composition = await boot()
  await post(composition, OPEN, startBody('order-2', { agentPreset: 'standard' }))
  const create = composition.calls.find(call => call.what === 'agents.create')?.detail as {
    meta: { agentPreset?: string }
  }
  expect(create.meta.agentPreset).toBe('standard')
}, 60_000)

test('an empty permissionPreset resolves to the concrete host default, so set still runs', async () => {
  composition = await boot()
  await post(composition, OPEN, startBody('order-3', { permissionPreset: '' }))
  const preset = composition.calls.find(call => call.what === 'permissionPresets.set')?.detail as { name: string }
  // An explicitly applied default is observable; an omitted call is not.
  expect(preset.name).toBe('workspace-write')
}, 60_000)

test('a second open for a LIVE debate adopts: no create, no resume, exactly one more turn', async () => {
  composition = await boot()
  await post(composition, OPEN, startBody('idem-1'))
  const agent = composition.live
  expect(agent).toBeDefined()
  composition.calls.length = 0

  const second = await post(composition, OPEN, startBody('idem-1', { prompt: 'state check, not a restart' }))
  expect(second.status).toBe(200)
  expect(second.json['sessionId']).toBe('dsh-debate-idem-1')
  expect(composition.calls.some(call => call.what === 'agents.create')).toBe(false)
  expect(composition.calls.some(call => call.what === 'agents.resume')).toBe(false)
  expect(composition.calls.some(call => call.what === 'permissionPresets.set')).toBe(false)
  // The adopt path IS the nudge: the verb is reused, and whatever prompt it is
  // handed is what gets admitted.
  expect(agent?.followups).toHaveLength(2)
  expect(agent?.followups[1]?.content[0]?.text).toBe('state check, not a restart')
}, 60_000)

test('a cold-but-persisted id falls through to resume, never to a 5xx', async () => {
  composition = await boot()
  const resumed = fakeAgent('dsh-debate-cold-1', 'idle')
  composition.resumeWith = resumed
  const opened = await post(composition, OPEN, startBody('cold-1'))
  expect(opened.status).toBe(200)
  expect(opened.json['sessionId']).toBe('dsh-debate-cold-1')
  expect(composition.calls.some(call => call.what === 'agents.resume')).toBe(true)
  expect(composition.calls.some(call => call.what === 'agents.create')).toBe(false)
  expect(resumed.followups).toHaveLength(1)
}, 60_000)

test('a lost create race maps SessionAlreadyExistsError onto the adopt branch', async () => {
  composition = await boot()
  // `resume` reports the id absent, `create` then reports it occupied — the
  // residual race `SessionStore.prepare` cannot close. The first `agents.get`
  // is scripted to see nothing; the check after the failed create sees the
  // winner, which is exactly what the real registry would show.
  composition.createThrows = new SessionAlreadyExistsError('dsh-debate-race-1' as never)
  const race = fakeAgent('dsh-debate-race-1', 'idle')
  composition.live = race
  composition.getAnswers.push(undefined)

  const opened = await post(composition, OPEN, startBody('race-1'))
  expect(opened.status).toBe(200)
  expect(opened.json['sessionId']).toBe('dsh-debate-race-1')
  expect(race.followups).toHaveLength(1)
}, 60_000)

test('stop cancels a live session and tolerates an already-gone one', async () => {
  composition = await boot()
  await post(composition, OPEN, startBody('stop-1'))
  const agent = composition.live
  const stopped = await post(composition, STOP, { sessionId: 'dsh-debate-stop-1' })
  expect(stopped.json).toEqual({ stopped: true })
  expect(agent?.cancels).toEqual(['user'])

  const gone = await post(composition, STOP, { sessionId: 'dsh-debate-never-existed' })
  expect(gone.status).toBe(200)
  expect(gone.json).toEqual({ stopped: false })
}, 60_000)

test('idle is an observed status edge, never an elapsed-time predicate', async () => {
  composition = await boot()
  await post(composition, OPEN, startBody('idle-1'))
  const agent = composition.live
  expect(agent).toBeDefined()

  // `followup` wakes the driver, so the session is mid-turn: not idle.
  agent?.emitStatus('running')
  let status = await post(composition, STATUS, { sessionId: 'dsh-debate-idle-1' })
  expect(status.json['live']).toBe(true)
  expect(status.json['idle']).toBe(false)
  expect(typeof status.json['lastActivityAt']).toBe('string')

  // A turn-end edge flips it. Nothing about elapsed time is consulted, so a
  // session blocked inside a long `aw debate wait` — which emits no turn-end —
  // cannot be reported idle however long it stays there.
  agent?.emitStatus('idle')
  status = await post(composition, STATUS, { sessionId: 'dsh-debate-idle-1' })
  expect(status.json['idle']).toBe(true)
  expect(typeof status.json['lastActivityAt']).toBe('string')

  // Back mid-turn: the predicate follows edges in both directions.
  agent?.emitStatus('running')
  status = await post(composition, STATUS, { sessionId: 'dsh-debate-idle-1' })
  expect(status.json['idle']).toBe(false)

  // A dead session is neither live nor idle.
  composition.live = undefined
  status = await post(composition, STATUS, { sessionId: 'dsh-debate-idle-1' })
  expect(status.json['live']).toBe(false)
  expect(status.json['idle']).toBe(false)
}, 60_000)

test('the loopback self-check refuses to register on a non-loopback host', async () => {
  const built: unknown = await import(pathToFileURL(builtEntry).href)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

  /** Mount the built plugin directly against a stub webServer reporting `host`. */
  const mount = async (host: string): Promise<string[]> => {
    const ctx = new Context()
    const paths: string[] = []
    provide(ctx, 'webServer', {
      host,
      register(route: { path: string }) {
        paths.push(route.path)
        return () => {}
      },
    })
    provide(ctx, 'agents', { get: () => undefined })
    provide(ctx, 'workspaceRegistry', { create: async () => ({ path: '/x', attachSession: async () => {} }) })
    provide(ctx, 'permissionPresets', { defaultPreset: 'workspace-write', resolve: () => ({}), set: () => {} })
    provide(ctx, 'sessionTitle', { rename: () => {} })
    provide(ctx, 'agentPresets', { resolve: async (id: string) => ({ id }) })
    await ctx.plugin(built as never, undefined as never)
    await ctx.fiber.dispose()
    return paths
  }

  // Positive control first: the SAME direct mount registers all three routes on
  // loopback, so an empty list below is caused by the host and not by a mount
  // that never succeeded.
  const loopback = await mount('127.0.0.1')
  expect(loopback.sort()).toEqual([OPEN, STOP, STATUS].sort())

  const refused = await mount('0.0.0.0')
  expect(refused).toEqual([])
  const written = stderr.mock.calls.map(call => String(call[0])).join('')
  expect(written).toContain('refusing to register')
  expect(written).toContain('0.0.0.0')
}, 60_000)

test('no provider name is hard-coded into the plugin surface', async () => {
  // The plugin is provider-agnostic by contract; the debate-server side owns the
  // `dsh` name. A name leaking in here would couple the two halves.
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
  const sources = walk(join(packageRoot, 'src')).map(file => readFileSync(file, 'utf8')).join('\n')
  expect(sources).not.toContain('opencode-cli')
  expect(sources).not.toContain('claude-cli')
  expect(sources).not.toContain('codex-cli')
})
