/**
 * The bridge's HTTP surface, over the BUILT artifact and a real `WebServer`.
 *
 * Positive and negative control live in one file on purpose: "the routes
 * register" is not evidence unless the same request is also shown to be ABSENT
 * without the plugin entry, since a 404-vs-200 distinction is the only thing
 * that separates a mounted route from a coincidental response.
 */

import { afterEach, expect, test } from 'vitest'
import { boot, patchFileText, post, startBody, type Composition } from './harness.ts'

const OPEN = '/dsh-debate/opponent'
const STOP = '/dsh-debate/opponent/stop'
const STATUS = '/dsh-debate/opponent/status'
const MODELS = '/dsh-debate/models'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.dispose()
  composition = undefined
})

test('the built plugin composes through a real cordis.yml with no unloaded entry', async () => {
  composition = await boot()
  const unloaded = [...composition.ctx.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
}, 60_000)

test('all three verbs answer, over real HTTP, on the built artifact', async () => {
  composition = await boot()

  const status = await post(composition, STATUS, { sessionId: 'dsh-debate-absent' })
  expect(status.status).toBe(200)
  // No live Agent: `live` false and `idle` false, because idleness is a
  // property of a driver that exists.
  expect(status.json).toEqual({ live: false, idle: false, lastActivityAt: null })

  const stop = await post(composition, STOP, { sessionId: 'dsh-debate-absent' })
  expect(stop.status).toBe(200)
  // An already-gone session is an idempotent success, never an error.
  expect(stop.json).toEqual({ stopped: false })

  const opened = await post(composition, OPEN, startBody('surface-1'))
  expect(opened.status).toBe(200)
  expect(opened.json['sessionId']).toBe('dsh-debate-surface-1')
}, 60_000)

test('the same three requests are ABSENT without the plugin entry (negative control)', async () => {
  composition = await boot({ withBridge: false })
  for (const path of [OPEN, STOP, STATUS]) {
    const response = await post(composition, path, startBody('surface-1', { sessionId: 'dsh-debate-absent' }))
    // `WebServer` answers 404 when no named route matches and no fallback owns
    // the seat, so 404 is exactly "the bridge did not register".
    expect(response.status, `${path} must be absent`).toBe(404)
  }
}, 60_000)

test('the models verb answers a GET with the host catalog, and is absent without the plugin', async () => {
  composition = await boot()

  const response = await fetch(`http://127.0.0.1:${String(composition.port)}${MODELS}`)
  expect(response.status).toBe(200)
  const body = await response.json() as { models: { value: string; label: string }[]; failures: unknown[] }
  // The projection mirrors the GUI picker's: `provider/model` as the value, and
  // the model's own display name plus its provider as the label.
  expect(body.models).toEqual([
    { value: 'deepseek-official/deepseek-v4-flash', label: 'DeepSeek V4 Flash (deepseek-official)' },
  ])
  expect(body.failures).toEqual([])

  // A POST to a GET-only verb is refused like the reverse case elsewhere.
  const wrongMethod = await fetch(`http://127.0.0.1:${String(composition.port)}${MODELS}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('allow')).toBe('GET')

  await composition.dispose()
  composition = await boot({ withBridge: false })
  const absent = await fetch(`http://127.0.0.1:${String(composition.port)}${MODELS}`)
  expect(absent.status).toBe(404)
}, 60_000)

test('a provider whose catalog fails is isolated, and the failure is reported', async () => {
  composition = await boot()
  composition.llm.providers = [
    { id: 'deepseek-official', name: 'DeepSeek Official', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] },
    // A route whose adapter is registered but whose model discovery is broken.
    { id: 'broken', name: 'Broken', models: [], brokenModels: true },
  ]

  const response = await fetch(`http://127.0.0.1:${String(composition.port)}${MODELS}`)
  expect(response.status).toBe(200)
  const body = await response.json() as {
    models: { value: string }[]
    failures: { id: string; name: string; message: string }[]
  }

  // One broken adapter must not take the whole catalog down: the healthy
  // provider is still listed, and the failure is REPORTED rather than swallowed.
  expect(body.models).toEqual([
    { value: 'deepseek-official/deepseek-v4-flash', label: 'DeepSeek V4 Flash (deepseek-official)' },
  ])
  expect(body.failures).toHaveLength(1)
  expect(body.failures[0]?.id).toBe('broken')
  expect(body.failures[0]?.message).toContain('discovery failed')
}, 60_000)

test('only POST is accepted, and every refusal carries a machine-readable error body', async () => {
  composition = await boot()

  const wrongMethod = await fetch(`http://127.0.0.1:${String(composition.port)}${OPEN}`)
  expect(wrongMethod.status).toBe(405)
  expect(wrongMethod.headers.get('allow')).toBe('POST')

  const notJson = await post(composition, OPEN, 'not json at all')
  expect(notJson.status).toBe(400)
  expect(notJson.json['error']).toBe('request body must be a JSON object')

  const arrayBody = await post(composition, OPEN, [1, 2, 3])
  expect(arrayBody.status).toBe(400)
  expect(arrayBody.json['error']).toBe('request body must be a JSON object')

  const blank = await post(composition, OPEN, startBody('surface-1', { prompt: '   ' }))
  expect(blank.status).toBe(400)
  expect(blank.json['error']).toBe('prompt must not be blank')

  const typed = await post(composition, OPEN, startBody('surface-1', { title: 9 }))
  expect(typed.status).toBe(400)
  expect(typed.json['error']).toBe('title must be a string')

  const badId = await post(composition, OPEN, startBody('../escape'))
  expect(badId.status).toBe(400)
  expect(String(badId.json['error'])).toContain('debateId must match')

  // An unknown preset name is refused, never silently ignored.
  const unknownPermission = await post(composition, OPEN, startBody('surface-1', { permissionPreset: 'yolo' }))
  expect(unknownPermission.status).toBe(400)
  expect(String(unknownPermission.json['error'])).toContain('unknown permissionPreset')
  expect(String(unknownPermission.json['error'])).toContain('yolo')

  const unknownAgent = await post(composition, OPEN, startBody('surface-1', { agentPreset: 'nope' }))
  expect(unknownAgent.status).toBe(400)
  expect(String(unknownAgent.json['error'])).toContain('unknown agentPreset')
}, 60_000)

test('an oversized body is refused with 413 rather than buffered', async () => {
  composition = await boot()
  const huge = await post(composition, OPEN, JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))
  expect(huge.status).toBe(413)
  expect(String(huge.json['error'])).toContain('exceeds')
}, 60_000)

test('the bundle patch and the generated config describe the same entry shape', () => {
  const patch = patchFileText()
  expect(patch).toContain('id: dsh-debate-bridge')
  expect(patch).toContain("name: 'dsh-debate-bridge'")
  // No `config` row: every input arrives in the request body.
  expect(patch).not.toContain('config:')
})
