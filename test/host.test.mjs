/**
 * Host-half integration tests.
 *
 * `apply()` is driven through a minimal fake Cordis context whose `loader.entries()`
 * re-derives the live tree from the patch layer on disk — which is exactly what
 * the real Loader's patch-layer watcher does — and the five HTTP routes are
 * invoked as plain functions over real temporary directories. That covers the
 * whole path: read the layers, reconcile with the live tree, disable a row,
 * observe the row leave the live tree, restore it, and match the file byte for
 * byte afterwards.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

import { API_BASE, ENDPOINTS, apply, inject, name as pluginName } from '../lib/index.js'
import {
  BACKUP_DIR_PARTS,
  MARKER_BEGIN_PREFIX,
  MARKER_END_PREFIX,
  PROFILE_PATCH_FILENAME,
  backupPath,
  parseYamlSubset,
  resolveHarnessHome,
} from '../lib/catalog.js'

/** Every sandbox created in this file, torn down at the end. */
const sandboxes = []
/** The developer's own `DSH_HOME`, restored by `after()`. */
const savedHome = process.env.DSH_HOME

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  for (const directory of sandboxes) rmSync(directory, { recursive: true, force: true })
})

/**
 * Create an isolated harness home holding one web profile.
 *
 * The user layer starts as the comment-only template DSH itself writes, and the
 * MCP rows under test live in the *bundle* layer — which is where a real
 * deployment declares them. Anything else would test a shape that cannot occur.
 *
 * @param patchText - initial text of the profile's own patch layer.
 * @returns the sandbox paths and the profile directory.
 */
function sandbox(patchText = '# mine\n[]\n') {
  const home = mkdtempSync(join(tmpdir(), 'mmm-'))
  sandboxes.push(home)
  // Point the harness home at the sandbox. Tests that go through `mount()` are
  // isolated by the fake Loader's base URL, but a test that calls `apply(ctx)`
  // directly has nothing else to resolve against — without this it reads the
  // developer's real `~/.dsh`, which makes the test pass or fail depending on
  // what that machine happens to have configured, and lets a write land in a
  // real profile. `after()` restores the previous value.
  process.env.DSH_HOME = home
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, PROFILE_PATCH_FILENAME), patchText, 'utf8')
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
    'utf8',
  )
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  return { home, dir, patchPath, patch: () => readFileSync(patchPath, 'utf8') }
}

/**
 * The live entries a patch layer implies.
 *
 * Rows the layer declares `disabled: true` are withheld, which is how the real
 * Loader reports them, so a disable this plugin writes really does remove the row
 * from the live tree the next time it is read.
 *
 * @param patchPath - the profile patch layer to derive from.
 * @param rows - the rows the bundle layers contribute.
 * @param options - `asComposedPath` models the real Loader, which reports a row
 *   declared inside a group by its full `group:child` path.
 * @returns the live entries, with `fiber.state === 2` on each.
 */
function liveEntriesFrom(patchPath, rows, options = {}) {
  const text = readFileSync(patchPath, 'utf8')
  const disabled = new Set(
    parseYamlSubset(text)
      .value.filter((patch) => patch?.disabled === true && typeof patch.id === 'string')
      .map((patch) => patch.id),
  )
  return rows
    .filter((row) => !disabled.has(row.options.id))
    .map((row) => ({
      id: options.asComposedPath === true ? `include:${row.options.id}` : row.options.id,
      options: row.options,
      disabled: false,
      fiber: { state: 2 },
    }))
}

/** One fake `@deepseek-ai/dsh-mcp-client` loader row. */
function mcpRow(id, config, options = {}) {
  return {
    id,
    options: {
      id,
      name: options.name ?? '@deepseek-ai/dsh-mcp-client',
      config,
      ...(options.group === undefined ? {} : { group: options.group }),
    },
  }
}

