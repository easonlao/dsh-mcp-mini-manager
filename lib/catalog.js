/**
 * dsh-mcp-mini-manager — pure catalog / patch-layer logic.
 *
 * Everything here is a pure function over strings and plain data, so the rules
 * that decide "which rows are MCP servers", "what is this server's summary" and
 * "what exactly would we write into the user patch layer" are unit-testable
 * without a Cordis context, a live Loader, or a browser.
 *
 * ## Why the MCP catalog is read from two places
 *
 * In DSH an MCP server **is** one loader row whose module is
 * `@deepseek-ai/dsh-mcp-client` ("each plugin instance connects to one MCP
 * server; load multiple instances in cordis.yml for multiple servers" — that
 * package's own type docs). So the Loader's live entry tree is the authoritative
 * source for anything currently composed, and `Entry.options.config` carries the
 * whole server configuration.
 *
 * But a *disabled* row is deliberately absent from that tree, and a disabled row
 * is exactly what "removed" means here. Restart-invariant truth therefore lives
 * one level down, in the composed patch layers on disk — the profile's own
 * `cordis.patch.yml` (applied last, owned by the user) over the bundle layers
 * (owned by packages, read-only). This module reads both and reconciles them, so
 * the page can still show a server you removed yesterday.
 *
 * ## The one safety rule
 *
 * **The browser never names a path, and never names raw YAML.** The client sends
 * a row ID that it got from this catalog; the host re-derives both the target
 * file and the exact block to write from `planDisable`/`planRestore` here. A
 * compromised page can therefore only ever disable a row this catalog already
 * knows is an MCP client row.
 *
 * @module dsh-mcp-mini-manager/catalog
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Module specifiers that mean "this row is an MCP server".
 *
 * The bare specifier is what bundles and users actually write (see the
 * `cordis.yml` example in `@deepseek-ai/dsh-mcp-client`'s README); the scoped
 * form is accepted too because it is equally valid as an ESM specifier.
 */
export const MCP_MODULE_NAMES = Object.freeze([
  '@deepseek-ai/dsh-mcp-client',
  'dsh-mcp-client',
])

/** Cordis plugin name the MCP client reports to loader diagnostics. */
export const MCP_PLUGIN_NAME = 'mcp-client'

/** The only transport values `@deepseek-ai/dsh-mcp-client` accepts. */
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http'])

/** Profile patch file name; the layer this plugin owns and is allowed to write. */
export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Profile manifest name; read only, to name the installed bundles of a row. */
export const PROFILE_MANIFEST_FILENAME = 'package.json'

/** Directory (under the harness home) holding removal backups. */
export const BACKUP_DIR_PARTS = Object.freeze(['.mcp-mini-manager', 'removed'])

/**
 * Marker lines bracketing every block this plugin writes into the user patch
 * layer. They make the block idempotently re-findable and cleanly removable
 * without a YAML round-trip that would destroy the user's comments — which
 * matters, because that file is hand-edited and its comments carry the "why".
 */
export const MARKER_BEGIN_PREFIX = '# >>> dsh-mcp-mini-manager: disabled mcp row '
export const MARKER_END_PREFIX = '# <<< dsh-mcp-mini-manager: disabled mcp row '

