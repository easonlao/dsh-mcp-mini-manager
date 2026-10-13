/**
 * dsh-mcp-mini-manager — host half.
 *
 * Mounts five exact HTTP routes on the host `webServer` service so the browser
 * half can read the MCP catalog and take one server out of service:
 *
 *   GET  /dsh-mcp-mini-manager/api/catalog   list MCP rows + removal backups
 *   POST /dsh-mcp-mini-manager/api/disable   {"rowId": "<loader row id>"}
 *   POST /dsh-mcp-mini-manager/api/restore   {"rowId": "<loader row id>"}
 *   POST /dsh-mcp-mini-manager/api/purge     empty the removal backups
 *   GET  /dsh-mcp-mini-manager/api/rows      raw loader rows (diagnostics)
 *
 * Four properties this file is built around:
 *
 * 1. **A live loader read is not enough, and neither is a disk read.** An MCP
 *    server IS one loader row (`@deepseek-ai/dsh-mcp-client`), so the live entry
 *    tree is authoritative — for rows that are composed. A row this plugin
 *    disabled lives in no tree at all, so the composed patch layers are read too
 *    and the two views are reconciled in `./catalog.js`.
 * 2. **Removal is a patch, never an edit.** Disabling writes an id-targeted
 *    `disabled: true` entry into the user's own `cordis.patch.yml`, the last
 *    layer of the composition. No package file is ever written, no row is
 *    deleted, and no YAML is round-tripped — the write is a line splice that
 *    leaves every other byte, comment and `!!js` expression exactly as it was,
 *    because that file is shared with whatever else the user has configured.
 * 3. **The browser never names a path or a YAML fragment.** It sends a row id
 *    that came from this catalog; the host re-derives the target file and the
 *    exact block from `planDisable`/`planRestore`, after re-checking that the row
 *    really is an MCP client row.
 * 4. **Every write is recoverable.** The original row is recorded under
 *    `<dshHome>/.mcp-mini-manager/removed/` before the patch is written, so
 *    restore is available even for a row whose bundle later changed.
 *
 * @module dsh-mcp-mini-manager
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BACKUP_DIR_PARTS,
  MCP_PLUGIN_NAME,
  PROFILE_PATCH_FILENAME,
  backupPath,
  bundlePatchPaths,
  describeConfig,
  displayPath,
  hasUnpairedMarker,
  isAbsolutePath,
  isMcpModule,
  isMcpPluginName,
  isRowId,
  labelFromRowId,
  loadPatchFile,
  managedRowIdsIn,
  mcpRowsFromPatches,
  messageOf,
  ORIGIN,
  PATCH_LAYER,
  parseYamlSubset,
  planDisable,
  planRestore,
  readJsonFile,
  readTextFile,
  reconcileRows,
  resolveHarnessHome,
  resolveProfileDir,
} from './catalog.js'

/** Cordis plugin name; also the loader entry id the client bundle registers under. */
export const name = 'dsh-mcp-mini-manager'

/** The plugin is useless without the HTTP carrier that serves its browser half. */
export const inject = ['webServer']

/** Version reported in the catalog payload; kept in step with package.json. */
const VERSION = '1.5.2'

/** Route base. Outside `/api`, which the host's own request fence owns. */
export const API_BASE = '/dsh-mcp-mini-manager/api'

/** The exact routes this plugin claims. */
export const ENDPOINTS = Object.freeze({
  catalog: `${API_BASE}/catalog`,
  disable: `${API_BASE}/disable`,
  restore: `${API_BASE}/restore`,
  purge: `${API_BASE}/purge`,
  rows: `${API_BASE}/rows`,
})

/** Upper bound on a JSON request body; every request this page sends is tiny. */
const MAX_BODY_BYTES = 64 * 1024

/** How many installed packages the read-only advisory scan will open. */
const MAX_ADVISORY_PACKAGES = 400

/** Runtime mirror of the Loader's `FiberState` const enum. */
const FIBER_PHASE = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/**
 * Describe one live Loader entry as an MCP row, or refuse it.
 *
 * Used only as a guard: a row id arriving over HTTP is checked against the live
 * tree through this before any file is touched, so the page cannot ask this
 * plugin to disable a row that is not an MCP client.
 *
 * @param entry - a Loader `Entry`.
 * @returns the descriptor, or `undefined` when the row is not an MCP client row.
 */