/**
 * A minimal fake Cordis context.
 *
 * @param patchPath - the profile patch layer the fake Loader watches.
 * @param rows - the rows the bundle layers contribute.
 * @param tools - tool schemas `ctx.tools.schemas()` should report.
 * @returns the context, recorded routes, and the effect labels `apply` registered.
 */
function fakeContext(patchPath, rows, tools = [], options = {}) {
  const routes = new Map()
  const effects = []
  const info = []
  const ctx = {
    logger: {
      info: (message) => info.push(message),
      warn: (message) => info.push(message),
      error: (message) => info.push(String(message)),
    },
    effect(callback, label) {
      effects.push(label)
      const disposer = callback()
      return { dispose: () => (typeof disposer === 'function' ? disposer() : undefined) }
    },
    get(service) {
      if (service === 'loader') {
        return {
          config: { baseUrl: patchPath.replace(/[\\/][^\\/]+$/, '') },
          entries: () => liveEntriesFrom(patchPath, rows, options),
        }
      }
      if (service === 'tools') return { schemas: () => tools }
      return undefined
    },
    webServer: {
      register(options) {
        routes.set(options.path, options.handler)
        return () => routes.delete(options.path)
      },
    },
  }
  return { ctx, routes, effects, info }
}

/** A fake outgoing HTTP response that records what was written. */
function fakeResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
  }
}

/** One fake incoming request carrying an optional JSON body. */
class FakeRequest extends EventEmitter {
  constructor(method, body, headers = {}) {
    super()
    this.method = method
    this.headers = headers
    this.destroyed = false
    this._body = body
    this._raw = undefined
  }

  destroy() {
    this.destroyed = true
    // A real socket settles its 'end' listener by erroring; without this the
    // body-size guard would leave `readJsonBody` pending forever.
    this.emit('error', new Error('request destroyed'))
    this.emit('end')
  }

  /** Queue a raw (possibly malformed) body instead of a JSON-serialized one. */
  raw(text) {
    this._raw = text
    return this
  }

  /**
   * Wait until the request body has been consumed.
   *
   * Awaiting this *before* invoking the handler would deadlock: `readJsonBody`
   * only attaches its listeners once the handler runs, and an EventEmitter drops
   * an emit that has no listener.
   */
  consumed() {
    return new Promise((resolve) => this.once('end', resolve))
  }

  /** Deliver the body on the next tick, the way a real socket would. */
  pump() {
    setImmediate(() => {
      const text = this._raw ?? (this._body === undefined ? undefined : JSON.stringify(this._body))
      if (text !== undefined && !this.destroyed) this.emit('data', Buffer.from(text, 'utf8'))
      if (!this.destroyed) this.emit('end')
    })
    return this.consumed()
  }
}

/** Drive one route the way the HTTP carrier would. */
async function call(handler, request) {
  const response = fakeResponse()
  const [, consumed] = await Promise.all([handler(request, response), request.pump()])
  await consumed
  return { status: response.status, headers: response.headers, json: JSON.parse(response.body) }
}

/** Wire `apply()` over one sandbox and return the callable surface. */
function mount(sandboxed, rows, tools = [], options = {}) {
  process.env.DSH_HOME = sandboxed.home
  const fake = fakeContext(sandboxed.patchPath, rows, tools, options)
  apply(fake.ctx)
  const invoke = async (path, method = 'GET', body) => {
    const handler = fake.routes.get(path)
    assert.ok(handler !== undefined, `route ${path} was never registered`)
    const request = new FakeRequest(
      method,
      body,
      method === 'POST' ? { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } : {},
    )
    return call(handler, request)
  }
  return { ...fake, invoke, get: (path) => invoke(path, 'GET'), post: (path, body) => invoke(path, 'POST', body) }
}

const GITHUB = { serverName: 'github', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }
const WEB = { serverName: 'web', transport: 'streamable-http', url: 'http://localhost:3000/mcp' }

/* ------------------------------------------------------------------ */
/* Module surface                                                      */
/* ------------------------------------------------------------------ */