/** Row-id grammar: a loader entry id, deliberately narrow so it cannot name a path. */
const ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** `serverName` grammar, exactly as `@deepseek-ai/dsh-mcp-client` validates it. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Trim a value that may be an environment override; empty means unset. */
function trimOrUndefined(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** One-line description of a thrown value. */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the harness home, mirroring `@deepseek-ai/dsh-home-paths` precedence
 * (`$DSH_HOME`, else `~/.dsh`). Kept local because this package ships outside
 * the harness repository and therefore takes no `@deepseek-ai/*` runtime import.
 *
 * @param env - environment mapping; defaults to `process.env`.
 * @param osHome - operating-system home directory; defaults to `os.homedir()`.
 * @returns the absolute harness home.
 */
export function resolveHarnessHome(env = process.env, osHome = homedir()) {
  return trimOrUndefined(env.DSH_HOME) ?? join(osHome, '.dsh')
}

/**
 * Where one MCP row's removal backup lives.
 * @param home - absolute harness home.
 * @param rowId - loader entry id of the disabled row.
 * @returns absolute path of the backup JSON file.
 */
export function backupPath(home, rowId) {
  return join(home, ...BACKUP_DIR_PARTS, `${encodeURIComponent(rowId)}.json`)
}

/**
 * Whether a value is usable as a loader row id by this plugin.
 *
 * Deliberately stricter than the Loader's own id rules: it admits no path
 * separator, no drive letter and no traversal segment, so a row id can never be
 * turned into a filesystem target even by a bug in a caller.
 *
 * @param value - candidate id.
 * @returns whether it is a safe row id.
 */
export function isRowId(value) {
  return typeof value === 'string' && ROW_ID_PATTERN.test(value) && !value.includes('..')
}

/**
 * Whether a module specifier names the MCP client bridge.
 * @param moduleName - `Entry.options.name` as the Loader reports it.
 * @returns whether this row connects to an MCP server.
 */
export function isMcpModule(moduleName) {
  if (typeof moduleName !== 'string') return false
  const bare = moduleName.trim().replace(/^cordis:/, '')
  return MCP_MODULE_NAMES.includes(bare) || bare.endsWith('/dsh-mcp-client')
}

/**
 * Whether a row's declared plugin name is the MCP client, for trees that carry
 * `name: mcp-client` instead of the package specifier.
 * @param name - candidate plugin name.
 * @returns whether it is the MCP client plugin name.
 */
export function isMcpPluginName(name) {
  return name === MCP_PLUGIN_NAME
}

/**
 * The transport a config declares, or `null` when it declares none.
 * @param config - an MCP client config object.
 * @returns `'stdio'`, `'streamable-http'`, or `null`.
 */
export function transportOf(config) {
  const transport = config?.transport
  return TRANSPORTS.includes(transport) ? transport : null
}

/**
 * A human-readable one-line summary of how this server is reached.
 *
 * The page's "简介" line: for stdio it is the command line, for HTTP it is the
 * endpoint URL, and for a config that omits the transport it says so rather than
 * inventing an answer.
 *
 * @param config - an MCP client config object.
 * @returns the summary string, localized by the caller's own formatting.
 */
export function endpointOf(config) {
  const transport = transportOf(config)
  if (transport === 'stdio') {
    const command = typeof config?.command === 'string' ? config.command : ''
    const args = Array.isArray(config?.args) ? config.args.filter((a) => typeof a === 'string') : []
    return [command, ...args].filter((part) => part.length > 0).join(' ')
  }
  if (transport === 'streamable-http') {
    return typeof config?.url === 'string' ? config.url : ''
  }
  return ''
}

/**
 * Whether one config field holds a live `!!js` expression rather than a literal.
 *
 * The Loader resolves `!!js` against its own context, so the value this plugin
 * reads may already be the resolved result. Reporting which fields came from an
 * expression is what lets the page say "this value is computed" instead of
 * presenting a resolved secret as if it were written in the file.
 *
 * @param value - the raw config value.
 * @returns whether it is a Loader `!!js` expression node.
 */
export function isJsExpression(value) {
  return typeof value === 'object' && value !== null && typeof value.__jsExpr === 'string'
}

/**
 * Report the config fields whose values are `!!js` expressions.
 *
 * This walks **nested** containers, because that is where the interesting ones
 * live: an MCP server's credential is practically always `env.TOKEN` or
 * `headers.Authorization`, never a top-level key. A field is named by its path
 * (`env.GITHUB_TOKEN`), and a nested value that is itself an expression stops the
 * walk — its interior is the expression's business, not ours.
 *
 * @param config - the row's config object.
 * @returns sorted dotted field paths, or an empty array.
 */
function expressionKeys(config) {
  const found = new Set()
  const walk = (value, prefix, depth) => {
    if (depth > 4 || typeof value !== 'object' || value === null) return
    if (isJsExpression(value)) {
      if (prefix.length > 0) found.add(prefix)
      return
    }
    if (Array.isArray(value)) return
    for (const key of Object.keys(value)) {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`
      const child = value[key]
      if (isJsExpression(child)) found.add(path)
      else walk(child, path, depth + 1)
    }
  }
  walk(config, '', 0)
  return [...found].sort()
}

/**
 * Describe one MCP server from a row's config alone.
 *
 * Pure projection: no filesystem, no Loader, no clock. `tools` is filled in
 * later by the host from the live tool registry, because only the host can see
 * it.
 *
 * @param config - the row's config object.
 * @returns the config-derived half of one catalog entry.
 */
export function describeConfig(config) {
  const object = typeof config === 'object' && config !== null ? config : {}
  return {
    serverName: typeof object.serverName === 'string' ? object.serverName : null,
    transport: transportOf(object),
    endpoint: endpointOf(object),
    command: typeof object.command === 'string' ? object.command : null,
    args: Array.isArray(object.args) ? object.args.filter((a) => typeof a === 'string') : null,
    url: typeof object.url === 'string' ? object.url : null,
    cwd: typeof object.cwd === 'string' ? object.cwd : null,
    envKeys:
      typeof object.env === 'object' && object.env !== null ? Object.keys(object.env).sort() : null,
    headerKeys:
      typeof object.headers === 'object' && object.headers !== null
        ? Object.keys(object.headers).sort()
        : null,
    toolCallTimeoutMs:
      typeof object.toolCallTimeoutMs === 'number' ? object.toolCallTimeoutMs : null,
    failOnStartupError: object.failOnStartupError === true,
    reconnectEnabled: object.reconnect?.enabled !== false,
    expressionKeys: expressionKeys(object),
    // A config that declares no transport cannot be connected by the bridge, so
    // the page must not present it as a healthy server.
    complete: TRANSPORTS.includes(object.transport) && typeof object.serverName === 'string',
  }
}

/**
 * Derive a display label for a row that has no readable config.
 *
 * A disabled row is absent from the live tree, so when only the patch layer
 * knows about it the id is all we have; the `mcp-` prefix most deployments use
 * is stripped so the label reads like a server name.
 *
 * @param rowId - the loader entry id.
 * @returns a best-effort display label.
 */
export function labelFromRowId(rowId) {
  const bare = rowId.replace(/^mcp[-_:]/, '')
  return bare.length === 0 ? rowId : bare
}

/* ------------------------------------------------------------------ */
/* YAML: a deliberately small reader for the one document shape we touch */
/* ------------------------------------------------------------------ */

/** Leading-space count of a line; tabs count as two columns, matching YAML. */
function indentOf(line) {
  const match = /^(\s*)/.exec(line)
  return match === null ? 0 : match[1].replaceAll('\t', '  ').length
}

/** Whether a line is blank or a whole-line comment. */
export function isBlankOrComment(line) {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

/** Strip a trailing `# …` comment from a scalar, respecting quotes. */
function stripInlineComment(value) {
  let quote = null
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd()
    }
  }
  return value
}

/**
 * Convert a YAML scalar to a JS value.
 *
 * Only the scalar forms a loader patch file actually uses are recognized.
 * `!!js` expressions are returned as their source text: this plugin never needs
 * to evaluate them, and guessing a value here would be worse than showing the
 * expression that is really in the file.
 *
 * @param raw - the scalar text, already comment-stripped.
 * @returns the parsed value.
 */
export function parseScalar(raw) {
  const text = stripInlineComment(raw).trim()
  if (text.startsWith('!!js')) return { __jsExpr: text.slice(4).trim() }
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === '{}') return {}
  if (text === '[]') return []
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
  if (/^-?\d*\.\d+$/.test(text)) return Number.parseFloat(text)
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1)
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return text
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => parseScalar(part))
  }
  return text
}