function describeLiveEntry(entry) {
  const moduleName = typeof entry?.options?.name === 'string' ? entry.options.name : null
  if (!isMcpModule(moduleName) && !isMcpPluginName(moduleName)) return undefined
  // `entry.id` is the *resolved path*, not the row's own id: `EntryTree.resolve()`
  // splits it on `EntryTree.sep` and walks `store` segment by segment, so a row
  // declared as `- insert: [{id: mcp-grafana}]` under the root include reports
  // `include:mcp-grafana`. A patch addresses the row by the id it was declared
  // with, so `options.id` is the one that can actually target it — reporting the
  // composed path both invented a second row for the same server and pointed the
  // disable at an id no patch can resolve.
  const rowId = typeof entry?.options?.id === 'string' ? entry.options.id : entry.id
  if (!isRowId(rowId)) return undefined
  const config = typeof entry.options.config === 'object' && entry.options.config !== null ? entry.options.config : null
  const phase = entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null)
  return {
    rowId,
    // Kept for diagnostics: the path the Loader resolved this row through.
    loadedPath: typeof entry.id === 'string' && entry.id !== rowId ? entry.id : null,
    moduleName,
    config,
    serverName: typeof config?.serverName === 'string' ? config.serverName : null,
    disabled: entry.disabled === true,
    enabled: entry.disabled !== true,
    fiberPhase: phase,
  }
}

/**
 * Read the live MCP rows out of the Loader.
 *
 * `ctx.get('loader')` is resolved per request rather than injected at mount:
 * the Settings page must still appear — and explain itself — on a host whose
 * loader never arrives, instead of the whole plugin going silently absent.
 *
 * @param ctx - the plugin's context.
 * @returns the live rows plus a diagnostic when there is no usable loader.
 */
function liveRows(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined || typeof loader.entries !== 'function') {
    return { rows: [], loaderAvailable: false, error: 'loader-unavailable' }
  }
  const rows = []
  const errors = []
  try {
    for (const entry of loader.entries()) {
      if (entry?.options?.group === true) continue
      try {
        const described = describeLiveEntry(entry)
        if (described !== undefined) rows.push(described)
      } catch (error) {
        errors.push(messageOf(error))
      }
    }
  } catch (error) {
    return { rows, loaderAvailable: false, error: messageOf(error) }
  }
  return { rows, loaderAvailable: true, error: errors.length > 0 ? errors.join('; ') : null }
}

/**
 * The `baseUrl` the Loader was constructed with, which is the profile root.
 * @param ctx - the plugin's context.
 * @returns the base URL, or `undefined` when the Loader declares none.
 */
function loaderBaseUrl(ctx) {
  const loader = ctx.get('loader')
  const baseUrl = loader?.config?.baseUrl
  return typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined
}

/**
 * Read every layer that can declare an MCP row, in application order.
 *
 * Order matters and is not invented here: `@deepseek-ai/dsh-app-boot` composes
 * bundle patches, then the profile's own patch layer, then the harness-home
 * layer. Only the profile layer is ever written, because that is the layer the
 * user owns and the layer the deployment already edits.
 *
 * @param profileDir - absolute profile directory, when one was found.
 * @param home - absolute harness home.
 * @returns the layers, the write target, and per-layer parse diagnostics.
 */
function readLayers(profileDir, home) {
  const profilePatch = profileDir === undefined ? undefined : join(profileDir, PROFILE_PATCH_FILENAME)
  const homePatch = join(home, PROFILE_PATCH_FILENAME)

  const managed = new Set()
  const bundles = profileDir === undefined ? [] : bundlePatchPaths(profileDir)
  const layers = []
  for (const bundle of bundles) {
    if (!bundle.exists) continue
    const loaded = loadPatchFile(bundle.patchPath)
    for (const rowId of managedRowIdsIn(loaded.text)) managed.add(rowId)
    layers.push({ label: bundle.name, kind: 'bundle', path: bundle.patchPath, ...tagPatches(loaded, 'bundle') })
  }
  if (profilePatch !== undefined && existsSync(profilePatch)) {
    const loaded = loadPatchFile(profilePatch)
    for (const rowId of managedRowIdsIn(loaded.text)) managed.add(rowId)
    layers.push({
      label: 'profile',
      kind: 'profile-patch',
      path: profilePatch,
      ...tagPatches(loaded, 'profile-patch'),
    })
  }
  // Applied after the profile layer, so reading it last is reading it in order.
  if (existsSync(homePatch)) {
    const loaded = loadPatchFile(homePatch)
    for (const rowId of managedRowIdsIn(loaded.text)) managed.add(rowId)
    layers.push({ label: 'home', kind: 'home-patch', path: homePatch, ...tagPatches(loaded, 'home-patch') })
  }
  return { layers, profilePatch, homePatch, managed }
}

