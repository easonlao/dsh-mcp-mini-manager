/**
 * End-to-end smoke check of the real entry points.
 *
 * Loads `lib/index.js` and `lib/client.js` in one process, against a scratch
 * harness home and a fake Cordis context, then walks the whole cycle: catalog →
 * refusals (cross-origin, path-shaped ids, unknown rows) → disable → verify the
 * row is still visible and identifiable → restore → verify the layer is
 * byte-identical → purge. The fake Loader composes patch layers the way
 * `applyEntryPatches` does, key by key, so the round trip is exercised against
 * real composition semantics rather than a guess at them.
 *
 * `node --test` covers the same logic with far more cases; this exists to prove
 * the two halves actually load and talk to each other. Run with `npm run smoke`.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mmm-verify-'))
// `resolveHarnessHome()` is process-level, so point it at this scratch home.
// Without this the run would write removal records into the real ~/.dsh.
process.env.DSH_HOME = home
const profileDir = join(home, 'profiles', 'web')
mkdirSync(profileDir, { recursive: true })
const patchPath = join(profileDir, 'cordis.patch.yml')
// A previous interrupted run may have left its own state behind in this scratch
// home; every section below assumes it starts clean.
rmSync(join(home, '.mcp-mini-manager'), { recursive: true, force: true })

// A profile layer shaped exactly like this machine's: comments, an existing
// id-targeted override, a real MCP row, and a !!js expression.
const originalPatch = [
  '# user patch layer',
  '[]',
  '',
  '- id: dsh-cube-es-mcp',
  '  config:',
  '    allowPanelWrites: true',
  '',
  '- id: mcp-github',
  '  name: "@deepseek-ai/dsh-mcp-client"',
  '  config:',
  '    serverName: github',
  '    transport: stdio',
  '    command: npx',
  '    args:',
  '      - "-y"',
  '      - "@modelcontextprotocol/server-github"',
  '    env:',
  '      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN',
  '',
].join('\n')
writeFileSync(patchPath, originalPatch, 'utf8')

/* ----------------------------- fake live loader ----------------------------- */

/**
 * The composed patch list, read the way `applyEntryPatches` reads it: `insert`
 * lists unwrapped in place, `insert` items only as top-level keys, and
 * id-targeted patches contributing exactly the keys they carry.
 */
const patchLayer = () => {
  const scalars = ['id', 'name', 'disabled', 'serverName', 'transport', 'command', 'url']
  const entries = []
  let current = null
  let insertIndent = null
  for (const line of readFileSync(patchPath, 'utf8').split('\n')) {
    // A patch-list item is `- id:` at column 0, or inside an `insert:` list at
    // exactly four columns. A nested sequence under `args:` is neither, which is
    // what keeps `- "-y"` from being read as an entry.
    const item = /^( {4})?- id: (.+)$/.exec(line)
    if (item !== null && (item[1] === undefined || insertIndent === 4)) {
      current = { id: item[2].trim(), options: {}, inserted: item[1] !== undefined }
      entries.push(current)
      continue
    }
    const key = /^( *)([a-zA-Z][a-zA-Z0-9]*): (.*)$/.exec(line)
    if (key === null || current === null) continue
    const indent = key[1].length
    const name = key[2]
    const raw = key[3].trim()
    if (name === 'insert' && raw === '') {
      insertIndent = 4
      current = null
      continue
    }
    // Only a loader option is a composition key: a top-level key of an inserted
    // entry (indent 6) or of the patch itself (indent 2). Anything deeper is a
    // nested `config:` field and contributes nothing to composition.
    if (!scalars.includes(name)) continue
    if (name === 'config') continue
    const own = current.inserted ? 6 : 2
    if (indent !== own) continue
    // YAML strips the quotes; the Loader never sees them.
    const value = raw.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')
    current.options[name] = value === 'true' ? true : value === 'false' ? false : value
  }
  return entries
}

/**
 * The live tree, composed the way the Loader composes it: apply every patch in
 * file order, key by key, so a later id-targeted patch overrides only the keys
 * it carries, then resolve `disabled` (which the Loader may hold as a `!!js`
 * node) and drop the rows that are out of service.
 */
