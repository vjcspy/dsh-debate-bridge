/**
 * One conversation card's body: the entry's own Markdown, rendered as elements.
 *
 * The card content is model-authored Markdown, so it goes through the core
 * `MarkdownText` primitive rather than being printed as pre-wrapped source. That
 * primitive is the safety boundary too: raw HTML renders as literal text and
 * non-`http`/`https`/`mailto` destinations are emptied, so this half inherits
 * that bound instead of owning a sanitizer.
 *
 * Hook-free by design. `labels` must be reference-stable — a new identity
 * discards the primitive's streaming render cache and defeats its `memo`
 * shallow compare — so the body builds one object per locale revision and
 * threads it down as a prop instead of rebuilding it here.
 *
 * `variant="compact"` is the card scale. `streaming` stays at its default,
 * because a persisted argument is settled content.
 *
 * @module dsh-debate-bridge/client/EntryBody
 */
import type { ReactElement } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** One entry's content, and the chrome copy its Markdown renders with. */
export interface EntryBodyProps {
  /** The entry's Markdown source, verbatim from the debate server. */
  readonly content: string
  /** Localized Markdown chrome, reference-stable per locale revision. */
  readonly labels: MarkdownLabels
}

/**
 * Render one entry's Markdown.
 * @param props - the entry's source and the shared chrome labels.
 * @returns the rendered Markdown tree.
 */
export function EntryBody({ content, labels }: EntryBodyProps): ReactElement {
  return <MarkdownText text={content} labels={labels} variant="compact" />
}