/**
 * Brand each parsed patch with the layer it came from.
 *
 * Without this the only available signal is the patch's shape, and shape cannot
 * distinguish a package's `insert` from a user's hand-written `insert` — which is
 * exactly the distinction the page reports as a row's origin.
 *
 * @param loaded - a result of {@link loadPatchFile}.
 * @param kind - the layer kind, e.g. `bundle` or `profile-patch`.
 * @returns `loaded` with its patches branded.
 */
function tagPatches(loaded, kind) {
  if (Array.isArray(loaded?.patches)) {
    for (const patch of loaded.patches) {
      if (typeof patch === 'object' && patch !== null) {
        Object.defineProperty(patch, PATCH_LAYER, { value: kind, enumerable: false, configurable: true })
      }
    }
  }
  return loaded
}

/**
 * Read every removal backup this plugin owns, newest first.
 * @param home - absolute harness home.
 * @returns the backup records plus the directory that holds them.
 */
function listBackups(home) {
  const root = join(home, ...BACKUP_DIR_PARTS)
  const entries = []
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return { backups: [], backupRoot: displayPath(root) }
  }
  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue
    const record = readJsonFile(join(root, fileName))
    if (record === undefined || typeof record.rowId !== 'string') continue
    entries.push({
      rowId: record.rowId,
      serverName: typeof record.serverName === 'string' ? record.serverName : null,
      removedAt: typeof record.removedAt === 'number' ? record.removedAt : null,
      removedBy: typeof record.removedBy === 'string' ? record.removedBy : null,
      patchPath: typeof record.patchPath === 'string' ? record.patchPath : null,
      inPatch: isManagedBlockPresent(record.patchPath, record.rowId),
    })
  }
  return {
    backups: entries.sort((a, b) => (b.removedAt ?? 0) - (a.removedAt ?? 0)),
    backupRoot: displayPath(root),
  }
}

/**
 * Whether the user patch layer still carries this plugin's block for one row.
 * @param patchPath - absolute patch path recorded in the backup, if any.
 * @param rowId - the row to look for.
 * @returns whether a managed block is present.
 */
function isManagedBlockPresent(patchPath, rowId) {
  if (typeof patchPath !== 'string' || !isAbsolutePath(patchPath)) return false
  const text = readTextFile(patchPath)
  if (text === undefined) return false
  return text.includes(`# >>> dsh-mcp-mini-manager: disabled mcp row ${rowId}`)
}

/**
 * MCP tools the running tool registry currently exposes.
 *
 * Namespaced tools carry the server name between `mcp__` markers, so they can be
 * attributed to a row exactly. A plugin that speaks MCP internally chooses its
 * own naming and is therefore only listed, never attributed.
 *
 * @param ctx - the plugin's context.
 * @returns per-server tool names plus the total count seen.
 */
function mcpToolsByServer(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.schemas !== 'function') {
    return { byServer: {}, total: 0, available: false }
  }
  let schemas
  try {
    schemas = tools.schemas()
  } catch (error) {
    return { byServer: {}, total: 0, available: false, error: messageOf(error) }
  }
  const byServer = {}
  let total = 0
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const toolName = typeof schema?.name === 'string' ? schema.name : undefined
    if (toolName === undefined) continue
    const match = /^mcp__(.+)__([^_].*)$/.exec(toolName)
    if (match === null) continue
    const [, serverName, rawName] = match
    byServer[serverName] ??= []
    byServer[serverName].push({
      name: toolName,
      rawName,
      description: typeof schema.description === 'string' ? schema.description : null,
    })
    total += 1
  }
  for (const list of Object.values(byServer)) list.sort((a, b) => a.name.localeCompare(b.name))
  return { byServer, total, available: true }
}