const liveEntries = () => {
  const composed = new Map()
  for (const row of patchLayer()) {
    const existing = composed.get(row.id)
    if (existing === undefined) composed.set(row.id, { ...row.options })
    else Object.assign(existing, row.options)
  }
  const rows = []
  for (const [id, options] of composed) {
    const disabled = options.disabled === true || options.disabled === 'true'
    if (disabled) continue
    rows.push({
      id,
      options: {
        ...options,
        id,
        config:
          id === 'mcp-github'
            ? {
                serverName: 'github',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                // Exactly the shape the Loader exposes: `isJsExpr` is
                // `"__jsExpr" in value`, and the raw node stays in options.
                env: { GITHUB_TOKEN: { __jsExpr: 'process.env.GITHUB_TOKEN' } },
              }
            : {},
      },
      fiber: { state: 2 },
    })
  }
  return rows
}

/* ------------------------------- fake context ------------------------------- */

const routes = new Map()
const ctx = {
  // Providers are what `inject: ['webServer']` consumes.
  get: (service) =>
    service === 'loader'
      ? {
          entries: liveEntries,
          // The Loader is constructed with `baseUrl` as a *config* field; that is
          // how the host derives the profile root.
          config: { baseUrl: profileDir },
        }
      : service === 'tools'
        ? {
            schemas: () => [
              { name: 'mcp__github__create_issue', description: 'Open an issue' },
              { name: 'mcp__github__list_repos', description: 'List repositories' },
              { name: 'read_file', description: 'not an MCP tool' },
            ],
          }
        : undefined,
  effect: (callback) => callback(),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
  loader: { entries: liveEntries, config: { baseUrl: profileDir } },
}

/* --------------------------------- fake HTTP -------------------------------- */

class FakeRequest extends EventEmitter {
  constructor({ method = 'GET', body, origin, host = '127.0.0.1:3080' } = {}) {
    super()
    this.method = method
    this.headers = { host }
    if (origin) this.headers.origin = origin
    this.destroyed = false
    const payload = body === undefined ? '' : JSON.stringify(body)
    setImmediate(() => {
      if (this.destroyed) return
      if (payload.length > 0) this.emit('data', Buffer.from(payload, 'utf8'))
      this.emit('end')
    })
  }
  destroy() {
    this.destroyed = true
    return this
  }
}

function fakeResponse() {
  const chunks = []
  const response = {
    statusCode: null,
    headers: null,
    body: null,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end(text) {
      this.ended = true
      if (text !== undefined) chunks.push(text)
      this.body = chunks.join('')
      return this
    },
    json() {
      return JSON.parse(this.body)
    },
  }
  return response
}