/** Split `key: value` on the first unquoted colon. */
function splitKey(line) {
  const trimmed = line.trim()
  let quote = null
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ':') {
      const key = trimmed.slice(0, index).trim()
      if (key.length === 0) return null
      return { key, value: trimmed.slice(index + 1).trim(), rest: trimmed.slice(index + 1) }
    }
  }
  return null
}

/**
 * Parse the subset of YAML that a loader patch layer is written in.
 *
 * Supported: block mappings, block sequences, nested combinations of the two,
 * quoted and plain scalars, `!!js` expressions, and whole-line/inline comments.
 * Not supported (and reported through the returned `unsupported` list rather
 * than silently misread): flow collections spanning lines, anchors/aliases,
 * multi-line block scalars, and merge keys.
 *
 * @param source - the file text.
 * @returns parsed value plus diagnostics about anything it could not represent.
 */
export function parseYamlSubset(source) {
  const lines = String(source).replaceAll('\r\n', '\n').split('\n')
  const unsupported = []
  let cursor = 0

  /** Skip blank and comment-only lines. */
  const skipNoise = () => {
    while (cursor < lines.length && isBlankOrComment(lines[cursor])) cursor += 1
  }

  /** The indentation of the next content line, or `undefined` at end of input. */
  const nextIndent = () => {
    skipNoise()
    return cursor >= lines.length ? undefined : indentOf(lines[cursor])
  }

  /** Whether the next content line opens a sequence item. */
  const nextIsSequence = () => {
    skipNoise()
    if (cursor >= lines.length) return false
    const trimmed = lines[cursor].trim()
    return trimmed === '-' || trimmed.startsWith('- ')
  }

  /**
   * Parse one node: a block sequence when the next line opens an item, a block
   * mapping otherwise. Stops at the first line indented at or below `floor`.
   *
   * @param floor - the parent's indentation; a line at or below it belongs to
   *   the caller, which is what makes nested mappings terminate correctly.
   */
  const parseNode = (floor) => {
    const indent = nextIndent()
    if (indent === undefined || indent <= floor) return null
    return nextIsSequence() ? parseSequence(indent) : parseMapping(indent)
  }

  /** Concatenate the raw lines of a block scalar, which this parser does not interpret. */
  const readBlockScalar = (keyIndent, key) => {
    unsupported.push(`block scalar for key "${key}" is kept verbatim`)
    const collected = []
    for (;;) {
      skipNoise()
      if (cursor >= lines.length) break
      const line = lines[cursor]
      if (indentOf(line) <= keyIndent) break
      collected.push(lines[cursor])
      cursor += 1
    }
    return { __blockScalar: collected.join('\n') }
  }

  /**
   * Assign one `key: value` pair, recursing when the value is nested.
   * @param object - the mapping being built.
   * @param pair - the split `key`/`value` pair.
   * @param keyIndent - indentation of the key's own line; the child floor.
   */
  const assignKey = (object, pair, keyIndent) => {
    const { key, value } = pair
    if (value.length === 0) {
      const child = parseNode(keyIndent)
      object[key] = child === null ? null : child
      return
    }
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      object[key] = readBlockScalar(keyIndent, key)
      return
    }
    object[key] = parseScalar(value)
  }

  /** Read the `key: value` pairs of one mapping whose first key sits at `indent`. */
  const readPairs = (object, indent) => {
    for (;;) {
      skipNoise()
      if (cursor >= lines.length) break
      const line = lines[cursor]
      if (indentOf(line) !== indent) break
      if (line.trim().startsWith('-')) break
      const pair = splitKey(line)
      if (pair === null) {
        unsupported.push(`unparsed line ${cursor + 1}: ${line.trim()}`)
        cursor += 1
        continue
      }
      cursor += 1
      assignKey(object, pair, indent)
    }
  }

  /** Parse a block mapping whose first key sits at exactly `indent`. */
  const parseMapping = (indent) => {
    const object = {}
    readPairs(object, indent)
    return object
  }

  /**
   * Parse a block sequence whose items sit at exactly `indent`.
   *
   * A `- key: value` item keeps its remaining keys at the column of `key` — the
   * dash plus one space — which is where the rest of that item's mapping lives.
   */
  const parseSequence = (indent) => {
    const items = []
    for (;;) {
      skipNoise()
      if (cursor >= lines.length) break
      const line = lines[cursor]
      if (indentOf(line) !== indent) break
      const trimmed = line.trim()
      if (!(trimmed === '-' || trimmed.startsWith('- '))) break

      const inline = trimmed.slice(1).trim()
      const dashOffset = line.length - line.trimStart().length
      cursor += 1
      if (inline.length === 0) {
        items.push(parseNode(indent))
        continue
      }
      const pair = splitKey(inline)
      if (pair === null) {
        items.push(parseScalar(inline))
        continue
      }
      const object = {}
      assignKey(object, pair, dashOffset + 1)
      readPairs(object, dashOffset + 2)
      items.push(object)
    }
    return items
  }

  /**
   * Read the document root.
   *
   * DSH writes an empty profile patch layer as a bare `[]` line (see the profile
   * template in `@deepseek-ai/dsh-app-boot`), and a user then appends rows beneath
   * it. That sentinel means "an empty list", so it is consumed and contributes
   * nothing — treating it as content would fail the whole parse and hide every
   * row below it, which is exactly the shape a stock profile file has.
   */
  const readRoot = () => {
    skipNoise()
    if (cursor < lines.length && lines[cursor].trim() === '[]') cursor += 1
    return nextIsSequence() ? parseSequence(nextIndent() ?? 0) : null
  }

  const root = readRoot()
  skipNoise()
  if (cursor < lines.length) unsupported.push(`trailing content at line ${cursor + 1}`)
  return { value: Array.isArray(root) ? root : [], unsupported }
}

