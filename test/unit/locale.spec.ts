/**
 * The Debate Arena dictionary.
 *
 * Every product-visible string on this surface resolves through `t`, and the
 * Markdown primitive renders whatever this dictionary hands it. A key that
 * exists but is blank renders as an empty control; a key the components ask for
 * but the dictionary lacks falls through to the key itself. Both are asserted
 * here, so a missing rail or chrome label fails a unit test instead of the
 * browser check.
 */
import { describe, expect, test } from 'vitest'

import { en } from '../../src/client/locale.ts'

describe('Debate Arena dictionary', () => {
  test('every key carries non-empty copy', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value, key).toBe('string')
      expect(value.trim(), key).not.toBe('')
    }
  })

  test('defines the rail, the panel header and the fields they reuse', () => {
    expect(Object.keys(en)).toEqual(expect.arrayContaining([
      'action.showList',
      'action.hideList',
      'action.closeList',
      'action.refresh',
      'arena.heading',
      'arena.total',
    ]))
  })

  test('defines the six Markdown chrome keys the primitive requires', () => {
    const chrome = [
      'markdown.code.copy',
      'markdown.code.copied',
      'markdown.code.title',
      'markdown.code.wrap',
      'markdown.code.unwrap',
      'markdown.footnotes',
    ]
    for (const key of chrome) {
      expect(Object.keys(en), key).toContain(key)
    }
  })

  test('keeps the board states the body renders', () => {
    expect(Object.keys(en)).toEqual(expect.arrayContaining([
      'state.noSelection',
      'state.transcriptLoading',
      'state.failed.title',
      'state.unauthorized.title',
      'state.gone.title',
    ]))
  })
})