/**
 * Installed packages that appear to speak MCP themselves.
 *
 * Read-only advisory: these are ordinary DSH plugins that happen to consume MCP,
 * so removing one of them would be uninstalling a plugin, not removing an MCP
 * server — which is why this plugin only reports them and offers no action.
 *
 * @param profileDir - absolute profile directory, when one was found.
 * @returns one advisory row per detected package.
 */
function advisoryPlugins(profileDir) {
  if (profileDir === undefined) return []
  const modulesRoot = join(profileDir, 'node_modules')
  const found = []
  let names = []
  try {
    names = readdirSync(modulesRoot)
  } catch {
    return []
  }
  let opened = 0
  for (const entryName of names) {
    if (opened >= MAX_ADVISORY_PACKAGES) break
    // Skip the harness's own packages: they are built-ins, not MCP integrations.
    if (entryName === '@deepseek-ai' || entryName === '.bin' || entryName.startsWith('.')) continue
    const packageDir = entryName.startsWith('@')
      ? undefined
      : join(modulesRoot, entryName)
    if (packageDir === undefined) {
      let scoped = []
      try {
        scoped = readdirSync(join(modulesRoot, entryName))
      } catch {
        continue
      }
      for (const child of scoped) {
        const manifest = readJsonFile(join(modulesRoot, entryName, child, 'package.json'))
        opened += 1
        if (manifest === undefined) continue
        const hit = classifyMcpCapable(manifest)
        if (hit !== null) found.push(hit)
      }
      continue
    }
    const manifest = readJsonFile(join(packageDir, 'package.json'))
    opened += 1
    if (manifest === undefined) continue
    const hit = classifyMcpCapable(manifest)
    if (hit !== null) found.push(hit)
  }
  return found.sort((a, b) => a.packageName.localeCompare(b.packageName))
}

/**
 * Decide whether one installed manifest looks like an MCP integration.
 * @param manifest - a parsed `package.json`.
 * @returns the advisory row, or `null` when the package does not look MCP-capable.
 */
function classifyMcpCapable(manifest) {
  const packageName = typeof manifest.name === 'string' ? manifest.name : null
  if (packageName === null) return null
  if (packageName === '@deepseek-ai/dsh-mcp-client' || packageName === name) return null
  const dependencies = {
    ...(typeof manifest.dependencies === 'object' && manifest.dependencies !== null ? manifest.dependencies : {}),
    ...(typeof manifest.peerDependencies === 'object' && manifest.peerDependencies !== null
      ? manifest.peerDependencies
      : {}),
  }
  const sdk = Object.keys(dependencies).find(
    (dependency) => dependency === '@modelcontextprotocol/sdk' || dependency.startsWith('@modelcontextprotocol/'),
  )
  const description = typeof manifest.description === 'string' ? manifest.description : ''
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords.filter((k) => typeof k === 'string') : []
  const mentions = /\bmcp\b/i.test(description) || keywords.some((keyword) => /^mcp$/i.test(keyword))
  if (sdk === undefined && !mentions) return null
  const clientFace = typeof manifest.dsh === 'object' && manifest.dsh !== null && manifest.dsh.client !== undefined
  return {
    packageName,
    version: typeof manifest.version === 'string' ? manifest.version : null,
    since: sdk ?? 'description',
    description: description.length > 0 ? description : null,
    hasClientFace: clientFace,
  }
}

/** Write one response as JSON, never cached. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Refuse a request a browser sent from another origin.
 *
 * These routes are exact registrations on the bare `webServer`, so the host's
 * own `/api` fence never sees them. `Host` is the one header a hostile page
 * cannot forge, so a cross-origin attempt cannot match it — which is what makes
 * this sufficient for the destructive verbs.
 *
 * @returns whether the request was refused and answered here.
 */
function refuseCrossOrigin(request, response) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return false
  const host = request.headers.host
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = undefined
  }
  if (typeof host === 'string' && originHost === host) return false
  sendJson(response, 403, { ok: false, error: 'cross-origin' })
  return true
}

