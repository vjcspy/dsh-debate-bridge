/**
 * The card body's delegation to the core Markdown primitive.
 *
 * The primitive is mocked to a sentinel rather than rendered: `vitest.config.ts`
 * runs these specs under `environment: 'node'`, this plugin has neither
 * `react-dom` nor `jsdom`, and the primitive's built entry pulls CSS that no
 * current spec loads for real. What is asserted here is the seam — which
 * component receives which props, with which identity — so the claim that
 * Markdown reaches the page rests on the container browser check, not on this
 * file.
 */
import { describe, expect, test, vi } from 'vitest'

/** Element type the mocked primitive answers to; a string is a valid element type. */
const MARKDOWN_TEXT = vi.hoisted(() => 'test/MarkdownText')

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ MarkdownText: MARKDOWN_TEXT }))

import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

import { EntryBody } from '../../src/client/EntryBody.tsx'

/** One locale revision's chrome, shaped exactly as the real adapter builds it. */
const labels: MarkdownLabels = {
  code: {
    copyLabel: 'Copy',
    copiedLabel: 'Copied',
    toolbarLabels: { codeLabel: 'Code block', wrapLabel: 'Wrap lines', unwrapLabel: 'Do not wrap lines' },
  },
  footnotes: 'Footnotes',
}

describe('EntryBody', () => {
  test('renders the entry content through the core Markdown primitive', () => {
    const element = EntryBody({ content: '## Heading', labels })
    expect(element.type).toBe(MARKDOWN_TEXT)
  })

  test('passes the source, the caller\'s own labels identity, and the compact variant', () => {
    const source = '## Heading\n\n- one\n- two\n\n`code`'
    const element = EntryBody({ content: source, labels })
    expect(element.props).toEqual({ text: source, labels, variant: 'compact' })
    expect((element.props as { labels: MarkdownLabels }).labels).toBe(labels)
  })

  test('never asks the primitive to stream a settled argument', () => {
    const element = EntryBody({ content: '**bold**', labels })
    expect(element.props).not.toHaveProperty('streaming')
  })

  test('hands each entry its own content, verbatim', () => {
    const first = EntryBody({ content: '# a', labels })
    const second = EntryBody({ content: '| x | y |', labels })
    expect((first.props as { text: string }).text).toBe('# a')
    expect((second.props as { text: string }).text).toBe('| x | y |')
  })
})