/** Invoke one mounted route and settle once the body is written. */
async function call(path, { method = 'GET', body, origin } = {}) {
  const handler = routes.get(path)
  assert.ok(handler, `no route mounted at ${path}`)
  const request = new FakeRequest({ method, body, origin })
  const response = fakeResponse()
  handler(request, response)
  for (let attempt = 0; attempt < 200 && !response.ended; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(response.ended, true, `${path} never answered`)
  return response
}

/* ------------------------------- the real run ------------------------------- */

const host = await import('../lib/index.js')
assert.equal(host.name, 'dsh-mcp-mini-manager')
assert.deepEqual(host.inject, ['webServer'])
host.apply(ctx)

console.log('mounted routes:')
for (const path of routes.keys()) console.log('  ' + path)

const catalog = (await call('/dsh-mcp-mini-manager/api/catalog')).json()
assert.equal(catalog.ok, true)

console.log('\nservers in the catalog:')
for (const server of catalog.servers) {
  console.log(
    `  ${server.rowId}  state=${server.state}  transport=${server.transport}  ` +
      `endpoint=${server.endpoint}  tools=${server.toolCount}  origin=${server.origin}`,
  )
}
assert.equal(catalog.servers.length, 1)
assert.equal(catalog.servers[0].rowId, 'mcp-github')
assert.equal(catalog.servers[0].serverName, 'github')
assert.equal(catalog.servers[0].transport, 'stdio')
assert.equal(catalog.servers[0].endpoint, 'npx -y @modelcontextprotocol/server-github')
assert.equal(catalog.servers[0].state, 'active')
assert.equal(catalog.servers[0].toolCount, 2, 'only mcp__* tools count')
assert.deepEqual(
  catalog.servers[0].expressionKeys,
  ['env.GITHUB_TOKEN'],
  'a nested !!js field is named by path',
)
// The whole payload must never carry an expression's source or an env value.
const payload = JSON.stringify(catalog)
assert.doesNotMatch(payload, /__jsExpr/, 'the raw expression node must not reach the page')
assert.doesNotMatch(payload, /process\.env\.GITHUB_TOKEN/, 'the expression source must not reach the page')
assert.deepEqual(
  catalog.servers[0].envKeys,
  ['GITHUB_TOKEN'],
  'env is reported by key name only',
)

/* -- cross-origin is refused before anything else -- */
const crossOrigin = await call('/dsh-mcp-mini-manager/api/disable', {
  method: 'POST',
  body: { rowId: 'mcp-github' },
  origin: 'http://evil.example',
})
assert.equal(crossOrigin.statusCode, 403)
assert.equal(crossOrigin.json().error, 'cross-origin')
assert.equal(readFileSync(patchPath, 'utf8'), originalPatch, 'a refused request must not write')

/* -- a path-shaped row id is refused by grammar -- */
for (const bad of ['../secrets', 'a/b', 'C:\\Windows\\system32', '', 'x'.repeat(200)]) {
  const refused = await call('/dsh-mcp-mini-manager/api/disable', { method: 'POST', body: { rowId: bad } })
  assert.equal(refused.json().error, 'bad-row-id', `row id ${JSON.stringify(bad)} must be refused`)
}
assert.equal(readFileSync(patchPath, 'utf8'), originalPatch, 'no path-shaped id may reach the filesystem')

/* -- an unknown but well-formed row id is refused -- */
const unknown = await call('/dsh-mcp-mini-manager/api/disable', { method: 'POST', body: { rowId: 'mcp-nope' } })
assert.equal(unknown.json().error, 'unknown-row')

/* -- disable -- */
const disabled = (await call('/dsh-mcp-mini-manager/api/disable', { method: 'POST', body: { rowId: 'mcp-github' } })).json()
assert.equal(disabled.ok, true, `disable answered: ${JSON.stringify(disabled)}`)
assert.equal(disabled.disabled.rowId, 'mcp-github')
assert.equal(disabled.disabled.serverName, 'github')
assert.equal(disabled.live, true, `after disable, disk tail:\n${readFileSync(patchPath, 'utf8').split('\n').slice(-12).map((l) => '  |' + l).join('\n')}`)
console.log(`\ndisable -> effect=${disabled.effect} live=${disabled.live} serverName=${disabled.disabled.serverName}`)
assert.equal(disabled.effect, 'applied', 'the fake loader hot-applies the write')
assert.deepEqual(
  liveEntries().map((entry) => entry.id),
  ['dsh-cube-es-mcp'],
  'the disabled row left the live tree',
)

const afterDisable = readFileSync(patchPath, 'utf8')
assert.ok(afterDisable.startsWith(originalPatch), 'every original byte is preserved')
assert.ok(afterDisable.includes('!!js process.env.GITHUB_TOKEN'), 'the !!js expression survives verbatim')
console.log('\nwritten tail:')
console.log(
  afterDisable
    .slice(originalPatch.length)
    .split('\n')
    .map((line) => '  | ' + line)
    .join('\n'),
)

/* -- the disabled row is still listed, with its config recovered -- */
const after = (await call('/dsh-mcp-mini-manager/api/catalog')).json()
assert.equal(after.servers.length, 1, 'a disabled row must stay visible')
assert.equal(after.servers[0].state, 'disabled')
assert.equal(after.servers[0].serverName, 'github', 'the server name is recovered')
assert.equal(after.servers[0].transport, 'stdio')
assert.equal(after.servers[0].endpoint, 'npx -y @modelcontextprotocol/server-github')
assert.equal(after.servers[0].origin, 'managed-disable')
assert.equal(after.backups.length, 1)
console.log(`\nafter disable: state=${after.servers[0].state} name=${after.servers[0].serverName} ` +
  `endpoint=${after.servers[0].endpoint} origin=${after.servers[0].origin}`)

/* -- removing it twice is refused -- */
const twice = await call('/dsh-mcp-mini-manager/api/disable', { method: 'POST', body: { rowId: 'mcp-github' } })
assert.equal(twice.json().error, 'already-disabled')

/* -- restore is byte-for-byte -- */
const restored = (await call('/dsh-mcp-mini-manager/api/restore', { method: 'POST', body: { rowId: 'mcp-github' } })).json()
assert.equal(restored.ok, true)
assert.equal(readFileSync(patchPath, 'utf8'), originalPatch, 'restore reproduces the original file exactly')
assert.deepEqual(
  liveEntries().map((entry) => entry.id),
  ['dsh-cube-es-mcp', 'mcp-github'],
  'the row is back in the live tree',
)
console.log(`\nrestore -> effect=${restored.effect}; file identical to the original: true`)

/* -- purge clears records only -- */
// Restore consumed the only record, so re-disable once to have one to purge.
const again = (await call('/dsh-mcp-mini-manager/api/disable', { method: 'POST', body: { rowId: 'mcp-github' } })).json()
assert.equal(again.ok, true, `second disable answered: ${JSON.stringify(again)}`)
const stateRoot = join(home, '.mcp-mini-manager')
const recordsDir = join(stateRoot, 'removed')
assert.equal(existsSync(recordsDir), true, 'disabling creates the removal-record directory')
assert.equal(readdirSync(recordsDir).length, 1, 'a removal record was written')

const purged = (await call('/dsh-mcp-mini-manager/api/purge', { method: 'POST', body: {} })).json()
assert.equal(purged.ok, true)
assert.equal(
  readdirSync(recordsDir).length,
  0,
  'purge empties the records',
)
console.log(`purge -> removed ${purged.purged} record(s)`)

// Finally: purge must never have restored anything, so the row is still out.
assert.deepEqual(liveEntries().map((entry) => entry.id), ['dsh-cube-es-mcp'])
const afterPurge = (await call('/dsh-mcp-mini-manager/api/catalog')).json()
assert.equal(afterPurge.servers[0].state, 'disabled')
assert.equal(afterPurge.servers[0].serverName, 'github', 'config is still recovered from the patch layer')
assert.equal(afterPurge.backups.length, 0)
console.log('after purge: the row is still disabled, and still identifiable')

// And leaving the layer clean at the end.
const finalRestore = (await call('/dsh-mcp-mini-manager/api/restore', { method: 'POST', body: { rowId: 'mcp-github' } })).json()
assert.equal(finalRestore.ok, true)
assert.equal(readFileSync(patchPath, 'utf8'), originalPatch)

/* -- the browser half loads and contributes its page -- */
const previousWindow = globalThis.window
const previousDocument = globalThis.document
let bundle
globalThis.window = { __ModuleLoader__: { load: (spec) => (bundle = spec) } }
globalThis.document = { createElement: () => ({ dataset: {}, parentNode: null }), head: { appendChild() {} } }
try {
  await import('../lib/client.js?verify=1')
} finally {
  globalThis.window = previousWindow
  globalThis.document = previousDocument
}
const dictionaries = []
const sections = []
const client = bundle.factory(() => ({
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}))
client.apply({
  effect: (callback) => callback(),
  locale: {
    register: (ns, dicts) => dictionaries.push({ ns, dicts }),
    bind: (ns) => (key) => {
      const entry = dictionaries.find((candidate) => candidate.ns === ns)
      return entry ? (entry.dicts.zh[key] ?? key) : key
    },
    subscribe: () => () => {},
  },
  slots: {
    inject: (name, callback) => callback(),
    register: (options) => sections.push(options),
  },
})
assert.equal(bundle.id, 'dsh-mcp-mini-manager')
assert.equal(sections[0].id, 'mcp-mini-manager')
assert.equal(sections[0].order, 16)
assert.equal(Object.keys(dictionaries[0].dicts.zh).length, Object.keys(dictionaries[0].dicts.en).length)
console.log(
  `\nclient bundle: id=${bundle.id} section=${sections[0].id} order=${sections[0].order} ` +
    `label=${sections[0].label()} keys=${Object.keys(dictionaries[0].dicts.zh).length}/locale`,
)

rmSync(home, { recursive: true, force: true })
console.log('\nALL CHECKS PASSED')
