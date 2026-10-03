/**
 * The provider-output read: the array envelope, the decoder, and the fixture.
 *
 * Pinned to the DERIVED fixture in `test/fixtures/provider-output-structure.json`,
 * which preserves the real capture's structure — timestamps (including a cluster
 * of ten entries inside one millisecond), the real `type` sequence, real ANSI SGR
 * plus `\r\n` framing, one `error` entry with a bare `\n`, byte-identical entries
 * and one oversized entry — while every `content` body is synthetic text of the
 * same length. The raw capture is host-local evidence and is never committed;
 * the last block of this file is the gate that keeps it that way.
 *
 * The array payload is the trap this file exists to lock: the shared envelope
 * reader used to require `isRecord(body['data'])`, and `isRecord` rejects arrays,
 * so the provider-output read could never have travelled through it.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { DETAIL_ID_PARAM, PROVIDER_OUTPUT_PATH, PROVIDER_OUTPUT_SINCE_PARAM } from '../../src/config.ts'
import { fetchProviderOutput, type ProviderOutputEntry } from '../../src/client/lib/debate-api.ts'

const FIXTURE_PATH = 'test/fixtures/provider-output-structure.json'
const FIXTURE_SOURCE = readFileSync(FIXTURE_PATH, 'utf8')
const FIXTURE: { success: true; data: ProviderOutputEntry[] } = JSON.parse(FIXTURE_SOURCE)

/** A debate id of the shape the fenced route accepts. */
const DEBATE_ID = '46986e62-703d-4ace-9bc0-1adbab8f5507'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

/**
 * Answer every read with one body, and record the URLs asked for.
 * @param body - raw response body.
 * @param status - response status.
 * @returns the recorded request URLs.
 */
