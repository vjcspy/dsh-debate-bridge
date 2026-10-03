/**
 * The transcript buffer: watermark arithmetic, text hygiene, and the line window.
 *
 * The cases that matter are the ones a naive implementation gets wrong, and each
 * is a measured property of the real stream rather than a hypothetical:
 *
 * - `claude-cli` emits one entry per `text_delta`, so many entries share one
 *   millisecond, and the debate server filters with a STRICT `>` over raw
 *   timestamp strings. Watermarking on the newest timestamp alone therefore
 *   drops the siblings of that millisecond — the regression this buffer exists
 *   to prevent.
 * - Byte-identical entries occur in a real capture, so de-duplication must be
 *   positional. A content key would eat a legitimately repeated line.
 * - A response is applied against the buffer's CURRENT state, so two overlapping
 *   responses must produce neither a duplicate nor a loss in EITHER order.
 */
import { describe, expect, test } from 'vitest'

import type { ProviderOutputEntry } from '../../src/client/lib/debate-api.ts'
import {
  clampEntry,
  createTranscriptBuffer,
  minusMilliseconds,
  normalizeNewlines,
  stripAnsi,
  type TranscriptBuffer,
} from '../../src/client/lib/transcript-buffer.ts'

/** A buffer with the production bounds, except where a case narrows them. */
function buffer(overrides: Partial<Parameters<typeof createTranscriptBuffer>[0]> = {}): TranscriptBuffer {
  return createTranscriptBuffer({
    maxLines: 1000,
    entryMaxChars: 4000,
    elision: '…',
    backoffMs: 1,
    ...overrides,
  })
}

/** One provider-output entry. */
function entry(timestamp: string, content: string, type = 'terminal'): ProviderOutputEntry {
  return { timestamp, type, content }
}

/** The text of every retained line, oldest first. */
function texts(target: TranscriptBuffer): string[] {
  return target.snapshot().lines.map(line => line.text)
}

