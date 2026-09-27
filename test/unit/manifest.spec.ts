/**
 * Manifest invariants for the packaged plugin.
 *
 * The package declares every harness dependency TWICE by design: a
 * version-range `peerDependencies` entry, which is what the installed artifact
 * resolves against in a profile, and a `link:` `devDependencies` entry, which
 * is what source-plane compilation and these tests resolve against. A runtime
 * import declared in only one of the two is the failure mode this guards: the
 * `file:`-installed artifact would then import a package the profile was never
 * told to provide.
 *
 * Ported from `dsh-project-context/test/unit/manifest.spec.ts`, with one
 * inversion: this plugin used to contribute NO client half, and the
 * `dsh.client` block was asserted ABSENT. It now ships a browser half, so the
 * same assertion is made POSITIVE — the block is present, the `./client` export
 * resolves to the bundle the client build emits, and the build script produces
 * it. Getting either half out of step is what the shell reports as
 * "failed to import", so both are pinned here.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  version: string
  description: string
  private?: boolean
  main?: string
  exports?: Record<string, { types?: string; default?: string }>
  scripts?: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string } }
}

/**
 * Every `.ts` or `.tsx` file under one directory, recursively.
 *
 * The scan MUST recurse, and MUST include the browser half: a top-level
 * `src/*.ts` listing would let a module in a subdirectory escape the dependency
 * invariant silently — exactly the failure the invariant exists to catch.
 * @param dir - absolute directory to walk.
 * @returns absolute paths of every TypeScript source below it.
 */
function typescriptFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...typescriptFiles(path))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path)
  }
  return found
}