/** Locate the top-level `- id: …` block that a patch file writes for one row. */
function findPatchBlock(lines, rowId) {
  const marker = MARKER_BEGIN_PREFIX + rowId
  for (let start = 0; start < lines.length; start += 1) {
    if (lines[start].trim() !== marker) continue
    let end = start + 1
    while (end < lines.length && lines[end].trim() !== MARKER_END_PREFIX + rowId) end += 1
    return { start, end: end < lines.length ? end : lines.length - 1, marked: end < lines.length }
  }
  return null
}

/**
 * Plan the exact text change that disables one MCP row in the user patch layer.
 *
 * The block is bracketed by marker comments so the change is idempotent
 * (re-disabling finds and replaces its own block) and cleanly reversible
 * (restore deletes the same bracketed range) without a YAML round-trip that
 * would rewrite the user's own comments out of the file.
 *
 * `disabled: true` is the whole payload: patch application assigns by key
 * (`target[key] = value` in `@deepseek-ai/dsh-app-boot`), so overriding
 * `disabled` leaves the row's own `config` untouched and there is no need to —
 * and no risk of — restating it.
 *
 * @param source - current text of the user patch layer.
 * @param rowId - the MCP row to disable.
 * @param facts - display facts recorded in the marker and returned to the page.
 * @returns whether the write is legal, the next file text, and the byte deltas.
 */
