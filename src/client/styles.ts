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
 * The layout mirrors `debate-web`'s information design — a scrollable arena list
 * beside the selected debate's transcript — without sharing its components, its
 * Tailwind, or its colour literals.
 *
 * @module dsh-debate-bridge/client/styles
 */
import type { Context } from '@deepseek-ai/cordis'

import { PLUGIN_ID } from '../config.ts'

/** The body root's scoping attribute. */
export const ARENA_ROOT_ATTRIBUTE = 'data-dsh-debate'

/** The scoping attribute's value; the body sets exactly this on its root. */
export const ARENA_ROOT_VALUE = 'arena'

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

/* ── Split: arena list beside the transcript ──────────────────────────────── */
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-split {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-arena {
  display: flex;
  flex-direction: column;
  flex: 0 0 42%;
  min-width: 0;
  min-height: 0;
  border-right: 0.5px solid var(--dsw-alias-border-l2);
}
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
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
[${ARENA_ROOT_ATTRIBUTE}='${ARENA_ROOT_VALUE}'] .dda-entry-body {
  margin: 0;
  font: inherit;
  line-height: 19px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
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