function stubFetch(body: string, status = 200): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input))
    return new Response(body, { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return seen
}

describe('the derived fixture', () => {
  test('is the real envelope and the real entry count', () => {
    expect(FIXTURE.success).toBe(true)
    expect(Array.isArray(FIXTURE.data)).toBe(true)
    expect(FIXTURE.data).toHaveLength(176)
    expect(Object.keys(FIXTURE.data[0]!).sort()).toEqual(['content', 'timestamp', 'type'])
  })

  test('keeps the real type sequence and the three observed types', () => {
    const counts = FIXTURE.data.reduce<Record<string, number>>((acc, item) => {
      acc[item.type] = (acc[item.type] ?? 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({ status: 3, terminal: 172, error: 1 })
    expect(FIXTURE.data.slice(0, 3).map(item => item.type)).toEqual(['status', 'status', 'status'])
    // The one `error` entry is the twenty-second, as in the capture.
    expect(FIXTURE.data[21]!.type).toBe('error')
  })

  test('keeps every timestamp verbatim, including the ten-in-one-millisecond cluster', () => {
    for (const item of FIXTURE.data) {
      expect(item.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    const perMillisecond = new Map<string, number>()
    for (const item of FIXTURE.data) {
      perMillisecond.set(item.timestamp, (perMillisecond.get(item.timestamp) ?? 0) + 1)
    }
    expect(perMillisecond.size).toBe(129)
    const clusters = [...perMillisecond.values()].filter(count => count > 1)
    expect(clusters).toHaveLength(16)
    expect(Math.max(...clusters)).toBe(10)
    // Sorted, which is what makes the strict `>` filter usable at all.
    const timestamps = FIXTURE.data.map(item => item.timestamp)
    expect([...timestamps].sort()).toEqual(timestamps)
  })

  test('keeps the ANSI and CRLF framing, the bare newline, the duplicates and the oversized entry', () => {
    expect(FIXTURE.data.filter(item => item.content.includes('\u001b')).length).toBe(104)
    expect(FIXTURE.data.filter(item => item.content.includes('\r\n')).length).toBe(104)
    expect(FIXTURE.data.filter(item => /\r(?!\n)/.test(item.content))).toHaveLength(0)
    expect(FIXTURE.data.filter(item => item.type === 'error' && /\n/.test(item.content) && !item.content.includes('\r')))
      .toHaveLength(1)

    // Byte-identical entries are a real property, and positional de-duplication
    // exists because of them.
    const groups = new Map<string, number>()
    for (const item of FIXTURE.data) {
      const key = `${item.type}\u0000${item.content}`
      groups.set(key, (groups.get(key) ?? 0) + 1)
    }
    const duplicates = [...groups.values()].filter(count => count > 1)
    expect(duplicates.length).toBeGreaterThanOrEqual(1)
    expect(Math.max(...duplicates)).toBeGreaterThanOrEqual(2)

    const longest = FIXTURE.data.reduce((a, b) => (a.content.length >= b.content.length ? a : b))
    expect(longest.content.length).toBe(38_771)
    // The longest entry and the multi-line entry are DIFFERENT entries: 38,771
    // characters of tool result, and separately a 451-newline body. Both bounds
    // are what the per-entry clamp exists for.
    const mostLines = Math.max(...FIXTURE.data.map(item => (item.content.match(/\n/g) ?? []).length))
    expect(mostLines).toBe(451)
  })

  test('carries no local identity or non-public workspace content', () => {
    // The raw capture holds absolute home paths and excerpts from other
    // workspaces; every repo in this domain is public and publication is
    // permanent, so this gate runs on the fixture before it can be staged.
    for (const forbidden of ['P823468', '/Users/', '.aweave/', 'resources/workspaces']) {
      expect(FIXTURE_SOURCE.includes(forbidden), forbidden).toBe(false)
    }
  })
})

describe('fetchProviderOutput', () => {
  test('decodes the array envelope the object-only reader could not carry', async () => {
    const seen = stubFetch(FIXTURE_SOURCE)
    const result = await fetchProviderOutput(DEBATE_ID, undefined, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(176)
    expect(result.value[0]).toEqual(FIXTURE.data[0])
    expect(seen).toHaveLength(1)
  })

  test('sends the declared id, and NO since when the whole buffer is wanted', async () => {
    const seen = stubFetch(FIXTURE_SOURCE)
    await fetchProviderOutput(DEBATE_ID, undefined, new AbortController().signal)
    expect(seen[0]).toBe(`${PROVIDER_OUTPUT_PATH}?${DETAIL_ID_PARAM}=${DEBATE_ID}`)
    expect(seen[0]!.includes(PROVIDER_OUTPUT_SINCE_PARAM)).toBe(false)
  })

  test('sends the watermark verbatim when one is given', async () => {
    const seen = stubFetch(FIXTURE_SOURCE)
    const since = '2026-10-03T04:53:57.560Z'
    await fetchProviderOutput(DEBATE_ID, since, new AbortController().signal)
    expect(seen[0]).toBe(
      `${PROVIDER_OUTPUT_PATH}?${DETAIL_ID_PARAM}=${DEBATE_ID}&${PROVIDER_OUTPUT_SINCE_PARAM}=${encodeURIComponent(since)}`,
    )
  })

  test('drops a malformed row while the rest of the array survives', async () => {
    stubFetch(JSON.stringify({
      success: true,
      data: [
        { timestamp: '2026-10-03T04:52:32.034Z', type: 'terminal', content: 'kept' },
        { timestamp: '2026-10-03T04:52:33.000Z', type: 'terminal' },
        { type: 'terminal', content: 'no timestamp' },
        'not an object',
        null,
        { timestamp: 7, type: 'terminal', content: 'wrong type' },
        { timestamp: '2026-10-03T04:52:34.000Z', type: 'terminal', content: 'also kept' },
      ],
    }))
    const result = await fetchProviderOutput(DEBATE_ID, undefined, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map(item => item.content)).toEqual(['kept', 'also kept'])
  })

  test('an empty buffer is a success, not a failure', async () => {
    stubFetch('{"success":true,"data":[]}')
    const result = await fetchProviderOutput(DEBATE_ID, undefined, new AbortController().signal)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([])
  })

  test('a non-array payload is malformed rather than silently empty', async () => {
    stubFetch('{"success":true,"data":{"entries":[]}}')
    const result = await fetchProviderOutput(DEBATE_ID, undefined, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('malformed')
  })

  test("a 400 refusal carries the Host's own reason", async () => {
    stubFetch('{"success":false,"error":{"code":"INVALID_INPUT","message":"since must be a millisecond-precision UTC timestamp"}}', 400)
    const result = await fetchProviderOutput(DEBATE_ID, 'not-a-date', new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('refused')
    expect(result.failure.status).toBe(400)
    expect(result.failure.message).toContain('millisecond-precision')
  })

  test('a body that is not the envelope is malformed', async () => {
    stubFetch('{"data":[]}')
    const result = await fetchProviderOutput(DEBATE_ID, undefined, new AbortController().signal)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.kind).toBe('malformed')
  })
})