/** Specifiers imported for their RUNTIME value, not erased as types. */
function runtimeHarnessImports(): ReadonlySet<string> {
  const found = new Set<string>()
  for (const file of typescriptFiles(join(packageRoot, 'src'))) {
    const source = readFileSync(file, 'utf8')
    // `import type …` is erased by `verbatimModuleSyntax`; everything else
    // survives into `lib/`.
    //
    // The scan must tolerate a MULTI-LINE named-import list: `[^'"]*?` spans
    // newlines but can never run past a specifier, so a statement is matched
    // only when its own `from '@deepseek-ai/…'` follows. A single-line-only
    // pattern silently skips every wrapped import — which is exactly how a
    // runtime dependency escapes the peer/link invariant, and how this detector
    // initially missed `@deepseek-ai/dsh-session-persistence`.
    const pattern = /^import\b(?![^\S\n]*type\b)[^'"]*?from\s*'(@deepseek-ai\/[^']+)'/gms
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.add(specifier)
    }
  }
  return found
}

describe('identity', () => {
  test('the package, the bundle patch and the Loader entry id all agree', () => {
    expect(manifest.name).toBe('dsh-debate-bridge')
    expect(manifest.private).toBe(true)
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: dsh-debate-bridge')
    expect(patch).toContain("name: 'dsh-debate-bridge'")
    expect(patch).not.toContain('dsh-project-context')
    // The FOUR routes the provider POSTs to must all be documented in the
    // bundle patch: it is the only place an operator reads the surface.
    expect(patch).toContain('/dsh-debate/opponent/status')
    expect(patch).toContain('/dsh-debate/opponent/stop')
    expect(patch).toContain('/dsh-debate/models')
    // And the three fenced reads the browser half calls.
    expect(patch).toContain('/api/dsh-debate/debates')
    expect(patch).toContain('/api/dsh-debate/debate')
    expect(patch).toContain('/api/dsh-debate/attach')
  })

  test('the description no longer claims the plugin contributes no UI', () => {
    expect(manifest.description).not.toContain('contributes no UI')
    expect(manifest.description).toContain('Debate Arena')
    // The stale count is gone: four loopback routes, not three.
    expect(manifest.description).not.toContain('Registers three')
    expect(manifest.version).toBe('0.2.0')
  })

  test('BOTH halves exist, and the profile can load ./client', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(Object.keys(manifest.exports ?? {}).sort()).toEqual(['.', './client', './package.json'])
    expect(manifest.exports?.['./client']?.default).toBe('./lib/client.js')
    expect(manifest.exports?.['./client']?.types).toBe('./lib/client/index.d.ts')
    expect(manifest.exports?.['.']?.default).toBe('./lib/index.js')
    // The bundle the export names must be what the client build emits, or a
    // `file:` install resolves an export nothing produces.
    expect(manifest.scripts?.['build:client']).toContain('tsdown')
    expect(manifest.scripts?.build).toBe('pnpm run build:host && pnpm run build:client')
  })

  test('the seven script names mirror the sibling dual-half plugin', () => {
    expect(Object.keys(manifest.scripts ?? {}).sort()).toEqual([
      'build',
      'build:client',
      'build:host',
      'check',
      'test',
      'test:composition',
      'test:unit',
    ])
    // `check` must cover every compiler face, the client one included.
    expect(manifest.scripts?.check).toContain('tsconfig.client.json')
  })
})

describe('dependency symmetry', () => {
  test('every RUNTIME harness import is declared as BOTH a peer and a link', () => {
    const imports = runtimeHarnessImports()
    // Sanity: the detector must actually be finding something, on both halves.
    expect(imports.size).toBeGreaterThan(0)
    expect(imports).toContain('@deepseek-ai/dsh-llm')
    expect(imports).toContain('@deepseek-ai/dsh-brand')
    expect(imports).toContain('@deepseek-ai/dsh-session-persistence')
    expect(imports).toContain('@deepseek-ai/schemastery')
    expect(imports).toContain('@deepseek-ai/dsh-client-store')
    expect(imports).toContain('@deepseek-ai/dsh-client-ui-primitives')
    for (const specifier of imports) {
      expect(manifest.peerDependencies, `${specifier} must be a peerDependency`).toHaveProperty(specifier)
      expect(manifest.devDependencies, `${specifier} must have a link: devDependency`).toHaveProperty(specifier)
      expect(manifest.devDependencies[specifier]).toMatch(/^link:\.\.\/deepseek-harness\//)
    }
  })

  test('every peer is optional and has a matching link, so a local install never resolves a registry copy', () => {
    for (const specifier of Object.keys(manifest.peerDependencies)) {
      expect(manifest.peerDependenciesMeta[specifier]?.optional, `${specifier} must be optional`).toBe(true)
      expect(manifest.devDependencies[specifier]).toMatch(/^link:\.\.\/deepseek-harness\//)
    }
  })

  test('the inject list names only services the web composition mounts', () => {
    const source = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')
    const match = /export const inject = \[([^\]]*)\]/u.exec(source)
    expect(match).not.toBeNull()
    const names = (match?.[1] ?? '').split(',').map(entry => entry.trim().replaceAll("'", '')).filter(Boolean)
    expect(names).toEqual([
      'webServer',
      'agents',
      'workspaceRegistry',
      'permissionPresets',
      'sessionTitle',
      'agentDefaultModel',
      'agentPresets',
      'llm',
      'connection',
    ])
    // Required: `setup` (`agentPresets.mount`) is what joins the session to
    // its tool/AGENTS.md/persona composition — without it the bridge mints a
    // healthy-looking session whose Opponent can never act.
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent-preset-registry']).toBeDefined()
    // Required, by contrast: it is the only source of a complete provider+model
    // route, and a session created without one dies on its first turn.
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent-default-model']).toBeDefined()
    // Also required, for a mechanical reason: the models verb forwards `ctx` to
    // `buildModelCatalog`, which dereferences `ctx.llm`, and Cordis refuses an
    // uninjected service with `cannot get property "llm" without inject` — so no
    // optional-read trick can stand in for the inject.
    expect(manifest.peerDependencies['@deepseek-ai/dsh-llm']).toBeDefined()
    // And the fence: the browser half's reads are registered on the shared
    // `/api` channel, which only exists as an injected service.
    expect(manifest.peerDependencies['@deepseek-ai/dsh-client-connection']).toBeDefined()
  })

  test('the client bundle does not reach the host half values', () => {
    // Shared facts live in `src/config.ts`; a browser module importing the entry
    // module would drag `node:http`, `webServer` and the observer into the page.
    for (const file of typescriptFiles(join(packageRoot, 'src', 'client'))) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} must not import the host entry`).not.toMatch(/from\s*'\.\.\/index\.ts'/)
      expect(source, `${file} must not import node builtins`).not.toMatch(/from\s*'node:/)
    }
  })
})
