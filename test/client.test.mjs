/**
 * Browser-half structural tests.
 *
 * The client bundle is hand-written and outside every build/type-check pipeline,
 * so these tests are its only gate. They load it exactly the way the DSH module
 * system does (`window.__ModuleLoader__.load`), then assert the things that would
 * otherwise fail silently in a browser: the registered bundle id, the
 * settings-slot contribution and its order, balanced dictionaries, accessible
 * structure, and — the one that actually bites — that every CSS custom property
 * the stylesheet reads is a token the installed DSH theme really defines, so a
 * typo cannot ship as an unstyled element.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const clientPath = join(pluginRoot, 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
const patch = readFileSync(join(pluginRoot, 'cordis.patch.yml'), 'utf8')

/** A `createElement` stand-in: enough for module-scope element construction. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useId: () => 'test',
  }
}

/** A `document` stand-in covering only what the stylesheet installer touches. */
function fakeDocument() {
  const tags = []
  return {
    createElement: () => {
      const tag = { dataset: {}, textContent: '', parentNode: null }
      tags.push(tag)
      return tag
    },
    head: { appendChild: (tag) => (tag.parentNode = {}) },
    querySelector: () => null,
    tags,
  }
}

/** Distinct import URLs, so each test gets a freshly evaluated bundle. */
let evaluation = 0

/** Load the bundle the way `dsh-client-modules` does. */
async function loadBundle() {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  let handoff
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        assert.equal(handoff, undefined, 'the bundle must register exactly once')
        handoff = spec
      },
    },
  }
  globalThis.document = fakeDocument()
  try {
    evaluation += 1
    // ESM caches by URL, so a per-test query keeps every case a fresh evaluation.
    await import(`file://${clientPath.replaceAll('\\', '/')}?evaluation=${evaluation}`)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
  assert.ok(handoff, 'the bundle registered nothing through window.__ModuleLoader__')
  return handoff
}

/** A fake client Cordis context that records what `apply` contributes. */
function fakeClientContext() {
  const dictionaries = []
  const sections = []
  const subscriptions = []
  const effects = []
  const injectedSlots = []

  const translate = (ns) => (key) => {
    const entry = dictionaries.find((candidate) => candidate.ns === ns)
    return entry ? (entry.dicts.zh[key] ?? key) : key
  }

  const ctx = {
    effect(callback, label) {
      effects.push(label)
      const disposer = callback()
      return { dispose: () => (typeof disposer === 'function' ? disposer() : undefined) }
    },
    locale: {
      register(ns, dicts) {
        dictionaries.push({ ns, dicts })
        return () => {}
      },
      bind: translate,
      subscribe(listener) {
        subscriptions.push(listener)
        return () => {}
      },
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name)
        callback()
      },
      register(options, component) {
        sections.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, dictionaries, sections, subscriptions, effects, injectedSlots }
}

test('the bundle registers under the plugin id the manifest declares', async () => {
  const bundle = await loadBundle()
  assert.equal(bundle.id, 'dsh-mcp-mini-manager')
  assert.equal(manifest.name, bundle.id)
  assert.equal(typeof bundle.factory, 'function')
  const client = bundle.factory((name) => {
    assert.equal(name, 'react', 'the bundle must only require the platform seed')
    return fakeReact()
  })
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale'])
})

test('it contributes exactly one `settings.section`, at the same level as Plugins', async () => {
  const bundle = await loadBundle()
  const client = bundle.factory(() => fakeReact())
  const fake = fakeClientContext()
  client.apply(fake.ctx)

  assert.deepEqual(fake.injectedSlots, ['settings.section'])
  assert.equal(fake.sections.length, 1)
  const { options, component } = fake.sections[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'mcp-mini-manager')
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof component, 'function')
  // 15 is the built-in 插件 (Plugins) section and 20 is 智能体预设, so 16 is the
  // same sidebar level, immediately after Plugins — not a tab inside it.
  assert.equal(options.order, 16)
  assert.ok(options.order > 15 && options.order < 20)
  assert.equal(options.locale, 'mcpMiniManager')
  // The shell resolves the nav label per locale revision.
  assert.equal(options.label(), 'MCP 极简管理')
})

