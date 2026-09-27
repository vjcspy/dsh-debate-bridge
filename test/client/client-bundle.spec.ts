/**
 * Built-artifact contract for the browser half.
 *
 * `lib/client.js` must exist, hand its factory to the shell's module loader with
 * the package id, export only what cordis loading needs, request nothing outside
 * the shell's baseline module table, and — when that `apply` runs — register the
 * Debate Arena tab kind, its dictionary, its keyed body, and start the
 * attachment watcher whose source is the body's injected hook.
 *
 * The spec reads the BUILT bundle, so `build:client` must have run first; the
 * package's `test` script builds it before invoking vitest.
 */
import type { Context } from '@deepseek-ai/cordis'

import { existsSync, readFileSync, statSync } from 'node:fs'

import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import * as ClientStore from '@deepseek-ai/dsh-client-store'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ATTACH_PATH,
  DETAIL_PATH,
  FENCED_PREFIX,
  GUIDE_ENTRY_ID,
  LIST_PATH,
  LOCALE_NAMESPACE,
  PLUGIN_ID,
  TAB_KIND,
} from '../../src/config.ts'
import type { DebateArenaInjected } from '../../src/client/DebateArenaBody.tsx'
import type { DebateAttachmentSnapshot } from '../../src/client/attach-watch.ts'

const BUNDLE_PATH = 'lib/client.js'
const HOST_ENTRY_PATH = 'lib/index.js'

/**
 * The client baseline: specifiers the shell seeds once and answers from its
 * module table. `PLATFORM_MODULES` in `packages/client/web/src/platform.ts` is
 * the authority; these are the rows this plugin can reach.
 */
const BASELINE_SPECIFIERS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** One tab type as the registry receives it. */
interface RegisteredTabKind {
  id: string
  kind: string
  keepMounted?: boolean
  title: (address: string) => string
  guide?: readonly { id: string; order: number; title: () => string; description?: () => string }[]
}

/** One slot entry as the seat receives it. */
interface RegisteredEntry {
  options: { name: string; key?: string; locale?: string; inject?: () => DebateArenaInjected }
  component: unknown
}

interface Registration {
  id: string
  factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

/** Registrations captured from `window.__ModuleLoader__.load`. */
const registrations: Registration[] = []

/** Bare specifiers the bundle asked the shell's module table for. */
const requestedSpecifiers: string[] = []

/**
 * Answer one module request from a stand-in module table.
 * @param specifier - the bare specifier the bundle asked for.
 * @returns the module the table would hand back.
 */
function resolveModule(specifier: string): unknown {
  requestedSpecifiers.push(specifier)
  if (specifier === 'react') return React
  if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') return JsxRuntime
  if (specifier === 'react-dom') return {}
  if (specifier === '@deepseek-ai/dsh-client-store') return ClientStore
  // The primitives are the shell's own components; a stand-in is enough because
  // these specs never render.
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return { Button: () => null, Tag: () => null, StateDot: () => null }
  }
  throw new Error(`unexpected require(${specifier}) — not a client baseline module`)
}

/**
 * Evaluate the built bundle once, capturing its loader registration.
 * @returns The captured registration for the plugin bundle.
 */
function captureRegistration(): Registration {
  const source = readFileSync(BUNDLE_PATH, 'utf8')
  const loader = { load: (registration: Registration) => { registrations.push(registration) } }
  ;(globalThis as Record<string, unknown>).window = globalThis
  ;(globalThis as Record<string, unknown>).__ModuleLoader__ = loader
  try {
    // `process` is shadowed with `undefined` so the factory runs under browser
    // semantics. Evaluating this source in plain Node is not a browser test:
    // Node has a global `process`, so an inlined dependency reading
    // `process.env.NODE_ENV` resolves here and the factory never throws — while
    // in a real page it throws `ReferenceError: process is not defined`, fails
    // the whole client half, and takes the page down with "Failed to load
    // plugins". Shadowing it makes that failure reproduce in this spec.
    new Function('process', source)(undefined)
  } finally {
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).__ModuleLoader__
  }
  const registration = registrations.at(-1)
  if (registration === undefined) throw new Error(`${BUNDLE_PATH} did not call window.__ModuleLoader__.load`)
  return registration
}

let registration: Registration
let pluginExports: Record<string, unknown>
const disposers: Array<() => void> = []

/** Fenced paths the watcher actually asked the Host for. */
const requestedPaths: string[] = []
const realFetch = globalThis.fetch

beforeAll(() => {
  registration = captureRegistration()
  pluginExports = registration.factory(resolveModule)
})