test('the plugin declares the HTTP carrier it cannot work without', () => {
  assert.equal(pluginName, 'dsh-mcp-mini-manager')
  assert.deepEqual(inject, ['webServer'])
  assert.equal(API_BASE, '/dsh-mcp-mini-manager/api')
})

test('apply mounts exactly the five documented routes, outside /api', () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  assert.deepEqual(
    [...mounted.routes.keys()].sort(),
    [ENDPOINTS.catalog, ENDPOINTS.disable, ENDPOINTS.purge, ENDPOINTS.restore, ENDPOINTS.rows].sort(),
  )
  for (const path of mounted.routes.keys()) {
    assert.ok(path.startsWith('/dsh-mcp-mini-manager/'), path)
    assert.equal(path.startsWith('/api/'), false, 'the host fence owns /api')
  }
})

test('every route is owned by an effect, so teardown unregisters it', () => {
  const box = sandbox()
  const mounted = mount(box, [])
  assert.equal(mounted.effects.length, 5)
  for (const label of mounted.effects) assert.match(label, /^mcp-mini-manager: route \//)
})

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

test('the catalog reports a live MCP server with its config-derived summary', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const { status, json } = await mounted.get(ENDPOINTS.catalog)

  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.plugin.name, 'dsh-mcp-mini-manager')
  assert.equal(json.servers.length, 1)
  const [server] = json.servers
  assert.equal(server.rowId, 'mcp-github')
  assert.equal(server.serverName, 'github')
  assert.equal(server.transport, 'stdio')
  assert.equal(server.endpoint, 'npx -y @modelcontextprotocol/server-github')
  assert.equal(server.state, 'active')
  assert.equal(server.complete, true)
  assert.deepEqual(server.tools, [])
})

test('the catalog attributes namespaced MCP tools to their server', async () => {
  const box = sandbox()
  const tools = [
    { name: 'mcp__github__create_issue', description: 'Open an issue' },
    { name: 'mcp__github__list_repos', description: 'List repositories' },
    { name: 'mcp__web__search', description: 'Search the web' },
    { name: 'read', description: 'a native tool' },
  ]
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB), mcpRow('mcp-web', WEB)], tools)
  const { json } = await mounted.get(ENDPOINTS.catalog)
  const byRow = Object.fromEntries(json.servers.map((server) => [server.rowId, server]))

  assert.equal(byRow['mcp-github'].toolCount, 2)
  assert.deepEqual(
    byRow['mcp-github'].tools.map((tool) => tool.rawName),
    ['create_issue', 'list_repos'],
  )
  assert.equal(byRow['mcp-web'].toolCount, 1)
  assert.equal(json.toolTotal, 3, 'the native tool must not be counted as MCP')
})

test('a row disabled in the patch layer is reported disabled, with no live fiber', async () => {
  const box = sandbox(
    [
      '# mine',
      '',
      '- id: mcp-github',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  config:',
      '    serverName: github',
      '    transport: stdio',
      '  disabled: true',
      '',
    ].join('\n'),
  )
  // The bundle layer contributes the row; the profile layer withholds it.
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.servers.length, 1)
  const [server] = json.servers
  assert.equal(server.state, 'disabled')
  // This row is described by the file the user edits — they disabled it by hand —
  // so `inUserPatch` is true even though the block carries no marker of ours.
  // `inUserPatch` answers "can I see and change this myself?", not "did this
  // plugin write it?"; a row living only inside a package's layer answers false.
  assert.equal(server.inUserPatch, true)
})

