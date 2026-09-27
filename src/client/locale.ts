/**
 * Copy dictionary for the Debate Arena tab.
 *
 * Every product-visible string this plugin renders lives here and reaches a
 * component through the `t` seat; no component carries literal copy.
 * Placeholders use the locale service's `{name}` interpolation form.
 *
 * Only English ships. The locale service's lookup chain ends at `en` for every
 * active locale, so a composition running in another language still resolves
 * every key here rather than showing the key itself.
 *
 * Debate data is NOT here and must not be: a debate's title, its state token,
 * its argument types and roles, and its content are wire values, and the board
 * renders them verbatim.
 *
 * @module dsh-debate-bridge/client/locale
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Debate Arena tab title, guide entry, and the states the board renders. */
    dshDebateArena: DshDebateArenaKey
  }
}

/** English dictionary, and the namespace's key-set source of truth. */
export const en = {
  'tab.title': 'Debate Arena',
  'guide.title': 'Debate Arena',
  'guide.description': 'Follow the debates this host is running',

  'arena.heading': 'Debates',
  'arena.total': '{total} in total',
  'arena.empty.title': 'No debates yet',
  'arena.empty.detail': 'A debate appears here as soon as the debate server has one.',
  'arena.selected': 'This debate is shown',

  'action.refresh': 'Refresh',
  'action.reload': 'Reload',

  'state.loading': 'Loading…',
  'state.transcriptLoading': 'Loading the transcript…',
  'state.noSelection': 'Select a debate on the left to read its transcript.',

  'state.failed.title': 'The debate server did not answer',
  'state.failed.detail': '{message}',
  'state.unauthorized.title': 'This page may not read the debate server',
  'state.unauthorized.detail': 'The Host refused the read ({status}). Reload the Web UI and try again.',
  'state.gone.title': 'This debate is not on the server',
  'state.gone.detail': 'The debate was deleted or belongs to another deployment. Pick another one.',

  'transcript.heading': 'Transcript',
  'transcript.empty': 'This debate has no arguments yet.',
  'transcript.motion': 'Motion',
  'transcript.count': '{count} argument(s)',
  'transcript.proposer': 'Proposer: {provider}',
  'transcript.opponent': 'Opponent: {provider}',
  'transcript.unknownProvider': 'unknown',
} satisfies Record<string, string>

/** Every key the Debate Arena dictionary defines. */
export type DshDebateArenaKey = keyof typeof en

/** The namespace-bound translate seat a Debate Arena component receives. */
export type DebateArenaTranslate = PropsLocale<'dshDebateArena'>['t']