/** Read and parse a JSON request body under the size cap. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {})
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * Write a file atomically enough for a hot-reloaded config layer.
 *
 * The Loader watches this path and reparses it on every change, so a partially
 * written file would be observed as a parse error. Write to a sibling temp file,
 * then rename over the target, which the filesystem makes atomic.
 *
 * @param path - absolute target path.
 * @param text - the complete new file text.
 */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.dsh-mcp-mini-manager.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, text, 'utf8')
  try {
    renameSync(temp, path)
  } catch (error) {
    // A failed rename must not leave its temp file behind in the profile: the
    // Loader watches that directory, and a stray `.yml.*.tmp` is confusing noise.
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * Register this plugin against the host context.
 * @param ctx - host context carrying `webServer`.
 */
export function apply(ctx) {
  const home = resolveHarnessHome()

  /** Resolve the profile once per request; a host may compose it late. */
  const profile = () => resolveProfileDir({ baseUrl: loaderBaseUrl(ctx), home })

  /**
   * Build the full catalog payload. No caching: the Loader and the patch layers
   * are both live, and a cached answer would be the one thing that could go
   * stale between a disable and the reader's next look.
   */
  const catalog = () => {
    const resolved = profile()
    const profileDir = resolved?.dir
    const { layers, profilePatch, homePatch, managed } = readLayers(profileDir, home)
    const { rows: live, loaderAvailable, error: liveError } = liveRows(ctx)
    const { byServer, total: toolTotal, available: toolsAvailable } = mcpToolsByServer(ctx)
    const { backups, backupRoot } = listBackups(home)

    const patchRows = mcpRowsFromPatches(
      layers.flatMap((layer) => layer.patches),
      managed,
    )
    const reconciled = reconcileRows(live, patchRows)

    const servers = reconciled.map((row) => {
      // A row this plugin disabled has no live entry, and its managed block
      // deliberately carries no config, so the removal record is the only place
      // left that still knows what this server was. Without it the page would
      // show a bare row id and an empty summary at exactly the moment the user
      // needs to recognise what they are about to bring back.
      const backup = backups.find((entry) => entry.rowId === row.rowId)
      const backupRecord = backup === undefined ? undefined : readJsonFile(backupPath(home, row.rowId))
      const recordedConfig =
        typeof backupRecord?.config === 'object' && backupRecord.config !== null ? backupRecord.config : null
      const config = row.config ?? recordedConfig
      const described = describeConfig(config)
      const backupServerName =
        typeof backupRecord?.serverName === 'string' && backupRecord.serverName.length > 0
          ? backupRecord.serverName
          : null
      const serverName = row.serverName ?? described.serverName ?? backupServerName
      const toolList = serverName === null ? [] : (byServer[serverName] ?? [])
      // True when the row is described by a file the user edits — either they
      // declared it by hand in their own patch layer, or this plugin put a managed
      // disable block there. Both are "you can see and change this yourself"; a
      // row that only exists inside a package's layer is not.
      const inUserPatch =
        row.origin === ORIGIN.userPatch || isManagedBlockPresent(profilePatch, row.rowId)
      const configSource = row.config != null ? 'live' : recordedConfig === null ? 'none' : 'removal-record'
      return {
        rowId: row.rowId,
        moduleName: row.moduleName,
        origin: row.origin ?? 'live',
        // One state, derived once, so the page cannot show two contradictory
        // badges: a live active fiber, a live failed fiber, a row the layers
        // declare disabled, or a row nothing has observed yet.
        state:
          row.disabled === true || row.disabledInLayer === true
            ? 'disabled'
            : row.fiberPhase === 'active'
              ? 'active'
              : row.fiberPhase === 'failed'
                ? 'failed'
                : row.fiberPhase === 'loading' || row.fiberPhase === 'pending'
                  ? 'starting'
                  : 'unobserved',
        inUserPatch,
        // `described` also carries a `serverName`, so it is spread FIRST: a null
        // from an unknown config must not overwrite the name recovered below
        // from the removal record.
        ...described,
        serverName,
        label: serverName ?? labelFromRowId(row.rowId),
        configSource,
        tools: toolList,
        toolCount: toolList.length,
        removedAt: backup?.removedAt ?? null,
      }
    })

    return {
      ok: true,
      plugin: { name, version: VERSION, endpoint: ENDPOINTS.catalog },
      generatedAt: Date.now(),
      harnessHome: displayPath(home),
      profile: {
        dir: profileDir === undefined ? null : displayPath(profileDir),
        via: resolved?.via ?? null,
        patchPath: profilePatch === undefined ? null : displayPath(profilePatch),
        patchExists: profilePatch !== undefined && existsSync(profilePatch),
        homePatchPath: displayPath(homePatch),
        homePatchExists: existsSync(homePatch),
      },
      loaderAvailable,
      loaderError: liveError,
      toolsAvailable,
      toolTotal,
      layers: layers.map((layer) => ({
        label: layer.label,
        kind: layer.kind,
        path: displayPath(layer.path),
        rows: layer.patches.length,
        unsupported: layer.unsupported,
      })),
      backupRoot,
      servers,
      backups,
      backupsWithoutRow: backups.filter((backup) => !servers.some((server) => server.rowId === backup.rowId)),
      advisory: advisoryPlugins(profileDir),
    }
  }

  /** Raw loader rows, unfiltered, for diagnosing a report that looks wrong. */
  const rawRows = () => {
    const loader = ctx.get('loader')
    if (loader === undefined || typeof loader.entries !== 'function') {
      return { ok: false, error: 'loader-unavailable' }
    }
    const rows = []
    for (const entry of loader.entries()) {
      rows.push({
        rowId: typeof entry.id === 'string' ? entry.id : null,
        moduleName: typeof entry.options?.name === 'string' ? entry.options.name : null,
        isGroup: entry.options?.group === true,
        disabled: entry.disabled === true,
        fiberPhase: entry.fiber === undefined ? null : (FIBER_PHASE[entry.fiber.state] ?? null),
        isMcp: isMcpModule(entry.options?.name) || isMcpPluginName(entry.options?.name),
        configKeys:
          typeof entry.options?.config === 'object' && entry.options.config !== null
            ? Object.keys(entry.options.config).sort()
            : [],
      })
    }
    return { ok: true, count: rows.length, rows }
  }

  /**
   * Take one MCP server out of service by patching the user's own layer.
   *
   * @param rowId - the loader row id the page was shown.
   * @returns the outcome, including whether the change is already live.
   */
  const disable = (rowId) => {
    if (!isRowId(rowId)) return { ok: false, error: 'bad-row-id' }

    const resolved = profile()
    if (resolved === undefined) return { ok: false, error: 'no-profile' }
    const patchPath = join(resolved.dir, PROFILE_PATCH_FILENAME)

    // Guard 0: an opening marker with no closing marker means the file was
    // hand-edited or a write was interrupted. The block's extent is unknown, so
    // neither verb can be bounded honestly — report that rather than guessing.
    const current = readTextFile(patchPath) ?? ''
    if (hasUnpairedMarker(current, rowId)) return { ok: false, error: 'marker-unpaired' }

    // Guard 1: the row must be an MCP client row *right now*.
    const { rows: live, loaderAvailable } = liveRows(ctx)
    const liveRow = live.find((row) => row.rowId === rowId)
    const layers = readLayers(resolved.dir, home)
    const patchRows = mcpRowsFromPatches(
      layers.layers.flatMap((layer) => layer.patches),
      layers.managed,
    )
    const known = liveRow ?? patchRows.get(rowId)
    if (known === undefined) {
      return { ok: false, error: loaderAvailable ? 'unknown-row' : 'loader-unavailable' }
    }
    if (known.disabled === true || known.disabledInLayer === true) {
      return { ok: false, error: 'already-disabled' }
    }

    const source = readTextFile(patchPath) ?? ''
    const described = describeConfig(known.config ?? null)
    const plan = planDisable(source, rowId, {
      serverName: described.serverName ?? liveRow?.serverName ?? null,
      now: Date.now(),
    })
    if (!plan.ok) return { ok: false, error: plan.reason }

    // Record the original row before touching the shared config layer, so a
    // restore is possible even if the bundle that declared it changes later.
    const record = {
      schema: 1,
      rowId,
      serverName: described.serverName ?? liveRow?.serverName ?? null,
      removedAt: Date.now(),
      removedBy: `${name}@${VERSION}`,
      patchPath,
      moduleName: known.moduleName ?? null,
      config: known.config ?? null,
      fiberPhase: liveRow?.fiberPhase ?? null,
    }
    const recordPath = backupPath(home, rowId)
    mkdirSync(dirname(recordPath), { recursive: true })
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')

    try {
      writeAtomic(patchPath, plan.text)
    } catch (error) {
      rmSync(recordPath, { force: true })
      ctx.logger.error(`mcp-mini-manager: writing ${patchPath} failed: ${messageOf(error)}`)
      return { ok: false, error: 'write-failed', detail: messageOf(error) }
    }

    // The Loader watches this layer, so the row is usually gone from the live
    // tree by the next read. Report which of the two actually happened instead
    // of promising a restart the user may not need.
    const after = liveRows(ctx).rows.some((row) => row.rowId === rowId)
    ctx.logger.info(`mcp-mini-manager: disabled mcp row "${rowId}" via ${patchPath}`)
    return {
      ok: true,
      disabled: { rowId, serverName: record.serverName, patchPath: displayPath(patchPath) },
      live: !after,
      effect: after ? 'restart-required' : 'applied',
    }
  }

  /**
   * Re-enable one MCP server by deleting the block this plugin wrote for it.
   * @param rowId - the row to restore.
   * @returns the outcome, including whether the change is already live.
   */
  const restore = (rowId) => {
    if (!isRowId(rowId)) return { ok: false, error: 'bad-row-id' }

    const resolved = profile()
    if (resolved === undefined) return { ok: false, error: 'no-profile' }
    const patchPath = join(resolved.dir, PROFILE_PATCH_FILENAME)
    const source = readTextFile(patchPath)
    if (source === undefined) return { ok: false, error: 'no-patch-file' }

    const plan = planRestore(source, rowId)
    if (!plan.ok) return { ok: false, error: plan.reason }
    try {
      writeAtomic(patchPath, plan.text)
    } catch (error) {
      ctx.logger.error(`mcp-mini-manager: restoring ${rowId} failed: ${messageOf(error)}`)
      return { ok: false, error: 'write-failed', detail: messageOf(error) }
    }

    const recordPath = backupPath(home, rowId)
    const record = readJsonFile(recordPath)
    rmSync(recordPath, { force: true })

    const after = liveRows(ctx).rows.some((row) => row.rowId === rowId)
    ctx.logger.info(`mcp-mini-manager: restored mcp row "${rowId}" in ${patchPath}`)
    return {
      ok: true,
      restored: { rowId, serverName: record?.serverName ?? null, patchPath: displayPath(patchPath) },
      live: after,
      effect: after ? 'applied' : 'restart-required',
    }
  }

  /** Delete every removal backup. Reversible by nothing; the only such verb here. */
  const purge = () => {
    const root = join(home, ...BACKUP_DIR_PARTS)
    if (!existsSync(root)) return { ok: true, purged: 0 }
    let purged = 0
    for (const fileName of readdirSync(root)) {
      if (!fileName.endsWith('.json')) continue
      rmSync(join(root, fileName), { force: true })
      purged += 1
    }
    ctx.logger.info(`mcp-mini-manager: purged ${purged} removal record(s)`)
    return { ok: true, purged }
  }

  /** One guarded JSON route. `body` handlers receive the parsed request body. */
  const route = (path, handler) => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler: async (request, response) => {
            if (refuseCrossOrigin(request, response)) return
            if (request.method !== handler.method) {
              response.writeHead(405, { allow: handler.method })
              response.end()
              return
            }
            try {
              const body = handler.body === true ? await readJsonBody(request) : {}
              sendJson(response, 200, await handler.run(body))
            } catch (error) {
              if (error?.message === 'body too large' || error?.message === 'body is not valid JSON') {
                sendJson(response, 400, { ok: false, error: 'bad-request', detail: error.message })
                return
              }
              ctx.logger.error(error)
              sendJson(response, 500, {
                ok: false,
                error: 'internal',
                detail: String(error?.message ?? error),
              })
            }
          },
        }),
      `mcp-mini-manager: route ${path}`,
    )
  }

  route(ENDPOINTS.catalog, { method: 'GET', run: catalog })
  route(ENDPOINTS.rows, { method: 'GET', run: rawRows })
  route(ENDPOINTS.disable, { method: 'POST', body: true, run: (body) => disable(body.rowId) })
  route(ENDPOINTS.restore, { method: 'POST', body: true, run: (body) => restore(body.rowId) })
  route(ENDPOINTS.purge, { method: 'POST', body: true, run: () => purge() })

  ctx.logger.info(`mcp-mini-manager: mounted ${API_BASE}/* (harness home: ${displayPath(home)})`)
}

export { MCP_PLUGIN_NAME, PROFILE_PATCH_FILENAME }
