/**
 * The fenced reads' policy, without a network or a Cordis context.
 *
 * The upstream path is never caller-supplied, so the cases that matter are the
 * ones where a caller tries to make it so (an id that is not a UUID, a `..`
 * segment, an undeclared query parameter), plus the three mappings the channel
 * would otherwise get wrong: an unreachable server, a wrong verb, and an
 * unreadable body.
 */
import { describe, expect, test } from 'vitest'

import {
  ATTACH_PATH,
  DEBATE_ID_PATTERN,
  DETAIL_PATH,
  FENCED_PREFIX,
  LIST_PATH,
  PROVIDER_OUTPUT_PATH,
  PROVIDER_OUTPUT_SINCE_PARAM,
} from '../../src/config.ts'
import {
  createDebateConfirmer,
  forwardToUpstream,
  normalizeBaseUrl,
  planForward,
  refusalResponse,
  resolveAuthToken,
  type ForwardPlan,
  type UpstreamCall,
} from '../../src/host/forward.ts'

const BASE = 'http://127.0.0.1:3456'

/** A debate id of the shape every id-keyed read now demands. */
const DEBATE_ID = '46986e62-703d-4ace-9bc0-1adbab8f5507'

/** A valid watermark, in exactly the shape `new Date().toISOString()` produces. */
const SINCE = '2026-10-03T04:52:36.284Z'

/** Every fenced path that reaches the debate server. */
const FORWARDED_PATHS = [LIST_PATH, DETAIL_PATH, PROVIDER_OUTPUT_PATH]

/** Plan one request, or fail the test with the refusal it produced. */
function plan(path: string, method = 'GET'): ForwardPlan {
  const decision = planForward({ method, url: `http://host${path}` }, BASE, undefined)
  if (!decision.ok) throw new Error(`expected a plan, got ${String(decision.refusal.status)}`)
  return decision.plan
}

/** A response stand-in carrying the fields the mapping reads. */
function upstreamResponse(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } })
}

describe('route table', () => {
  test('every fenced read sits under the plugin prefix', () => {
    for (const path of [...FORWARDED_PATHS, ATTACH_PATH]) {
      expect(path.startsWith(`${FENCED_PREFIX}/`)).toBe(true)
      // The admission fence lives on `/api`; a path outside it would be served
      // with no cookie check at all.
      expect(path.startsWith('/api/')).toBe(true)
    }
  })

  test('the id pattern is anchored and case-insensitive', () => {
    // Anchoring is the property that stops a partial match from smuggling a
    // segment; case-insensitivity is what stops an upper-cased id being refused.
    expect(DEBATE_ID_PATTERN.test(DEBATE_ID)).toBe(true)
    expect(DEBATE_ID_PATTERN.test(DEBATE_ID.toUpperCase())).toBe(true)
    expect(DEBATE_ID_PATTERN.test(`${DEBATE_ID}/../../secrets`)).toBe(false)
    expect(DEBATE_ID_PATTERN.test(` ${DEBATE_ID}`)).toBe(false)
    expect(DEBATE_ID_PATTERN.test('abc-123')).toBe(false)
    expect(DEBATE_ID_PATTERN.test('..')).toBe(false)
  })
})

describe('normalizeBaseUrl', () => {
  test('strips trailing slashes and surrounding space', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:3456// ')).toBe('http://127.0.0.1:3456')
  })
})

describe('resolveAuthToken', () => {
  test('reads the named variable per call, and nothing when unset', () => {
    expect(resolveAuthToken('DEBATE_TOKEN', { DEBATE_TOKEN: 'secret' })).toBe('secret')
    expect(resolveAuthToken('DEBATE_TOKEN', {})).toBeUndefined()
    expect(resolveAuthToken('DEBATE_TOKEN', { DEBATE_TOKEN: '' })).toBeUndefined()
    expect(resolveAuthToken('  ', { '': 'nope' })).toBeUndefined()
  })
})