export function planDisable(source, rowId, facts = {}) {
  if (!isRowId(rowId)) return { ok: false, reason: 'bad-row-id' }
  const text = String(source)
  // Every layer DSH itself writes ends with a newline, and appending to a file
  // that does not would make disable/restore stop being an exact round trip.
  // Refuse rather than silently add bytes the user did not write.
  if (text.length > 0 && !text.endsWith('\n')) return { ok: false, reason: 'no-trailing-newline' }
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const label = typeof facts.serverName === 'string' && facts.serverName.length > 0 ? facts.serverName : labelFromRowId(rowId)
  const stamp = new Date(typeof facts.now === 'number' ? facts.now : Date.now()).toISOString()

  const block = [
    MARKER_BEGIN_PREFIX + rowId,
    `# server: ${label}`,
    `# removed: ${stamp} by dsh-mcp-mini-manager`,
    '# restore this server from the MCP 极简管理 settings page, or delete',
    '# these lines to re-enable the row by hand.',
    `- id: ${rowId}`,
    '  disabled: true',
    MARKER_END_PREFIX + rowId,
  ]

  const existing = findPatchBlock(lines, rowId)
  if (existing !== null) {
    if (!existing.marked) {
      // A begin marker with no end marker means a hand-edited file; refuse
      // rather than splice an unbounded range out of the user's layer.
      return { ok: false, reason: 'marker-unpaired' }
    }
    const next = [...lines.slice(0, existing.start), ...block, ...lines.slice(existing.end + 1)]
    return { ok: true, text: next.join('\n'), action: 'rewrite', replaced: existing.end - existing.start + 1 }
  }

  // A bare hand-written `disabled: true` for this row is the one case to refuse:
  // the row is already out of service, so there is nothing to write, and adding
  // a second disabling patch would only duplicate the intent.
  //
  // Anything else with this id is fine and must stay disable-able.
  // `applyEntryPatches` applies every patch independently, key by key: a patch
  // that carries only `id` + `disabled` composes safely alongside one that
  // carries `name` + `config`, which is exactly how DSH itself layers patches.
  // Refusing here would make every MCP row declared *by a patch* — including the
  // common `insert` form — permanently unremovable.
  const parsed = parseYamlSubset(text)
  const already = parsed.value.find((entry) => entry?.id === rowId)
  if (already !== undefined && already.disabled === true) {
    return { ok: false, reason: 'already-patched' }
  }

  const endsWithNewline = text.endsWith('\n')
  const body = endsWithNewline ? lines.slice(0, -1) : [...lines]
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  const next = body.length === 0 ? [...block, ''] : [...body, '', ...block, '']
  return { ok: true, text: next.join('\n'), action: 'append', replaced: 0 }
}