test('the nav label and the page title are localized in both directions', async () => {
  const bundle = await loadBundle()
  const client = bundle.factory(() => fakeReact())
  const fake = fakeClientContext()
  client.apply(fake.ctx)
  const dicts = fake.dictionaries[0].dicts
  assert.equal(dicts.zh.nav, 'MCP 极简管理')
  assert.equal(dicts.en.nav, 'MCP Mini Manager')
  assert.equal(dicts.zh.title, 'MCP 极简管理')
  assert.equal(dicts.en.title, 'MCP Mini Manager')
  // The label function is what the shell resolves per locale revision.
  assert.equal(fake.sections[0].options.label(), 'MCP 极简管理')
})

test('both dictionaries define exactly the same keys', async () => {
  const bundle = await loadBundle()
  const client = bundle.factory(() => fakeReact())
  const fake = fakeClientContext()
  client.apply(fake.ctx)
  assert.equal(fake.dictionaries.length, 1)
  const { zh, en } = fake.dictionaries[0].dicts
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(zhKeys, enKeys, 'a key present in one locale and not the other renders as a raw key')
  assert.ok(zhKeys.length > 60, `expected a substantial dictionary, got ${zhKeys.length}`)
  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', `zh.${key}`)
    assert.equal(typeof en[key], 'string', `en.${key}`)
  }
})

test('the dictionaries are registered and the stylesheet is installed, both as effects', async () => {
  const bundle = await loadBundle()
  const client = bundle.factory(() => fakeReact())
  const fake = fakeClientContext()
  client.apply(fake.ctx)
  assert.deepEqual(fake.effects, [
    'dsh-mcp-mini-manager: dictionaries',
    'dsh-mcp-mini-manager: stylesheet',
  ])
  assert.equal(fake.subscriptions.length, 0, 'the page subscribes per mount, not at apply time')
})