describe('planForward', () => {
  test('forwards the arena query string verbatim', () => {
    const plan = planForward({ method: 'GET', url: `http://host${LIST_PATH}?limit=25&offset=50` }, BASE, 'tok')
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.plan.upstreamUrl).toBe(`${BASE}/debates?limit=25&offset=50`)
    expect(plan.plan.token).toBe('tok')
  })

  test('folds the debate id into the upstream path and drops the caller query', () => {
    const plan = planForward({ method: 'GET', url: `http://host${DETAIL_PATH}?id=${DEBATE_ID}&limit=9` }, BASE, undefined)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.plan.upstreamUrl).toBe(`${BASE}/debates/${DEBATE_ID}`)
  })

  test('accepts an upper-cased id, which names the same debate', () => {
    const plan = planForward({ method: 'GET', url: `http://host${DETAIL_PATH}?id=${DEBATE_ID.toUpperCase()}` }, BASE, undefined)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.plan.upstreamUrl).toBe(`${BASE}/debates/${DEBATE_ID.toUpperCase()}`)
  })

  test('an id that is not a UUID is refused, never folded into the path', () => {
    // `..` is the measured escape: `encodeURIComponent('..') === '..'`, and
    // `new URL('http://host/debates/..').href` is the origin root. An anchored
    // UUID pattern makes every one of these unreachable.
    for (const value of ['..', 'a/b?c=d', '../providers', DEBATE_ID + '/../../secrets', 'abc-123', 'not-a-uuid']) {
      const decision = planForward(
        { method: 'GET', url: `http://host${DETAIL_PATH}?id=${encodeURIComponent(value)}` },
        BASE,
        undefined,
      )
      expect(decision.ok, value).toBe(false)
      if (decision.ok) continue
      expect(decision.refusal.status, value).toBe(400)
      expect(decision.refusal.payload.error.code, value).toBe('INVALID_INPUT')
      expect(decision.refusal.payload.error.message, value).toContain('a UUID')
    }
  })

  test('a blank or missing id is a 400, not a read of the collection', () => {
    for (const url of [`http://host${DETAIL_PATH}`, `http://host${DETAIL_PATH}?id=`, `http://host${DETAIL_PATH}?id=%20`]) {
      const decision = planForward({ method: 'GET', url }, BASE, undefined)
      expect(decision.ok).toBe(false)
      if (decision.ok) continue
      expect(decision.refusal.status).toBe(400)
      expect(decision.refusal.payload.error.code).toBe('INVALID_INPUT')
    }
  })

  test('the provider-output read appends its declared suffix after the id segment', () => {
    const plan = planForward({ method: 'GET', url: `http://host${PROVIDER_OUTPUT_PATH}?id=${DEBATE_ID}` }, BASE, undefined)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.plan.upstreamUrl).toBe(`${BASE}/debates/${DEBATE_ID}/provider/output`)
  })

  test('the provider-output read forwards the declared watermark and nothing else', () => {
    const url = `http://host${PROVIDER_OUTPUT_PATH}?id=${DEBATE_ID}&${PROVIDER_OUTPUT_SINCE_PARAM}=${encodeURIComponent(SINCE)}&limit=9&evil=1`
    const plan = planForward({ method: 'GET', url }, BASE, undefined)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    // Only `since` is declared by this row, so `limit` and `evil` are dropped:
    // a caller cannot widen the read by inventing parameters.
    expect(plan.plan.upstreamUrl).toBe(
      `${BASE}/debates/${DEBATE_ID}/provider/output?${PROVIDER_OUTPUT_SINCE_PARAM}=${encodeURIComponent(SINCE)}`,
    )
  })

  test('the provider-output read refuses a watermark that is not the exact toISOString shape', () => {
    for (const value of [
      'not-a-date',
      // Generic ISO-8601 without milliseconds is the trap: the server compares
      // raw strings, and `'.' < 'Z'`, so this value is greater than every entry
      // of that second and would silently return nothing.
      '2026-10-03T04:52:36Z',
      '2026-10-03T04:52:36.28Z',
      '2026-10-03 04:52:36.284Z',
      '2026-10-03T04:52:36.284+00:00',
    ]) {
      const decision = planForward(
        { method: 'GET', url: `http://host${PROVIDER_OUTPUT_PATH}?id=${DEBATE_ID}&${PROVIDER_OUTPUT_SINCE_PARAM}=${encodeURIComponent(value)}` },
        BASE,
        undefined,
      )
      expect(decision.ok, value).toBe(false)
      if (decision.ok) continue
      expect(decision.refusal.status, value).toBe(400)
      expect(decision.refusal.payload.error.message, value).toContain('millisecond-precision')
    }
  })

  test('a blank watermark is the same request as an absent one, and adds no parameter', () => {
    for (const url of [`http://host${PROVIDER_OUTPUT_PATH}?id=${DEBATE_ID}`, `http://host${PROVIDER_OUTPUT_PATH}?id=${DEBATE_ID}&${PROVIDER_OUTPUT_SINCE_PARAM}=`, `http://host${PROVIDER_OUTPUT_PATH}?id=${DEBATE_ID}&${PROVIDER_OUTPUT_SINCE_PARAM}=%20`]) {
      const plan = planForward({ method: 'GET', url }, BASE, undefined)
      expect(plan.ok).toBe(true)
      if (!plan.ok) return
      expect(plan.plan.upstreamUrl).toBe(`${BASE}/debates/${DEBATE_ID}/provider/output`)
    }
  })

  test('the provider-output read needs an id of its own', () => {
    const decision = planForward({ method: 'GET', url: `http://host${PROVIDER_OUTPUT_PATH}` }, BASE, undefined)
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal.status).toBe(400)
  })

  test('a wrong verb is a 405 with Allow, never the channel 404', () => {
    for (const path of FORWARDED_PATHS) {
      const decision = planForward({ method: 'POST', url: `http://host${path}` }, BASE, undefined)
      expect(decision.ok).toBe(false)
      if (decision.ok) continue
      expect(decision.refusal.status).toBe(405)
      expect(decision.refusal.allow).toBe('GET')
    }
  })

  test('a path outside the table is refused rather than proxied', () => {
    const decision = planForward({ method: 'GET', url: 'http://host/api/dsh-debate/../../secrets' }, BASE, undefined)
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.refusal.status).toBe(404)
  })
})