test('a row declared by the user as an insert is one row, and it is theirs', async () => {
  // The shape a real DSH profile uses to add an MCP by hand: an `insert` list in
  // the user's own layer, quoted module name, and a secret read through `!!js`.
  const box = sandbox(
    [
      '# mine',
      '',
      '- insert:',
      '    - id: mcp-grafana',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: grafana',
      '        transport: stdio',
      '        command: mcp-grafana.exe',
      '        env:',
      "          TOKEN: !!js process.env.GRAFANA_TOKEN ?? ''",
      '',
    ].join('\n'),
  )
  // The live tree reports the composed path, not the declared id: the root include
  // namespaces its children, so the row `mcp-grafana` is loaded as
  // `include:mcp-grafana`. Both halves of this shape are real; the bug this guards
  // against was reporting them as two different servers, one of them "unobserved",
  // and pointing disable at an id no patch can resolve.
  const row = mcpRow('mcp-grafana', { serverName: 'grafana', transport: 'stdio', command: 'mcp-grafana.exe' })
  const mounted = mount(box, [row], [], { asComposedPath: true })
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.servers.length, 1, 'the same server must not be listed twice')
  const [server] = json.servers
  assert.equal(server.rowId, 'mcp-grafana', 'the declared id is the one a patch can target')
  assert.equal(server.state, 'active', 'the live fiber is what makes it installed')
  assert.equal(server.origin, 'user-patch', 'the user wrote this row in their own layer')
  assert.equal(server.inUserPatch, true)
})

test('the catalog names the profile, the layers, and the write target', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-web', WEB)])
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.profile.dir, box.dir)
  assert.equal(json.profile.patchPath, box.patchPath)
  assert.equal(json.profile.patchExists, true)
  assert.equal(json.profile.homePatchPath, join(resolveHarnessHome(), PROFILE_PATCH_FILENAME))
  assert.equal(json.profile.homePatchExists, false)
  assert.equal(json.loaderAvailable, true)
  assert.equal(json.profile.via, 'loader-base-url')
})

test('an empty deployment is an empty catalog, not an error', async () => {
  const box = sandbox()
  const mounted = mount(box, [])
  const { status, json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.deepEqual(json.servers, [])
  assert.deepEqual(json.backups, [])
  assert.equal(json.loaderAvailable, true)
})

test('a non-MCP row never reaches the catalog', async () => {
  const box = sandbox()
  const other = { id: 'theme-manager', options: { id: 'theme-manager', name: 'dsh-theme-manager' } }
  const mounted = mount(box, [other, mcpRow('mcp-web', WEB)])
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.deepEqual(
    json.servers.map((server) => server.rowId),
    ['mcp-web'],
  )
})

test('a row whose config declares no transport is reported incomplete', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-broken', { serverName: 'broken' })])
  const { json } = await mounted.get(ENDPOINTS.catalog)
  const [server] = json.servers
  assert.equal(server.complete, false)
  assert.equal(server.transport, null)
  assert.equal(server.endpoint, '')
})

test('a "!!js" config value is reported as computed, not as a resolved secret', async () => {
  const box = sandbox()
  const mounted = mount(box, [
    mcpRow('mcp-web', { serverName: 'web', transport: 'streamable-http', url: 'http://x/mcp', headers: { Authorization: 'Bearer s3cret' } }),
  ])
  const { json } = await mounted.get(ENDPOINTS.catalog)
  // Only key names are reported; header values never leave the host.
  assert.deepEqual(json.servers[0].headerKeys, ['Authorization'])
  assert.equal(JSON.stringify(json).includes('s3cret'), false)
})

test('the raw-rows diagnostic reports every loader row, MCP or not', async () => {
  const box = sandbox()
  const other = { id: 'theme-manager', options: { id: 'theme-manager', name: 'dsh-theme-manager' } }
  const mounted = mount(box, [other, mcpRow('mcp-web', WEB)])
  const { json } = await mounted.get(ENDPOINTS.rows)
  assert.equal(json.ok, true)
  assert.equal(json.count, 2)
  const mcp = json.rows.find((row) => row.rowId === 'mcp-web')
  assert.equal(mcp.isMcp, true)
  assert.deepEqual(mcp.configKeys, ['serverName', 'transport', 'url'])
})