test('every CSS custom property is a token the installed DSH theme defines', () => {
  // `var(` appears in this bundle only inside the stylesheet and the few inline
  // style attributes, so a whole-file scan is the honest reading of "what the
  // page asks the theme for".
  const tokens = [...source.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
  assert.ok(tokens.length > 20, `expected many token reads, got ${tokens.length}`)

  const themeRoot = join(
    homedir(),
    '.dsh',
    'profiles',
    'node_modules',
    '@deepseek-ai',
    'dsh-client-ui-theme',
    'lib',
    'styles',
  )
  if (!existsSync(themeRoot)) {
    // No installed theme to check against: keep the prefix rule as the gate.
    for (const token of tokens) assert.match(token, /^--(dsw|ds)-/)
    return
  }
  const defined = new Set()
  for (const file of readdirSync(themeRoot)) {
    if (!file.endsWith('.css')) continue
    for (const match of readFileSync(join(themeRoot, file), 'utf8').matchAll(/--[a-z0-9-]+/g)) {
      defined.add(match[0])
    }
  }
  assert.ok(defined.size > 100, `the theme should define many tokens, found ${defined.size}`)
  const unknown = [...new Set(tokens)].filter((token) => !defined.has(token))
  assert.deepEqual(unknown, [], `these custom properties are not DSH theme tokens: ${unknown.join(', ')}`)
})

test('the stylesheet is scoped by a plugin-owned class prefix', () => {
  assert.match(source, /dataset\.plugin = "dsh-mcp-mini-manager"/)
  const classNames = [...source.matchAll(/className: "([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((name) => name.length > 0)
  assert.ok(classNames.length > 15, `expected many class names, got ${classNames.length}`)
  // Every class name is either prefixed, or a modifier word applied alongside a
  // prefixed base — so no rule of this page can address someone else's element.
  for (const name of classNames) {
    assert.ok(
      name.startsWith('mmm-') || /^[a-z][a-z0-9-]*$/.test(name),
      `class name would leak styles: ${name}`,
    )
  }
  // Every dynamic suffix a className interpolates must be a modifier word, and
  // the one that is a data value is a closed set of live states.
  const dynamic = /className: "mmm-tag " \+ \(disabled \? "([^"]+)" : server\.state\)/.exec(source)
  assert.ok(dynamic, 'the state tag must stay class-scoped')
  assert.equal(dynamic[1], 'off')
  for (const literal of [...source.matchAll(/className: "mmm-[a-z-]+ " \+ "([^"]+)"/g)]) {
    assert.match(literal[1], /^[a-z][a-z0-9-]*$/)
  }
})

test('the page never sends a filesystem path or a YAML fragment to the host', () => {
  // The two row verbs share one call site, and its payload is a row id the host
  // itself reported. Purge sends nothing at all. No other POST exists.
  assert.match(source, /post\(API \+ "\/" \+ verb, \{ rowId: rowId \}\)/)
  assert.match(source, /post\(API \+ "\/purge", \{\}\)/)
  // Three call sites: the declaration, the shared row verb, and purge.
  const callSites = [...source.matchAll(/post\(/g)].length
  assert.equal(callSites, 3, `expected exactly three POST call sites, found ${callSites}`)
  // The only request body field the page ever sets is `rowId`; purge sets none.
  const bodies = [...source.matchAll(/post\(API[^;]*?\{([^}]*)\}/g)].map((match) => match[1].trim())
  assert.equal(bodies.length, 2, 'one row verb payload and the empty purge payload')
  for (const body of bodies) {
    assert.ok(body === '' || /^rowId: rowId$/.test(body), `unexpected request body: ${body}`)
  }
  // The path the page displays is shown, never submitted.
  assert.doesNotMatch(source, /post\([^)]*patchPath/)
})

test('the page is structured accessibly and localizes its own labels', () => {
  assert.match(source, /role: "alert"/, 'failures and outcomes must be announced')
  assert.match(source, /"aria-label": tf\("search"\)/, 'the search box needs an accessible name')
  assert.match(source, /aria-busy/, 'the loading state must be announced')
  assert.match(source, /type: "search"/, 'the filter should be a search input')
  assert.match(source, /"aria-label": tf\("toolsTitle"\)/, 'the tool list needs an accessible name')
})

test('the confirm step shows the exact file and patch it will write', () => {
  assert.match(source, /tf\("removeHint"\)/)
  assert.match(source, /tf\("removeBlock"\)/)
  assert.match(source, /props\.patchPath/)
  // The preview is composed from the row id, so it can only show the shape the
  // host's own planner writes.
  assert.match(source, /function disablePreview\(server\)/)
  assert.match(source, /"- id: " \+ server\.rowId/)
  assert.match(source, /"  disabled: true"/)
})

test('the package declares a web client face and resolves the client export', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.main, 'lib/index.js')
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-settings',
  ])
})

test('the bundle patch contributes exactly the plugin row', () => {
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-mcp-mini-manager/)
  assert.match(patch, /name: 'dsh-mcp-mini-manager'/)
  assert.equal(patch.includes('disabled: true'), false)
})

test('the manifest ships the runtime files and no credentials', () => {
  for (const required of ['cordis.patch.yml', 'lib', 'README.md', 'README.en.md', 'CHANGELOG.md']) {
    assert.ok(manifest.files.includes(required), `files must include ${required}`)
  }
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.license, 'MIT')
  // The page renders header *names* it was told about, never header values, and
  // it holds no credential of its own.
  assert.doesNotMatch(source, /Authorization/)
  assert.doesNotMatch(source, /\.credentials/)
})
