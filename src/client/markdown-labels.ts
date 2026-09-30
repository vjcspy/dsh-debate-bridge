/**
 * Localized copy adapter for the Cordis-free Markdown primitive.
 *
 * `MarkdownText` owns no fallback copy: every label it renders — the copy
 * button, its confirmation, the fence toolbar's three captions and the footnote
 * section heading — arrives as a prop. One place builds that object from this
 * plugin's own dictionary, so no component carries literal chrome.
 *
 * The two in-repo consumers (`ui-chat`, `ui-sidebar-documentpreview`) each keep
 * the same adapter next to their own locale seat; neither module is importable
 * from here, because both belong to feature plugins and UI may not cross that
 * boundary in code.
 *
 * @module dsh-debate-bridge/client/markdown-labels
 */
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

import type { DebateArenaTranslate } from './locale.ts'

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - the namespace-bound translate seat.
 * @returns labels for code fences and footnotes.
 */
export function markdownLabels(t: DebateArenaTranslate): MarkdownLabels {
  return {
    code: {
      copyLabel: t('markdown.code.copy'),
      copiedLabel: t('markdown.code.copied'),
      toolbarLabels: {
        codeLabel: t('markdown.code.title'),
        wrapLabel: t('markdown.code.wrap'),
        unwrapLabel: t('markdown.code.unwrap'),
      },
    },
    footnotes: t('markdown.footnotes'),
  }
}