describe('refusalResponse', () => {
  test('is JSON, no-store, and carries Allow only on a 405', async () => {
    const allowed = refusalResponse({ status: 405, allow: 'GET', payload: { success: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'x' } } })
    expect(allowed.status).toBe(405)
    expect(allowed.headers.get('allow')).toBe('GET')
    expect(allowed.headers.get('cache-control')).toBe('no-store')
    expect(await allowed.json()).toMatchObject({ success: false })

    const gone = refusalResponse({ status: 404, allow: undefined, payload: { success: false, error: { code: 'NOT_FOUND', message: 'x' } } })
    expect(gone.headers.get('allow')).toBeNull()
  })
})

describe('forwardToUpstream', () => {
  test('passes an upstream status and body through verbatim', async () => {
    const body = '{"success":true,"data":{"debates":[],"total":0}}'
    const response = await forwardToUpstream(plan(LIST_PATH), {
      timeoutMs: 1000,
      fetch: async () => upstreamResponse(200, body),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(body)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('attaches the bearer only when one is configured', async () => {
    const seen: UpstreamCall[] = []
    const record = async (_url: string, call: UpstreamCall): Promise<Response> => {
      seen.push(call)
      return upstreamResponse(200, '{}')
    }
    await forwardToUpstream(plan(LIST_PATH), { timeoutMs: 1000, fetch: record })
    expect(seen[0]?.headers['authorization']).toBeUndefined()
    const decision = planForward({ method: 'GET', url: `http://host${LIST_PATH}` }, BASE, 'tok')
    if (!decision.ok) throw new Error('expected a plan')
    await forwardToUpstream(decision.plan, { timeoutMs: 1000, fetch: record })
    expect(seen[1]?.headers['authorization']).toBe('Bearer tok')
    expect(seen[1]?.method).toBe('GET')
  })

  test('an unreachable server is a 502 naming the URL, never an empty 200', async () => {
    const response = await forwardToUpstream(plan(LIST_PATH), {
      timeoutMs: 1000,
      fetch: async () => { throw new Error('ECONNREFUSED') },
    })
    expect(response.status).toBe(502)
    const body = await response.json() as { success: boolean; error: { code: string; message: string } }
    expect(body.success).toBe(false)
    expect(body.error.code).toBe('UPSTREAM_UNREACHABLE')
    expect(body.error.message).toContain(`${BASE}/debates`)
  })
})

describe('createDebateConfirmer', () => {
  test('accepts only a 2xx envelope that declares success', async () => {
    const accept = createDebateConfirmer({
      baseUrl: BASE,
      timeoutMs: 1000,
      token: undefined,
      fetch: async () => upstreamResponse(200, '{"success":true,"data":{}}'),
    })
    expect(await accept('d1')).toBe(true)

    const noSuccess = createDebateConfirmer({
      baseUrl: BASE,
      timeoutMs: 1000,
      token: undefined,
      fetch: async () => upstreamResponse(200, '{"data":{}}'),
    })
    expect(await noSuccess('d1')).toBe(false)

    const refused = createDebateConfirmer({
      baseUrl: BASE,
      timeoutMs: 1000,
      token: undefined,
      fetch: async () => upstreamResponse(404, '{"success":false}'),
    })
    expect(await refused('d1')).toBe(false)
  })

  test('an unreadable body or a transport failure is a non-confirmation', async () => {
    const broken = createDebateConfirmer({
      baseUrl: BASE,
      timeoutMs: 1000,
      token: undefined,
      fetch: async () => upstreamResponse(200, 'not json'),
    })
    expect(await broken('d1')).toBe(false)

    const down = createDebateConfirmer({
      baseUrl: BASE,
      timeoutMs: 1000,
      token: undefined,
      fetch: async () => { throw new Error('down') },
    })
    expect(await down('d1')).toBe(false)
  })

  test('asks the exact debate path and attaches the bearer', async () => {
    const seen: string[] = []
    const confirm = createDebateConfirmer({
      baseUrl: `${BASE}/`,
      timeoutMs: 1000,
      token: 'tok',
      fetch: async (url, call) => {
        seen.push(`${call.headers['authorization'] ?? ''} ${url}`)
        return upstreamResponse(200, '{"success":true}')
      },
    })
    expect(await confirm('a/b')).toBe(true)
    expect(seen).toEqual([`Bearer tok ${BASE}/debates/a%2Fb`])
  })
})