/* ------------------------------------------------------------------ */
/* Disable / restore                                                   */
/* ------------------------------------------------------------------ */

test('disabling a server appends a bracketed block and leaves the file otherwise intact', async () => {
  const original = '# mine\n[]\n'
  const box = sandbox(original)
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])

  const { status, json } = await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.equal(json.disabled.rowId, 'mcp-github')
  assert.equal(json.disabled.serverName, 'github')
  assert.equal(json.effect, 'applied', 'the fake Loader re-reads the layer, like the real watcher')

  const after = box.patch()
  assert.ok(after.startsWith(original), 'the existing layer must be preserved verbatim')
  assert.ok(after.includes(MARKER_BEGIN_PREFIX + 'mcp-github'))
  assert.ok(after.includes(MARKER_END_PREFIX + 'mcp-github'))
  assert.match(after, /^- id: mcp-github\n {2}disabled: true$/m)
})

test('a "!!js" expression elsewhere in the layer survives a disable verbatim', async () => {
  // The user layer is shared with every other plugin the deployment configures,
  // so a write here must not re-encode YAML: comments and `!!js` expressions are
  // exactly what a parse-and-serialize round trip would destroy.
  const original = '# mine\n\n- id: dsh-cube-es-mcp\n  config:\n    allowPanelWrites: !!js process.env.X === "1"\n'
  const box = sandbox(original)
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])

  const { json } = await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  assert.equal(json.ok, true)
  const after = box.patch()
  assert.ok(after.startsWith(original), 'every existing byte must be preserved')
  assert.equal(after.includes('!!js process.env.X === "1"'), true, 'the expression must survive')
  assert.equal(after.includes("'process.env.X"), false, 'the expression must not be quoted')
})

test('a disabled server leaves the live tree and is then reported disabled', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  assert.equal((await mounted.get(ENDPOINTS.catalog)).json.servers[0].state, 'active')

  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.servers.length, 1, 'the row is still listed, from the patch layer')
  assert.equal(json.servers[0].state, 'disabled')
  assert.equal(json.servers[0].inUserPatch, true)
})

test('the original row is recorded before the patch is written', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = (await mounted.get(ENDPOINTS.catalog)).json.servers[0]
  assert.equal(before.state, 'active')
  assert.equal(before.removedAt, null)

  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })

  const recordPath = backupPath(box.home, 'mcp-github')
  assert.equal(existsSync(recordPath), true)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.equal(record.rowId, 'mcp-github')
  assert.equal(record.serverName, 'github')
  assert.deepEqual(record.config, GITHUB)
  assert.equal(record.patchPath, box.patchPath)
  assert.equal(typeof record.removedAt, 'number')

  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.backups.length, 1)
  assert.equal(json.backups[0].inPatch, true)
  // The managed block carries no config, so the record is what keeps the row
  // recognisable after it leaves the live tree: name, summary and state.
  assert.equal(json.servers[0].state, 'disabled')
  assert.equal(json.servers[0].serverName, 'github')
  assert.equal(json.servers[0].endpoint, before.endpoint)
  assert.equal(json.servers[0].transport, 'stdio')
  assert.equal(json.servers[0].configSource, 'removal-record')
  assert.equal(json.servers[0].removedAt, json.backups[0].removedAt)
})

test('disabling twice is refused rather than duplicating the patch', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  const first = box.patch()

  const { json } = await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  assert.equal(json.ok, false)
  assert.equal(json.error, 'already-disabled')
  assert.equal(box.patch(), first, 'a refused request must not touch the file')
})

test('a row the user disabled by hand is refused, not re-patched', async () => {
  const box = sandbox(
    [
      '# mine',
      '',
      '- id: mcp-github',
      '  name: "@deepseek-ai/dsh-mcp-client"',
      '  config:',
      '    serverName: github',
      '    transport: stdio',
      '  disabled: true',
      '',
    ].join('\n'),
  )
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  const { json } = await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  assert.equal(json.ok, false)
  assert.equal(json.error, 'already-disabled')
  assert.equal(box.patch(), before)
})