/**
 * Plan the exact text change that restores one previously disabled MCP row.
 *
 * Only a block this plugin bracketed with its own markers is removed, so a row
 * the user disabled by hand is never touched. The blank line that `planDisable`
 * inserted as a separator is collapsed again, which makes
 * `planRestore(planDisable(text).text)` reproduce the original text exactly.
 *
 * @param source - current text of the user patch layer.
 * @param rowId - the MCP row to re-enable.
 * @returns whether a bracketed block this plugin owns was found and removed.
 */
export function planRestore(source, rowId) {
  if (!isRowId(rowId)) return { ok: false, reason: 'bad-row-id' }
  const lines = String(source).replaceAll('\r\n', '\n').split('\n')
  const existing = findPatchBlock(lines, rowId)
  if (existing === null) return { ok: false, reason: 'no-managed-block' }
  if (!existing.marked) return { ok: false, reason: 'marker-unpaired' }

  const kept = [...lines.slice(0, existing.start), ...lines.slice(existing.end + 1)]
  const collapsed = []
  for (const line of kept) {
    const previous = collapsed[collapsed.length - 1]
    if (line.trim() === '' && previous !== undefined && previous.trim() === '') continue
    collapsed.push(line)
  }
  while (collapsed.length > 0 && collapsed[0].trim() === '') collapsed.shift()
  return {
    ok: true,
    text: collapsed.join('\n'),
    removed: existing.end - existing.start + 1,
  }
}

/**
 * Whether a patch text holds the opening marker of one row's managed block but
 * not its closing marker.
 *
 * That state means a hand-edit or a crash interrupted a write, and it is the one
 * condition where this plugin must refuse rather than act: the block's extent is
 * unknown, so neither re-disabling (a splice) nor restoring (a delete) can be
 * bounded honestly.
 *
 * @param text - the patch layer text.
 * @param rowId - the row whose block to inspect.
 * @returns whether the markers are unpaired.
 */
export function hasUnpairedMarker(text, rowId) {
  if (typeof text !== 'string' || !isRowId(rowId)) return false
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const block = findPatchBlock(lines, rowId)
  return block !== null && !block.marked
}

/**
 * The row ids this plugin's own bracketed blocks disable in one patch text.
 *
 * A managed block carries only `id` and `disabled` — deliberately, so it cannot
 * restate or damage the row's real `config` — which makes it indistinguishable
 * from an unrelated patch by content alone. The markers are what identify it, and
 * a row disabled by this plugin must stay visible in the catalog even though no
 * live entry and no `name` field remains to describe it.
 *
 * @param text - the patch layer text.
 * @returns the set of row ids this plugin manages in that text.
 */
export function managedRowIdsIn(text) {
  const ids = new Set()
  if (typeof text !== 'string') return ids
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(MARKER_BEGIN_PREFIX)) continue
    const rowId = trimmed.slice(MARKER_BEGIN_PREFIX.length).trim()
    if (isRowId(rowId)) ids.add(rowId)
  }
  return ids
}

/**
 * The MCP rows a composed patch list declares, including disabled ones.
 *
 * A row that is present-but-disabled in a bundle layer (the base bundle's own
 * way of withholding a feature) is *available*, not installed: the page shows it
 * with `enabled: false` and no endpoint, which is the honest report.
 *
 * @param patches - the composed patch list, in application order.
 * @param managedRowIds - row ids this plugin disabled, which are accepted on
 *   their marker alone because their block carries no module name.
 * @returns one descriptor per MCP row, keyed by the row id that patches target.
 */