// Installed per test, not once: the watcher polls the Host's fenced attachment
// path from apply, and `afterEach` restores the real transport.
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedPaths.push(String(input))
    return new Response(JSON.stringify({
      success: true,
      data: { sessionId: 'dsh-debate-abc', debateId: null, observedAt: null },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  globalThis.fetch = realFetch
  requestedPaths.length = 0
})

/** The stub context the built `apply` runs against. */
interface ApplyHarness {
  ctx: Context
  /** Tab types the bundle registered. */
  tabs: RegisteredTabKind[]
  /** Every locale registration the bundle made. */
  dictionaries: { ns: string; locale: string; dict: Readonly<Record<string, string>> }[]
  /** Slot entries the bundle registered once their slot declaration arrived. */
  entries: RegisteredEntry[]
  /** Sessions the watcher was asked to open the tab in. */
  opens: string[]
  /** The Session the stub controller reports as mounted. */
  mounted: string | undefined
  /** Run every registered effect body and collect its disposer. */
  run: () => void
}

/**
 * Minimal client context carrying the four services the bundle injects.
 * @returns the context plus the captured registrations.
 */
function createContext(): ApplyHarness {
  const bodies: Array<() => (() => void) | void> = []
  const harness: ApplyHarness = {
    tabs: [],
    dictionaries: [],
    entries: [],
    opens: [],
    mounted: undefined,
    run: () => { for (const body of bodies) disposers.push(body() ?? (() => {})) },
    ctx: undefined as unknown as Context,
  }
  const words: Record<string, string> = { 'tab.title': 'Debate Arena', 'guide.title': 'Debate Arena' }
  harness.ctx = {
    logger: { debug: () => {} },
    effect: (body: () => (() => void) | void) => {
      bodies.push(body)
      return () => {}
    },
    locale: {
      bind: () => (key: string) => words[key] ?? key,
      register: (ns: string, locale: string, dict: Readonly<Record<string, string>>) => {
        harness.dictionaries.push({ ns, locale, dict })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition: RegisteredTabKind) => {
        harness.tabs.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      mounted: {
        getSnapshot: () => harness.mounted,
        subscribe: () => () => {},
      },
      openTab: (kind: string) => { harness.opens.push(kind) },
      isExpanded: () => true,
      toggleExpanded: () => {},
    },
    slots: {
      inject: (_name: string, install: () => void) => {
        install()
        return () => {}
      },
      register: (options: RegisteredEntry['options'], component: unknown) => {
        harness.entries.push({ options, component })
        return () => {}
      },
    },
  } as unknown as Context
  return harness
}

/**
 * Activate the built bundle against a stub context.
 * @param options.mounted - the Session the stub controller reports as mounted.
 * @returns the harness holding everything the bundle registered.
 */
function activate(options: { readonly mounted?: string } = {}): ApplyHarness {
  const harness = createContext()
  harness.mounted = options.mounted
  ;(pluginExports.apply as (ctx: Context) => void)(harness.ctx)
  harness.run()
  return harness
}

/**
 * The injected face of the single registered body.
 * @param harness - activated harness.
 * @returns the face.
 */
function faceOf(harness: ApplyHarness): DebateArenaInjected {
  const inject = harness.entries[0]!.options.inject
  if (inject === undefined) throw new Error('the body was registered without an inject face')
  return inject()
}

describe('built Client bundle', () => {
  it('exists and is non-empty', () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true)
    expect(statSync(BUNDLE_PATH).size).toBeGreaterThan(0)
  })

  it('registers under the package id the loader expects', () => {
    expect(registration.id).toBe('dsh-debate-bridge')
    expect(registration.id).toBe(PLUGIN_ID)
  })

  it('exports only what cordis loading needs', () => {
    expect(Object.keys(pluginExports).sort()).toEqual(['apply', 'inject'])
    expect(typeof pluginExports.apply).toBe('function')
    expect(pluginExports.inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'])
  })

  it('exposes the Host apply entry as a separate artifact', () => {
    expect(existsSync(HOST_ENTRY_PATH)).toBe(true)
    expect(statSync(HOST_ENTRY_PATH).size).toBeGreaterThan(0)
  })

  it('requests only client baseline modules, never a Host-only library', () => {
    // `schemastery` is a Host dependency; reaching it from the page would fail at
    // load. Every request the bundle makes must be a row the shell has seeded.
    expect(requestedSpecifiers).not.toContain('@deepseek-ai/schemastery')
    expect(requestedSpecifiers.filter(specifier => !BASELINE_SPECIFIERS.has(specifier))).toEqual([])
    // The rows this plugin actually uses, so the assertion above cannot pass
    // vacuously: one React instance is the shell's, not a second copy.
    expect(requestedSpecifiers).toContain('react')
    expect(requestedSpecifiers).toContain('react/jsx-runtime')
    expect(requestedSpecifiers).toContain('@deepseek-ai/dsh-client-store')
    expect(requestedSpecifiers).toContain('@deepseek-ai/dsh-client-ui-primitives')
  })

  it('carries no Node global that a browser page does not define', () => {
    // Regression gate for a measured outage in this plugin family: inlining a
    // dependency reading `process.env.NODE_ENV` made the emitted factory throw
    // `ReferenceError: process is not defined` at boot, and the ENTIRE Web UI
    // showed "Failed to load plugins". The build bakes the substitution
    // (`define` in tsdown.config.ts), so the emitted source must not mention
    // `process.env.` at all — an assertion on the artifact catches this for
    // every inlined dependency, not just the one that broke.
    const source = readFileSync(BUNDLE_PATH, 'utf8')
    expect(source).not.toContain('process.env.')
    expect(source).not.toMatch(/\bprocess\s*\./)
    expect(source).not.toMatch(/\brequire\s*\(\s*["']node:/)
  })

  it('inlines this plugin\'s own modules rather than requesting them', () => {
    const source = readFileSync(BUNDLE_PATH, 'utf8')
    for (const specifier of ['../config.ts', './attach-watch.ts', './lib/debate-api.ts']) {
      expect(requestedSpecifiers).not.toContain(specifier)
    }
    // And the fenced route table really is in the emitted source, so the
    // assertions above cannot pass on a bundle that dropped the client half.
    // The full paths are template literals (`${FENCED_PREFIX}/debates`), so the
    // artifact carries the prefix and each suffix separately rather than any
    // joined string — which is why this checks both halves.
    const prefix = FENCED_PREFIX
    expect(source).toContain(prefix)
    for (const path of [LIST_PATH, DETAIL_PATH, ATTACH_PATH]) {
      expect(source).toContain(path.slice(prefix.length))
    }
  })
})

describe('built Client apply', () => {
  it('registers the Debate Arena tab kind with its guide entry', () => {
    const harness = activate()
    expect(harness.tabs).toHaveLength(1)
    const definition = harness.tabs[0]!
    expect(definition.id).toBe(PLUGIN_ID)
    expect(definition.kind).toBe(TAB_KIND)
    expect(definition.kind).toBe('dsh-debate-arena')
    // `multiple` stays unset: a page is unique per pane, and setting it would
    // make every repeat trigger a new copy in the same pane.
    expect(definition).not.toHaveProperty('multiple')
    expect(definition.keepMounted).toBe(false)
    expect(definition.title('sidebar://dsh-debate-arena')).toBe('Debate Arena')
    expect(definition.guide).toHaveLength(1)
    expect(definition.guide![0]!.id).toBe(GUIDE_ENTRY_ID)
    expect(definition.guide![0]!.order).toBeGreaterThan(0)
    expect(definition.guide![0]!.title()).toBe('Debate Arena')
  })

  it('registers its dictionary under the namespace its body declares', () => {
    const harness = activate()
    expect(harness.dictionaries).toHaveLength(1)
    expect(harness.dictionaries[0]!.ns).toBe(LOCALE_NAMESPACE)
    expect(harness.dictionaries[0]!.ns).toBe('dshDebateArena')
    expect(harness.dictionaries[0]!.locale).toBe('en')
    expect(harness.dictionaries[0]!.dict['tab.title']).toBe('Debate Arena')
  })

  it('registers one keyed body on the tab-body seat, with a declared store and locale', () => {
    const harness = activate()
    expect(harness.entries).toHaveLength(1)
    expect(harness.entries[0]!.options.name).toBe('sidebar.right.pane.tab')
    expect(harness.entries[0]!.options.key).toBe(PLUGIN_ID)
    expect(harness.entries[0]!.options.locale).toBe(LOCALE_NAMESPACE)
    expect(harness.entries[0]!.options).toHaveProperty('store')
    expect(typeof harness.entries[0]!.component).toBe('function')
  })

  it('starts the watcher from apply, with the tab never opened by a user', async () => {
    // The Proposer trigger fires with the tab CLOSED, so nothing in a body can be
    // responsible for polling. Mounting a `dsh-debate-<id>` Session before
    // activation is exactly the Opponent trigger: apply itself must open the tab.
    const harness = activate({ mounted: 'dsh-debate-abc' })
    await vi.waitFor(() => { expect(harness.opens).toEqual([TAB_KIND]) })
    // And the read it made went through the admission-fenced path.
    expect(requestedPaths[0]?.startsWith(ATTACH_PATH)).toBe(true)
    expect(requestedPaths[0]).toContain('sessionId=dsh-debate-abc')
  })

  it('hands the body the watcher\'s own live attachment source', async () => {
    const harness = activate({ mounted: 'dsh-debate-abc' })
    const source: DebateAttachmentSnapshot = faceOf(harness).hooks.debateAttach.getSnapshot()
    await vi.waitFor(() => {
      expect(faceOf(harness).hooks.debateAttach.getSnapshot())
        .toEqual({ sessionId: 'dsh-debate-abc', debateId: null })
    })
    // Stable source identity: the renderer caches its hook binding per source.
    expect(faceOf(harness).hooks.debateAttach).toBe(faceOf(harness).hooks.debateAttach)
    expect(source).toBeDefined()
  })
})
