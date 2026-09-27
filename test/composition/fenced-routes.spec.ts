/**
 * The browser half's Host side, over the BUILT artifact and a real HTTP upstream.
 *
 * The channel's admission (`403` foreign `Host`, `401` without the browser
 * cookie) belongs to the shared `/api` transport and is verified in the browser;
 * what a composition test can prove — and what this file does prove — is that
 * the plugin registers THROUGH that seam rather than on `webServer`, that the
 * upstream path is never caller-supplied, and that the Session→debate attachment
 * is established end to end from an observed `aw debate create` tool result.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, expect, test } from 'vitest'

import {
  ATTACH_PATH,
  ATTACH_SESSION_PARAM,
  DETAIL_PATH,
  FENCED_PREFIX,
  LIST_PATH,
} from '../../src/config.ts'
import { boot, callFenced, type Composition } from './harness.ts'

let composition: Composition | undefined
let upstream: Upstream | undefined

afterEach(async () => {
  await composition?.dispose()
  composition = undefined
  await upstream?.close()
  upstream = undefined
})

/** One request the upstream stand-in received. */
interface UpstreamRequest {
  readonly method: string
  readonly url: string
  readonly authorization: string | undefined
}

/** A local stand-in for the debate server. */
interface Upstream {
  readonly url: string
  readonly requests: UpstreamRequest[]
  /** Script the next answers; the last one repeats. */
  script(...answers: readonly { status: number; body: string }[]): void
  /**
   * Add a REST route handler that overrides the scripted answer.
   * @param prefix - pathname prefix the handler owns.
   * @param handler - answer for a matching request.
   */
  route(prefix: string, handler: (request: UpstreamRequest) => { status: number; body: string }): void
  close(): Promise<void>
}

/**
 * Start the upstream stand-in on an ephemeral loopback port.
 * @returns the running upstream; the caller owns `close()`.
 */
async function startUpstream(): Promise<Upstream> {
  let queue: Array<{ status: number; body: string }> = [{ status: 200, body: '{"success":true,"data":{}}' }]
  const requests: UpstreamRequest[] = []
  const overrides = new Map<string, (request: UpstreamRequest) => { status: number; body: string }>()
  const server: Server = createServer((request: IncomingMessage, response) => {
    const seen: UpstreamRequest = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      authorization: request.headers.authorization,
    }
    requests.push(seen)
    const override = [...overrides.entries()].find(([prefix]) => seen.url.startsWith(prefix))
    const answer = override !== undefined
      ? override[1](seen)
      : queue.length > 1 ? queue.shift()! : queue[0]!
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(answer.body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the upstream stand-in did not bind a port')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    script: (...answers) => { queue = [...answers] },
    route: (prefix, handler) => { overrides.set(prefix, handler) },
    close: async () => { await new Promise<void>((resolve, reject) => { server.close(error => { error === undefined ? resolve() : reject(error) }) }) },
  }
}

/** Boot with the plugin pointed at the upstream stand-in. */
async function bootWithUpstream(): Promise<{ composition: Composition; upstream: Upstream }> {
  upstream = await startUpstream()
  composition = await boot({ debateServerUrl: upstream.url })
  return { composition, upstream }
}

test('registers every fenced read on the connection channel, under /api', async () => {
  const { composition: booted } = await bootWithUpstream()
  expect(booted.routes.map(route => route.path)).toEqual([LIST_PATH, DETAIL_PATH, ATTACH_PATH])
  for (const route of booted.routes) {
    expect(route.path.startsWith(`${FENCED_PREFIX}/`)).toBe(true)
    // Both channel verbs are declared so a wrong verb answers 405 rather than
    // the channel's 404, and the request body mode matches the other route
    // tables in this deployment.
    expect(route.methods).toEqual(['GET', 'POST'])
    expect(route.requestBody).toBe('buffered')
  }
}, 60_000)

test('registers nothing at all without the plugin entry (negative control)', async () => {
  composition = await boot({ withBridge: false })
  expect(composition.routes).toEqual([])
}, 60_000)

test('the arena read forwards the debate server collection with its query intact', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  server.script({ status: 200, body: '{"success":true,"data":{"debates":[],"total":7}}' })
  const response = await callFenced(booted, `${LIST_PATH}?limit=25&offset=50`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ success: true, data: { debates: [], total: 7 } })
  expect(server.requests).toEqual([
    { method: 'GET', url: '/debates?limit=25&offset=50', authorization: undefined },
  ])
}, 60_000)

test('the transcript read folds the debate id into the upstream path', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  server.route('/debates/', () => ({ status: 200, body: '{"success":true,"data":{"debate":{}}}' }))
  const response = await callFenced(booted, `${DETAIL_PATH}?id=abc-123&limit=9`)
  expect(response.status).toBe(200)
  expect(server.requests[0]?.url).toBe('/debates/abc-123')
}, 60_000)