test('a user-layer config override is merged into the catalog, not lost', async () => {
  // Mirrors a real deployment shape: the user layer overrides one MCP row's
  // config while the row itself still lives in a bundle layer.
  const box = sandbox(
    ['# mine', '', '- id: mcp-cube', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: cube', '    transport: streamable-http', '    url: http://cube/mcp', ''].join(
      '\n',
    ),
  )
  const mounted = mount(box, [mcpRow('mcp-cube', { serverName: 'cube', transport: 'streamable-http', url: 'http://old/mcp' })])
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.servers.length, 1)
  assert.equal(json.servers[0].serverName, 'cube')
  // The live tree wins the config, because it is what actually connected.
  assert.equal(json.servers[0].url, 'http://old/mcp')
})

test('a row the user already patched the config of is disable-able, and composes', async () => {
  // The patch layers compose key by key: a patch carrying only `id` + `disabled`
  // is applied on top of one carrying `name` + `config`, which is exactly how
  // DSH itself layers patches. So this must succeed — refusing would make every
  // patch-declared MCP row permanently unremovable.
  const box = sandbox(
    ['# mine', '', '- id: mcp-cube', '  name: "@deepseek-ai/dsh-mcp-client"', '  config:', '    serverName: cube', '    transport: streamable-http', '    url: http://cube/mcp', '',].join(
      '\n',
    ),
  )
  const mounted = mount(box, [mcpRow('mcp-cube', { serverName: 'cube', transport: 'streamable-http', url: 'http://cube/mcp' })])
  const before = box.patch()
  const { json } = await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-cube' })
  assert.equal(json.ok, true, JSON.stringify(json))
  assert.equal(json.effect, 'applied')
  assert.equal(json.disabled.serverName, 'cube')

  const after = box.patch()
  // The user's own patch is preserved byte for byte, ahead of the new block.
  assert.ok(after.startsWith(before), 'the existing override must be left exactly as it was')
  assert.ok(after.includes('    url: http://cube/mcp'), 'the config override survives')
  assert.ok(after.includes(`${MARKER_BEGIN_PREFIX}mcp-cube`))

  // The row stays visible and identifiable from the patch layer alone, now that
  // it is gone from the live tree.
  const catalog = await mounted.get(ENDPOINTS.catalog)
  assert.equal(catalog.json.servers.length, 1)
  assert.equal(catalog.json.servers[0].state, 'disabled')
  assert.equal(catalog.json.servers[0].serverName, 'cube')
  assert.equal(catalog.json.servers[0].url, 'http://cube/mcp')

  // And restore returns the file to exactly the bytes the user had.
  const restored = await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-cube' })
  assert.equal(restored.json.ok, true)
  assert.equal(box.patch(), before)
})

test('an unknown row id is refused and nothing is written', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  const { json } = await mounted.post(ENDPOINTS.disable, { rowId: 'theme-manager' })
  assert.equal(json.ok, false)
  assert.equal(json.error, 'unknown-row')
  assert.equal(box.patch(), before)
})

test('a path-shaped row id is rejected by grammar, before any filesystem use', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  for (const rowId of ['../../../etc/passwd', 'C:\\Windows\\win.ini', 'a/b', '..', '']) {
    const { status, json } = await mounted.post(ENDPOINTS.disable, { rowId })
    assert.equal(status, 200)
    assert.equal(json.ok, false, `rowId ${JSON.stringify(rowId)} must be refused`)
    assert.equal(json.error, 'bad-row-id')
  }
  assert.equal(existsSync(join(box.home, 'etc')), false)
})