export function mcpRowsFromPatches(patches, managedRowIds = new Set()) {
  const rows = new Map()
  if (!Array.isArray(patches)) return rows

  const visit = (entries, origin) => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      if (Array.isArray(entry.config) && entry.group === true) {
        visit(entry.config, origin)
        continue
      }
      if (typeof entry.id !== 'string') continue
      const moduleName = typeof entry.name === 'string' ? entry.name : null
      if (!isMcpModule(moduleName) && !isMcpPluginName(entry.name)) continue
      const previous = rows.get(entry.id)
      rows.set(entry.id, {
        rowId: entry.id,
        origin: previous?.origin ?? origin,
        moduleName: moduleName ?? previous?.moduleName ?? null,
        config: typeof entry.config === 'object' && entry.config !== null ? entry.config : previous?.config ?? null,
        disabledInLayer: entry.disabled === true || previous?.disabledInLayer === true,
      })
    }
  }

  for (const patch of patches) {
    if (typeof patch !== 'object' || patch === null) continue
    const origin = Array.isArray(patch.insert) ? 'bundle' : 'user-patch'
    if (Array.isArray(patch.insert)) visit(patch.insert, origin)
    if (typeof patch.id === 'string' && !Array.isArray(patch.insert)) {
      const existing = rows.get(patch.id)
      if (existing !== undefined) {
        existing.disabledInLayer = existing.disabledInLayer || patch.disabled === true
        if (typeof patch.config === 'object' && patch.config !== null) existing.config = patch.config
        continue
      }
      const managed = managedRowIds.has(patch.id)
      const named = isMcpModule(patch.name) || isMcpPluginName(patch.name)
      const identifiableByConfig = typeof patch.config?.serverName === 'string'
      if (!named && !identifiableByConfig && !managed) continue
      rows.set(patch.id, {
        rowId: patch.id,
        origin: managed ? 'managed-disable' : 'user-patch',
        moduleName: typeof patch.name === 'string' ? patch.name : null,
        config: typeof patch.config === 'object' && patch.config !== null ? patch.config : null,
        disabledInLayer: patch.disabled === true,
      })
    }
  }
  return rows
}

/**
 * Merge the live Loader view over the patch-layer view.
 *
 * The live tree wins on anything it can see (it carries resolved config and a
 * real fiber phase); the patch layers contribute exactly what the live tree
 * structurally cannot — rows that are disabled, hence absent.
 *
 * @param live - descriptors from `ctx.loader.entries()`.
 * @param fromPatches - descriptors from {@link mcpRowsFromPatches}.
 * @returns the reconciled catalog rows, sorted by server label then row id.
 */
export function reconcileRows(live, fromPatches) {
  const merged = new Map()
  for (const [rowId, row] of fromPatches) merged.set(rowId, { ...row })
  for (const row of live) {
    const previous = merged.get(row.rowId)
    merged.set(row.rowId, {
      ...previous,
      ...row,
      origin: previous?.origin ?? row.origin ?? 'live',
      disabledInLayer: row.disabled === true || previous?.disabledInLayer === true,
    })
  }
  return [...merged.values()].sort((a, b) => {
    const left = a.serverName ?? labelFromRowId(a.rowId)
    const right = b.serverName ?? labelFromRowId(b.rowId)
    return left.localeCompare(right) || a.rowId.localeCompare(b.rowId)
  })
}

/* ------------------------------------------------------------------ */
/* Profile discovery                                                  */
/* ------------------------------------------------------------------ */

/** Read a JSON file, answering `undefined` for anything unreadable or malformed. */
export function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Read a text file, answering `undefined` when it does not exist or is unreadable. */
export function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Resolve the active profile directory.
 *
 * The Loader's `baseUrl` is the profile root — it is the base against which the
 * leaf `cordis.yml` and every user patch layer resolve — so that is the primary
 * signal. `$DSH_PROFILE` and a scan of `<home>/profiles/*` are fallbacks for a
 * host that composed the Loader from somewhere unexpected.
 *
 * @param options - `baseUrl` from the Loader, the harness home, and the env map.
 * @returns the profile directory plus how it was found, or `undefined`.
 */
