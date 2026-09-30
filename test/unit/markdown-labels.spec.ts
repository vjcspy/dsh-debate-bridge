/**
 * The Markdown chrome adapter.
 *
 * `MarkdownText` is Cordis-free and owns no fallback copy, so a label this
 * adapter fails to request renders as empty chrome inside a card — a fence whose
 * copy button has no caption, a footnote section with no heading. Every required
 * label is therefore named here, key by key, rather than sampled.
 */
import { describe, expect, test } from 'vitest'

import { en, type DebateArenaTranslate } from '../../src/client/locale.ts'
import { markdownLabels } from '../../src/client/markdown-labels.ts'

/** The dictionary as a plain lookup, so a missing key is visible instead of thrown. */
const dict: Record<string, string> = en

/**
 * One translate seat that records the keys it was asked for.
 * @returns the seat and its record, fresh per test so order cannot leak between them.
 */
function recorder(): { readonly t: DebateArenaTranslate; readonly keys: string[] } {
  const keys: string[] = []
  const t: DebateArenaTranslate = (key) => {
    keys.push(key)
    return dict[key] ?? key
  }
  return { t, keys }
}

describe('markdownLabels', () => {
  test('requests every chrome key the primitive requires, and no other', () => {
    const { t, keys } = recorder()
    markdownLabels(t)
    expect(keys).toEqual([
      'markdown.code.copy',
      'markdown.code.copied',
      'markdown.code.title',
      'markdown.code.wrap',
      'markdown.code.unwrap',
      'markdown.footnotes',
    ])
  })

  test('builds the complete object the primitive declares', () => {
    const { t } = recorder()
    expect(markdownLabels(t)).toEqual({
      code: {
        copyLabel: 'Copy',
        copiedLabel: 'Copied',
        toolbarLabels: { codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines' },
      },
      footnotes: 'Footnotes',
    })
  })

  test('resolves every label from the dictionary instead of echoing the key', () => {
    const { t } = recorder()
    const labels = markdownLabels(t)
    const values = [
      labels.code.copyLabel,
      labels.code.copiedLabel,
      labels.code.toolbarLabels?.codeLabel,
      labels.code.toolbarLabels?.wrapLabel,
      labels.code.toolbarLabels?.unwrapLabel,
      labels.footnotes,
    ]
    for (const value of values) {
      expect(value).not.toBeUndefined()
      expect(value).not.toMatch(/^markdown\./)
      expect(value?.trim()).not.toBe('')
    }
  })
})