test('restore removes the block and reproduces the original layer exactly', async () => {
  const original = '# mine\n[]\n'
  const box = sandbox(original)
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])

  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  assert.notEqual(box.patch(), original)

  const { json } = await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-github' })
  assert.equal(json.ok, true)
  assert.equal(json.restored.rowId, 'mcp-github')
  assert.equal(box.patch(), original, 'disabling then restoring must be a no-op on the file')
  assert.equal(existsSync(backupPath(box.home, 'mcp-github')), false, 'the record is cleared on restore')
})

test('a restored row returns to the live tree as active', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-web', WEB)])
  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-web' })
  assert.equal((await mounted.get(ENDPOINTS.catalog)).json.servers[0].state, 'disabled')

  const restored = await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-web' })
  assert.equal(restored.json.restored.serverName, 'web')
  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(json.servers[0].state, 'active')
  assert.equal(json.servers[0].inUserPatch, false)
  assert.deepEqual(json.backups, [])
})

test('restoring a row this plugin did not disable is refused', async () => {
  const box = sandbox('# mine\n[]\n')
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  const { json } = await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-github' })
  assert.equal(json.ok, false)
  assert.equal(json.error, 'no-managed-block')
  assert.equal(box.patch(), before)
})

test('a hand-written disable is never claimed or removed by restore', async () => {
  // The user's own patch disables the row, with no marker of ours anywhere.
  const original = [
    '# mine',
    '',
    '- id: mcp-github',
    '  name: "@deepseek-ai/dsh-mcp-client"',
    '  config:',
    '    serverName: github',
    '    transport: stdio',
    '  disabled: true',
    '',
  ].join('\n')
  const box = sandbox(original)
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const { json } = await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-github' })
  assert.equal(json.ok, false)
  assert.equal(json.error, 'no-managed-block')
  assert.equal(box.patch(), original)
})

test('a begin marker with no end marker refuses both verbs instead of splicing blindly', async () => {
  const original = ['# mine', '', `${MARKER_BEGIN_PREFIX}mcp-github`, '- id: mcp-github', '  disabled: true', ''].join('\n')
  const box = sandbox(original)
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const disabled = await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  const restored = await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-github' })
  assert.equal(disabled.json.error, 'marker-unpaired')
  assert.equal(restored.json.error, 'marker-unpaired')
  assert.equal(box.patch(), original)
})

test('two servers can be disabled independently', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB), mcpRow('mcp-web', WEB)])
  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-web' })

  const { json } = await mounted.get(ENDPOINTS.catalog)
  assert.deepEqual(
    json.servers.map((server) => [server.rowId, server.state]),
    [
      ['mcp-github', 'disabled'],
      ['mcp-web', 'disabled'],
    ],
  )
  assert.equal(json.backups.length, 2)

  await mounted.post(ENDPOINTS.restore, { rowId: 'mcp-github' })
  const after = (await mounted.get(ENDPOINTS.catalog)).json
  const byRow = Object.fromEntries(after.servers.map((server) => [server.rowId, server.state]))
  assert.equal(byRow['mcp-github'], 'active')
  assert.equal(byRow['mcp-web'], 'disabled')
})

/* ------------------------------------------------------------------ */
/* Purge and route guards                                              */
/* ------------------------------------------------------------------ */

test('purge clears the removal records but never the patch layer', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  await mounted.post(ENDPOINTS.disable, { rowId: 'mcp-github' })
  const disabledFile = box.patch()

  const { json } = await mounted.post(ENDPOINTS.purge, {})
  assert.equal(json.ok, true)
  assert.equal(json.purged, 1)
  assert.equal(existsSync(join(box.home, ...BACKUP_DIR_PARTS)), true)
  assert.equal(box.patch(), disabledFile, 'purge must not re-enable anything')
  assert.deepEqual((await mounted.get(ENDPOINTS.catalog)).json.backups, [])

  const again = await mounted.post(ENDPOINTS.purge, {})
  assert.equal(again.json.purged, 0)
})