describe('watermark', () => {
  test('asks for the whole buffer until something has been consumed', () => {
    expect(buffer().request().since).toBeUndefined()
  })

  test('backs off exactly one millisecond from the newest timestamp', () => {
    const target = buffer()
    target.accept([entry('2026-10-03T04:52:36.284Z', 'one')])
    expect(target.request().since).toBe('2026-10-03T04:52:36.283Z')
  })

  test('the back-off survives the second boundary and keeps the ISO width', () => {
    // A naive `-1` on the seconds field, or a local-time reformat, breaks here.
    expect(minusMilliseconds('2026-10-03T04:52:36.000Z', 1)).toBe('2026-10-03T04:52:35.999Z')
    const eased = minusMilliseconds('2026-10-03T04:52:36.284Z', 1)
    expect(eased).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test('keeps every sibling of a shared millisecond, exactly once', () => {
    const target = buffer()
    const shared = '2026-10-03T04:53:57.561Z'
    target.accept([entry(shared, 'first')])
    expect(texts(target)).toEqual(['first'])

    // What the server returns for `since = shared - 1ms`: the whole millisecond
    // again, plus the one entry that followed it.
    target.accept([
      entry(shared, 'first'),
      entry(shared, 'second'),
      entry(shared, 'third'),
    ])
    // The already-consumed `first` is dropped positionally; the siblings survive.
    expect(texts(target)).toEqual(['first', 'second', 'third'])
    expect(target.request().since).toBe('2026-10-03T04:53:57.560Z')
  })

  test('a millisecond that gains entries between reads keeps them all', () => {
    const target = buffer()
    const shared = '2026-10-03T05:00:00.000Z'
    target.accept([entry(shared, 'a')])
    target.accept([entry(shared, 'a')])
    expect(texts(target)).toEqual(['a'])
    target.accept([entry(shared, 'a'), entry(shared, 'b')])
    expect(texts(target)).toEqual(['a', 'b'])
    target.accept([entry(shared, 'a'), entry(shared, 'b'), entry(shared, 'c')])
    expect(texts(target)).toEqual(['a', 'b', 'c'])
  })
})

describe('positional de-duplication', () => {
  test('byte-identical entries are kept apart, never collapsed', () => {
    const target = buffer()
    const timestamp = '2026-10-03T04:52:40.000Z'
    const repeated = '\r\n\u001b[36m[tool] Bash\u001b[0m\r\n'
    target.accept([entry(timestamp, repeated), entry(timestamp, repeated)])
    const lines = texts(target)
    // Three lines per entry, and BOTH entries survive: a content-keyed dedupe
    // would have eaten the second, which is a real capture's shape.
    expect(lines).toHaveLength(6)
    expect(lines.filter(text => text === '[tool] Bash')).toHaveLength(2)
  })

  test('two overlapping responses in EITHER order neither duplicate nor lose', () => {
    const early = [
      entry('2026-10-03T04:52:32.034Z', 'one'),
      entry('2026-10-03T04:52:32.034Z', 'two'),
      entry('2026-10-03T04:52:33.000Z', 'three'),
    ]
    const late = [...early, entry('2026-10-03T04:52:34.000Z', 'four')]

    const forward = buffer()
    forward.accept(early)
    forward.accept(late)
    expect(texts(forward)).toEqual(['one', 'two', 'three', 'four'])

    const reverse = buffer()
    reverse.accept(late)
    reverse.accept(early)
    expect(texts(reverse)).toEqual(['one', 'two', 'three', 'four'])
  })
})

describe('text hygiene', () => {
  test('strips ANSI SGR wrappers', () => {
    expect(stripAnsi('\u001b[36m[tool] Bash\u001b[0m')).toBe('[tool] Bash')
    expect(stripAnsi('\u001b[90m[tool result] 12 lines\u001b[0m')).toBe('[tool result] 12 lines')
  })

  test('normalises CRLF and a lone CR to a single newline', () => {
    expect(normalizeNewlines('a\r\nb')).toBe('a\nb')
    expect(normalizeNewlines('a\rb')).toBe('a\nb')
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc')
  })

  test('a CRLF-framed entry becomes the lines it visually is', () => {
    const target = buffer()
    target.accept([entry('2026-10-03T04:52:32.034Z', '\r\n\u001b[36m[tool] Bash\u001b[0m\r\n')])
    expect(texts(target)).toEqual(['', '[tool] Bash', ''])
  })

  test('an error entry with a bare newline keeps its line count', () => {
    const target = buffer()
    target.accept([entry('2026-10-03T04:52:32.034Z', 'boom\nsecond line', 'error')])
    expect(texts(target)).toEqual(['boom', 'second line'])
    expect(target.snapshot().lines.map(line => line.type)).toEqual(['error', 'error'])
  })
})

describe('per-entry clamp', () => {
  test('keeps head and tail inside the exact character budget', () => {
    const body = 'HEAD'.repeat(50) + 'TAIL'.repeat(50)
    const clamped = clampEntry(body, 40, '…')
    expect(clamped).toHaveLength(40)
    expect(clamped.startsWith('HEAD')).toBe(true)
    expect(clamped.endsWith('TAIL')).toBe(true)
    expect(clamped).toContain('…')
  })

  test('an entry inside the budget is untouched', () => {
    expect(clampEntry('short', 40, '…')).toBe('short')
  })

  test('clamping happens BEFORE the global line cap, so prose survives a big entry', () => {
    // One oversized tool result must not evict the lines around it: clamped to a
    // handful of lines, it leaves room for everything else inside the cap.
    const target = buffer({ maxLines: 20, entryMaxChars: 12, elision: '…' })
    const huge = Array.from({ length: 500 }, (_, index) => `line ${String(index)}`).join('\n')
    target.accept([entry('2026-10-03T04:52:32.034Z', 'before')])
    target.accept([entry('2026-10-03T04:52:33.000Z', huge)])
    target.accept([entry('2026-10-03T04:52:34.000Z', 'after')])
    expect(texts(target)).toContain('before')
    expect(texts(target)).toContain('after')
    expect(texts(target).length).toBeLessThanOrEqual(20)
  })
})

describe('line window', () => {
  test('drops the OLDEST lines once the cap is reached', () => {
    const target = buffer({ maxLines: 3 })
    target.accept([entry('2026-10-03T04:52:32.034Z', 'a\nb\nc\nd\ne')])
    expect(texts(target)).toEqual(['c', 'd', 'e'])
  })

  test('reset clears the watermark and every line', () => {
    const target = buffer()
    target.accept([entry('2026-10-03T04:52:32.034Z', 'one')])
    expect(target.reset()).toEqual({ lines: [], watermark: undefined })
    expect(target.request().since).toBeUndefined()
    expect(target.snapshot().lines).toEqual([])
  })

  test('a full replay is requested after a reset', () => {
    const target = buffer()
    target.accept([entry('2026-10-03T04:52:32.034Z', 'one')])
    expect(target.request().since).toBeDefined()
    target.reset()
    expect(target.request()).toEqual({ since: undefined })
  })

  test('every line carries a stable, unique key so the renderer can key on it', () => {
    const target = buffer()
    target.accept([entry('2026-10-03T04:52:32.034Z', 'a\nb')])
    target.accept([entry('2026-10-03T04:52:33.000Z', 'a\nb')])
    const keys = target.snapshot().lines.map(line => line.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