test('a transcript read with no id is refused without reaching upstream', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  const response = await callFenced(booted, DETAIL_PATH)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } })
  expect(server.requests).toEqual([])
}, 60_000)

test('a wrong verb on a fenced read is 405 with Allow, not the channel 404', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  for (const path of [LIST_PATH, DETAIL_PATH, ATTACH_PATH]) {
    const response = await callFenced(booted, path, 'POST')
    expect(response.status, path).toBe(405)
    expect(response.headers.get('allow'), path).toBe('GET')
  }
  expect(server.requests).toEqual([])
}, 60_000)

test('an unreachable debate server is a 502, never an empty success', async () => {
  // A port nothing listens on: the origin is configured, the server is not there.
  composition = await boot({ debateServerUrl: 'http://127.0.0.1:1' })
  const response = await callFenced(composition, LIST_PATH)
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ success: false, error: { code: 'UPSTREAM_UNREACHABLE' } })
}, 60_000)

test('the attach read answers from the registry and never reaches upstream', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  const response = await callFenced(booted, `${ATTACH_PATH}?${ATTACH_SESSION_PARAM}=session-1`)
  expect(response.status).toBe(200)
  // "This Session owns no debate" is the ordinary state, so it is a 200 with a
  // null id rather than a 404 the client would have to treat as expected.
  expect(await response.json()).toEqual({
    success: true,
    data: { sessionId: 'session-1', debateId: null, observedAt: null },
  })
  expect(server.requests).toEqual([])
}, 60_000)

test('the attach read requires a sessionId', async () => {
  const { composition: booted } = await bootWithUpstream()
  const response = await callFenced(booted, ATTACH_PATH)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } })
}, 60_000)

test('an observed aw debate create attaches the debate to the emitting Session', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  // The confirmation read and the create payload both come from the same server.
  server.route('/debates/', () => ({ status: 200, body: '{"success":true,"data":{"debate":{"id":"debate-1"}}}' }))
  expect(booted.sessionListeners.length).toBeGreaterThan(0)

  const payload = [
    '{',
    '  "success": true,',
    '  "content": [{ "type": "json", "data": {',
    '    "debate_id": "debate-1",',
    '    "debate_state": "AWAITING_OPPONENT"',
    '  } }]',
    '}',
  ].join('\n')
  for (const listener of booted.sessionListeners) {
    listener({ id: 'session-1' }, {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'pnpm aw debate create --debate-id debate-1 --title t' }),
      },
    })
    listener({ id: 'session-1' }, {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: payload }] },
      },
    })
  }

  // The attachment lands asynchronously: the id is confirmed upstream first.
  await expect.poll(async () => {
    const answer = await callFenced(booted, `${ATTACH_PATH}?${ATTACH_SESSION_PARAM}=session-1`)
    return await answer.json()
  }, { timeout: 5_000 }).toMatchObject({ data: { debateId: 'debate-1' } })

  // And the debate was confirmed against the server's own detail route.
  expect(server.requests.map(request => request.url)).toContain('/debates/debate-1')
}, 60_000)

test('an unconfirmed debate id leaves the Session unattached', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  server.route('/debates/', () => ({ status: 404, body: '{"success":false,"error":{"code":"NOT_FOUND","message":"nope"}}' }))
  for (const listener of booted.sessionListeners) {
    listener({ id: 'session-1' }, {
      type: 'tool/call',
      data: { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'aw debate create --debate-id ghost' }) },
    })
    listener({ id: 'session-1' }, {
      type: 'tool/result',
      data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '{"debate_id":"ghost"}' }] } },
    })
  }
  await new Promise(resolve => setTimeout(resolve, 50))
  const answer = await callFenced(booted, `${ATTACH_PATH}?${ATTACH_SESSION_PARAM}=session-1`)
  expect(await answer.json()).toMatchObject({ data: { debateId: null } })
}, 60_000)

test('a configured bearer is attached to every upstream read', async () => {
  upstream = await startUpstream()
  composition = await boot({ debateServerUrl: upstream.url, authTokenEnv: 'DSH_DEBATE_SPEC_TOKEN' })
  await callFenced(composition, LIST_PATH)
  await callFenced(composition, `${DETAIL_PATH}?id=debate-1`)
  expect(upstream.requests.map(request => request.authorization)).toEqual([
    'Bearer spec-token',
    'Bearer spec-token',
  ])
}, 60_000)

test('the four loopback routes still register outside /api and unchanged', async () => {
  const { composition: booted, upstream: server } = await bootWithUpstream()
  // The browser half must not have moved them onto the fenced channel: their
  // caller is the `aw` CLI, which carries no browser cookie.
  expect(booted.routes.map(route => route.path).some(path => path.includes('/dsh-debate/opponent'))).toBe(false)
  expect(booted.calls.filter(call => call.what === 'connection.fetch.register').map(call => call.detail))
    .toEqual([LIST_PATH, DETAIL_PATH, ATTACH_PATH])
  expect(server.requests).toEqual([])
}, 60_000)
