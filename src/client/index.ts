/**
 * Browser half: register the Debate Arena tab kind, its body, its copy, and the
 * always-on attachment watcher.
 *
 * The type is a PAGE, not a viewer: it claims no resource address, so it declares
 * no `patterns` and is reached through `openTab('dsh-debate-arena')` — the guide
 * page's entry box, the strip's add control, or this plugin's own auto-open. Two
 * registrations share the definition's `id`: the static definition in
 * `ctx.sidebarRightTabs`, and the body in the keyed `sidebar.right.pane.tab` seat.
 *
 * `sidebarRight` is in the inject list and is the one addition beyond the sibling
 * plugins' lists: those only register a type, while this half READS
 * `ctx.sidebarRight.mounted` and calls `openTab`, which is what makes the board
 * appear without the user navigating.
 *
 * `keepMounted` stays `false`: retention is per tab, and a retained board per
 * visited tab would each hold its own polling. The manual pick survives a
 * remount through the declared store instead, and the transcript's scroll
 * position is re-derived by auto-scrolling to the newest argument on mount.
 *
 * No React is bundled and no `dsh.client.external` entry exists for it: the
 * bundle asks the shell's module table for React and its JSX runtime, which are
 * baseline rows the shell seeds once. A second React instance would break hooks.
 *
 * @module dsh-debate-bridge/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: declares the `locale` member this half reads.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: declares the `slots` member this half registers into.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: declares the `sidebarRight` member and `SidebarRightTabDefinition`.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: declares the `sessionId` session seat this half's body receives.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

import {
  ATTACH_READ_TIMEOUT_MS,
  GUIDE_ENTRY_ID,
  GUIDE_ENTRY_ORDER,
  LOCALE_NAMESPACE,
  PLUGIN_ID,
  TAB_KIND,
} from '../config.ts'
import { createAttachWatch, NARROW_MAX_WIDTH, type AttachmentRead } from './attach-watch.ts'
import { DebateArenaBody, type DebateArenaInjected } from './DebateArenaBody.tsx'
import { fetchAttachment } from './lib/debate-api.ts'
import { en } from './locale.ts'
import { createDebateSelectionStore } from './selection-store.ts'
import { installArenaStyles } from './styles.ts'

export type { DebateAttachmentSnapshot } from './attach-watch.ts'
export type { DebateArenaBodyProps, DebateArenaInjected } from './DebateArenaBody.tsx'
export type { ManualPick } from './selection-store.ts'

/**
 * Services this half reads; all four are shell-provided.
 *
 * The body's `useTabInfo`/`sessionId` seats are NOT declared here: they are the
 * slot's own declared injects, supplied by `sidebar.right.pane.tab`'s owner and
 * the Session framework.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

/**
 * Register the tab kind, its dictionaries, its stylesheet, the watcher, and its body.
 * @param ctx - browser-side plugin context owning the registry and the seats.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, 'en', en), `${PLUGIN_ID}: dictionaries`)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PLUGIN_ID,
    kind: TAB_KIND,
    keepMounted: false,
    title: () => t('tab.title'),
    guide: [{
      id: GUIDE_ENTRY_ID,
      order: GUIDE_ENTRY_ORDER,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
    }],
  }), `${PLUGIN_ID}: tab kind`)
  installArenaStyles(ctx)

  // One handle, minted here and passed to the registration: production code never
  // calls the factory outside registration.
  const selectionStore = createDebateSelectionStore()

  // The watcher runs from the apply world, not from the tab body: with the tab
  // closed nothing in a body is polling, and the Proposer trigger fires while the
  // user is already inside the Session.
  const watch = createAttachWatch({
    mounted: ctx.sidebarRight.mounted,
    openTab: () => { ctx.sidebarRight.openTab(TAB_KIND) },
    isExpanded: () => ctx.sidebarRight.isExpanded(),
    toggleExpanded: () => { ctx.sidebarRight.toggleExpanded() },
    isNarrow: () => typeof window !== 'undefined' && window.innerWidth < NARROW_MAX_WIDTH,
    readAttachment: readAttachment,
    note: message => { ctx.logger.debug(message) },
  })
  ctx.effect(() => {
    watch.start()
    return () => { watch.dispose() }
  }, `${PLUGIN_ID}: attachment watcher`)

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PLUGIN_ID,
    locale: LOCALE_NAMESPACE,
    store: selectionStore,
    // A function of the declaration's positional params; this seat's face needs no
    // per-occurrence value, so it ignores the ones the framework passes. The
    // attachment source is a singleton the watcher republishes, which is correct
    // because the controller polls for the MOUNTED Session and this seat only
    // renders for that Session; the body asserts the two agree before drawing.
    inject: (): DebateArenaInjected => ({ hooks: { debateAttach: watch.source } }),
  }, DebateArenaBody)), `${PLUGIN_ID}: arena tab body`)
}

/**
 * Read one Session's attachment through the Host's fenced path.
 *
 * The deadline is this half's own: the fenced route forwards to the debate
 * server, and a watcher that awaited a hung request forever would stop observing
 * the Session entirely.
 * @param sessionId - the Session to read.
 * @returns the read outcome; a failed read is reported, never thrown.
 */
async function readAttachment(sessionId: string): Promise<AttachmentRead> {
  const controller = new AbortController()
  const deadline = setTimeout(() => { controller.abort() }, ATTACH_READ_TIMEOUT_MS)
  try {
    const result = await fetchAttachment(sessionId, controller.signal)
    return result.ok ? { ok: true, debateId: result.value.debateId } : { ok: false, debateId: null }
  } finally {
    clearTimeout(deadline)
  }
}