export function resolveProfileDir({ baseUrl, home, env = process.env } = {}) {
  const candidates = []
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    const asPath = baseUrl.startsWith('file:') ? new URL(baseUrl).pathname : baseUrl
    candidates.push({ dir: resolve(asPath.replace(/^\/([A-Za-z]:)/, '$1')), via: 'loader-base-url' })
  }
  const named = trimOrUndefined(env.DSH_PROFILE)
  const base = home ?? resolveHarnessHome(env)
  if (named !== undefined) candidates.push({ dir: join(base, 'profiles', named), via: 'dsh-profile' })

  for (const candidate of candidates) {
    if (existsSync(join(candidate.dir, PROFILE_PATCH_FILENAME))) return candidate
  }
  if (candidates.length > 0 && existsSync(candidates[0].dir)) return candidates[0]

  const profilesRoot = join(base, 'profiles')
  try {
    const names = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const matching = names.filter((name) => existsSync(join(profilesRoot, name, PROFILE_PATCH_FILENAME)))
    if (matching.length === 1) return { dir: join(profilesRoot, matching[0]), via: 'profiles-scan' }
    const preferred = matching.find((name) => name === 'web') ?? matching[0]
    if (preferred !== undefined) return { dir: join(profilesRoot, preferred), via: 'profiles-scan' }
  } catch {
    /* a host without a profiles directory simply has no profile layer */
  }
  return undefined
}

/**
 * The bundle patch files of one profile, in `dsh.profile.bundles` order.
 *
 * Read-only. Bundle layers are package-owned, which is exactly why nothing here
 * is ever written: disabling a row means adding an override to the *user* layer,
 * never editing a package.
 *
 * @param profileDir - absolute profile directory.
 * @returns one `{ name, patchPath, exists }` per declared bundle.
 */
export function bundlePatchPaths(profileDir) {
  const manifest = readJsonFile(join(profileDir, PROFILE_MANIFEST_FILENAME))
  const declared = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(declared)) return []
  const results = []
  for (const name of declared) {
    if (typeof name !== 'string') continue
    const packageDir = join(profileDir, 'node_modules', ...name.split('/'))
    const packageJson = readJsonFile(join(packageDir, 'package.json'))
    const relative = packageJson?.dsh?.bundle?.patch
    const patchPath =
      typeof relative === 'string' ? join(packageDir, relative) : join(packageDir, PROFILE_PATCH_FILENAME)
    results.push({ name, patchPath, exists: existsSync(patchPath) })
  }
  return results
}

/**
 * Load a patch file as a list, reporting a malformed file instead of throwing.
 * @param path - absolute patch file path.
 * @returns the parsed list plus any subset-parser diagnostics.
 */
export function loadPatchFile(path) {
  const text = readTextFile(path)
  if (text === undefined) return { patches: [], unsupported: ['file-missing'], text: '' }
  try {
    const parsed = parseYamlSubset(text)
    return { patches: Array.isArray(parsed.value) ? parsed.value : [], unsupported: parsed.unsupported, text }
  } catch (error) {
    return { patches: [], unsupported: [messageOf(error)], text }
  }
}

/**
 * The id-targeted patches a layer applies, ignoring its `insert` lists.
 * @param patches - a parsed patch list.
 * @returns only the entries that override an existing row.
 */
export function overridesOf(patches) {
  return (Array.isArray(patches) ? patches : []).filter(
    (patch) => typeof patch?.id === 'string' && !Array.isArray(patch.insert),
  )
}

/**
 * Resolve a path to its absolute form for display in the page.
 * @param path - any path the host already resolved itself.
 * @returns the absolute path.
 */
export function displayPath(path) {
  return resolve(path)
}

/** Whether a path is absolute, for callers validating a host-supplied path. */
export function isAbsolutePath(path) {
  return typeof path === 'string' && path.length > 0 && isAbsolute(path)
}

/**
 * Whether a string is a well-formed MCP `serverName`.
 * @param value - candidate server name.
 * @returns whether `@deepseek-ai/dsh-mcp-client` would accept it.
 */
export function isServerName(value) {
  return typeof value === 'string' && SERVER_NAME_PATTERN.test(value)
}