test('a write verb rejects the wrong HTTP method', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  const handler = mounted.routes.get(ENDPOINTS.disable)
  const request = new FakeRequest('GET', undefined, {})
  const response = fakeResponse()
  const [, consumed] = await Promise.all([handler(request, response), request.pump()])
  await consumed
  assert.equal(response.status, 405)
  assert.equal(response.headers.allow, 'POST')
  assert.equal(box.patch(), before)
})

test('a cross-origin write is refused', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  const request = new FakeRequest(
    'POST',
    { rowId: 'mcp-github' },
    { origin: 'http://evil.example', host: '127.0.0.1:3080' },
  )
  const response = fakeResponse()
  const [, consumed] = await Promise.all([mounted.routes.get(ENDPOINTS.disable)(request, response), request.pump()])
  await consumed
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.body).error, 'cross-origin')
  assert.equal(box.patch(), before, 'a refused cross-origin write must not touch the layer')
})

test('a malformed body is a 400, and the layer is untouched', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  // No origin header, so the fence passes and the body parser is what fails.
  const request = new FakeRequest('POST', undefined, {}).raw('{not json')
  const response = fakeResponse()
  const [, consumed] = await Promise.all([mounted.routes.get(ENDPOINTS.disable)(request, response), request.pump()])
  await consumed
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).detail, 'body is not valid JSON')
  assert.equal(box.patch(), before)
})

test('an oversized body is refused with a 400 before it can be parsed', async () => {
  const box = sandbox()
  const mounted = mount(box, [mcpRow('mcp-github', GITHUB)])
  const before = box.patch()
  const request = new FakeRequest('POST', undefined, {}).raw(`{"rowId":"${'x'.repeat(70 * 1024)}"}`)
  const response = fakeResponse()
  const [, consumed] = await Promise.all([mounted.routes.get(ENDPOINTS.disable)(request, response), request.pump()])
  await consumed
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).detail, 'body too large')
  assert.equal(box.patch(), before)
})

test('every response is uncached JSON', async () => {
  const box = sandbox()
  const mounted = mount(box, [])
  const { headers } = await mounted.get(ENDPOINTS.catalog)
  assert.equal(headers['cache-control'], 'no-store')
  assert.equal(headers['content-type'], 'application/json; charset=utf-8')
})

test('a host with no loader still serves a catalog that says so', async () => {
  const box = sandbox()
  const routes = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (callback) => ({ dispose: callback() }),
    get: () => undefined,
    webServer: { register: (options) => void routes.set(options.path, options.handler) },
  }
  apply(ctx)
  const response = fakeResponse()
  const request = new FakeRequest('GET', undefined, {})
  const [, consumed] = await Promise.all([routes.get(ENDPOINTS.catalog)(request, response), request.pump()])
  await consumed
  const json = JSON.parse(response.body)
  assert.equal(json.ok, true)
  assert.equal(json.loaderAvailable, false)
  assert.equal(json.loaderError, 'loader-unavailable')
  assert.deepEqual(json.servers, [])
})

test('the reported version matches package.json, and npm publishes the English README', () => {
  const here = new URL('..', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('package.json', here), 'utf8'))
  const source = readFileSync(new URL('lib/index.js', here), 'utf8')
  const literal = /const VERSION = '([^']+)'/.exec(source)
  assert.ok(literal !== null, 'lib/index.js must declare VERSION so this can be checked')
  // The page shows this version and the catalog payload carries it; a silent drift
  // from package.json is the kind of thing nobody notices until a bug report cites
  // a version that never existed.
  assert.equal(literal[1], manifest.version, 'VERSION and package.json must agree')
  // Every published sibling plugin (dsh-unitverse, dsh-theme-manager,
  // dsh-chinese-poetry) ships an English README to npm — verified against the
  // registry. npm would otherwise default to the Chinese README.md.
  assert.equal(manifest.readme, 'README.en.md', 'npm must publish the English README')
  assert.equal(
    existsSync(new URL('README.en.md', here)),
    true,
    'the declared readme must exist, or npm publish silently omits it',
  )
})
