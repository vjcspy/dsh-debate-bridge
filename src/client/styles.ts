/**
 * The Debate Arena tab's scoped stylesheet.
 *
 * One `<style>` element is created inside a `ctx.effect()`, marked with
 * `data-plugin` and `data-plugin-css`, and removed by that same effect's
 * disposer, so HMR re-activation can never accumulate nodes.
 *
 * Every rule is scoped to `[data-dsh-debate='arena']`, the marker
 * `DebateArenaBody` puts on its root, so nothing here can reach the rest of the
 * page. Colour comes from the platform's `--dsw-alias-*` theme aliases only, so
 * every state this plugin renders follows light and dark themes without a second
 * definition.
 *
 * The layout is the selected debate's transcript, the debate list when the user
 * asks for it, and the rail that owns that list — all one flex row, so the rail's
 * 40px sits inside the sidebar column instead of being added beyond it. The
 * entry body no longer pre-wraps its text: the content is Markdown, and the
 * renderer supplies its own block layout. The conversation column is a flex
 * COLUMN whose last child is the Opponent transcript footer, which keeps its own
 * bounded height while the transcript above it keeps `flex: 1`.
 *
 * @module dsh-debate-bridge/client/styles
 */
import type { Context } from '@deepseek-ai/cordis'

import { PLUGIN_ID } from '../config.ts'
import { NARROW_MAX_WIDTH } from './attach-watch.ts'

/** The body root's scoping attribute. */
export const ARENA_ROOT_ATTRIBUTE = 'data-dsh-debate'

/** The scoping attribute's value; the body sets exactly this on its root. */
export const ARENA_ROOT_VALUE = 'arena'

/**
 * The root attribute carrying the derived panel visibility.
 *
 * Distinct from any stored boolean: `DebateArenaBody` writes the state the user
 * actually sees, which is also what the narrow rule keys on.
 */
export const ARENA_EXPANDED_ATTRIBUTE = 'data-list-expanded'

/** Stylesheet identity reported through the owned style element's `data-plugin-css`. */
const STYLE_ID = `${PLUGIN_ID}/arena`

/** The tab's rules, scoped to the body's own root marker. */
const STYLESHEET = `
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] *,
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] *::before,
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] *::after { box-sizing: border-box; }

/* ── Split: the transcript, the list panel, and the rail ─────────────────── */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-split {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-arena {
  display: flex;
  flex-direction: column;
  flex: 0 0 40%;
  min-width: 0;
  min-height: 0;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: 0 0 40px;
  min-width: 0;
  min-height: 0;
  padding: 8px 0;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-rail-count {
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

/* ── Section headers ─────────────────────────────────────────────────────── */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-head-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--dsw-alias-label-secondary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-count {
  flex: none;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

/* ── Arena list ──────────────────────────────────────────────────────────── */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: var(--dsw-radius-md);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-row[data-selected='true'] {
  background: var(--dsw-alias-interactive-bg-active);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-row-title {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  line-height: 18px;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}

/* ── Transcript ──────────────────────────────────────────────────────────── */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-transcript {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px;
  overflow-y: auto;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-3);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry[data-role='proposer'] {
  border-left: 2px solid var(--dsw-alias-state-business-primary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry[data-role='opponent'] {
  border-left: 2px solid var(--dsw-alias-state-warn-primary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry[data-role='arbitrator'] {
  border-left: 2px solid var(--dsw-alias-state-success-primary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
/* The Markdown renderer owns the content's block layout, so this wrapper only
   keeps a long unbroken token inside the card. Deliberately not
   \`overflow-wrap: anywhere\`: that also feeds min-content sizing, which would
   let a rendered table's columns collapse in a narrow card. */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry-body {
  margin: 0;
  overflow-wrap: break-word;
}

/* ── Opponent transcript footer ───────────────────────────────────────────
   A fixed-basis, non-growing row after the scroller is what makes this a footer
   rather than another scroller: the transcript above keeps its own flex:1 and
   shrinks, and this row takes exactly its content height. No position:sticky is
   involved, and the parent's min-height:0 is left untouched. */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider {
  flex: 0 0 auto;
  min-width: 0;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-head:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-chevron {
  display: inline-flex;
  flex: none;
  transition: transform 120ms ease;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-chevron[data-open='true'] {
  transform: rotate(90deg);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-title {
  flex: none;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-status {
  flex: 1;
  min-width: 0;
  text-align: right;
  color: var(--dsw-alias-label-tertiary);
}
/* Bounded height, so an expanded panel can never take the conversation column
   from the transcript it sits under. */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-body {
  max-height: 240px;
  padding: 6px 12px 10px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  line-height: 16px;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-line {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary);
}
/* Cosmetic only. The three wire types carry different meaning, and nothing here
   is a contract: an unrecognised type renders as ordinary output text. */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-line[data-type='status'] {
  color: var(--dsw-alias-label-tertiary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-line[data-type='error'] {
  color: var(--dsw-alias-state-error-primary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-provider-empty {
  margin: 0;
  padding: 4px 0;
  color: var(--dsw-alias-label-tertiary);
}

/* ── States ──────────────────────────────────────────────────────────────── */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-state {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  padding: 16px;
  margin: 0;
  color: var(--dsw-alias-label-secondary);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-state-title { margin: 0; font-size: 13px; font-weight: 600; }
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-state-detail {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

/* ── Narrow viewport: the panel takes the pane, the transcript yields ────── */
@media (max-width: ${NARROW_MAX_WIDTH - 1}px) {
  [${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'][${ARENA_EXPANDED_ATTRIBUTE}='true'] .dda-arena {
    flex: 1 1 auto;
    border-left: none;
  }
  [${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'][${ARENA_EXPANDED_ATTRIBUTE}='true'] .dda-detail { display: none; }
}
`

/**
 * Install the tab's stylesheet, owned by one effect.
 *
 * One effect owns the element, so the plugin can never hold two stylesheets: the
 * disposer removes that exact node.
 * @param ctx - browser-side plugin context owning the effect.
 */
export function installArenaStyles(ctx: Context): void {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = STYLESHEET
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, `${PLUGIN_ID}: arena stylesheet`)
}
