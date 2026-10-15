/**
 * Marketplace gate check (skill step ①.2).
 *
 * The gates below are the ones that fail *silently*: the code and its tests stay
 * green while the marketplace quietly stops listing the plugin, or downgrades it to
 * "guided install". Every check states what it is protecting, so a failure names the
 * consequence rather than just the assertion.
 *
 * Offline by design, so it runs in `npm test` on every change. The two facts that
 * need the network — the `dsh-plugin` topic and npm/repo version agreement — are
 * covered by the release script instead.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const pending = []
const check = (name, ok, protects) => {
  pending.push({ name, fails: ok ? null : protects })
}

const manifestPath = join(ROOT, 'package.json')
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('package.json parses as JSON', true, 'an unparseable manifest fails every other gate')
} catch (error) {
  check('package.json parses as JSON', false, error.message)
}

if (manifest) {
  check(
    'npm package name is lowercase and URL-safe',
    /^[a-z0-9][a-z0-9._-]*$/.test(manifest.name ?? ''),
    'the marketplace keys plugins by npm name',
  )
  check(
    'version is valid semver',
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? ''),
    'a malformed version breaks the registry scan',
  )
  check(
    'no lifecycle scripts (preinstall/install/postinstall/prepare)',
    !['preinstall', 'install', 'postinstall', 'prepare'].some((key) => key in (manifest.scripts ?? {})),
    'an install-time script forces a build approval prompt on GitHub installs',
  )

  const patchRel = manifest.dsh?.bundle?.patch
  check(
    'dsh.bundle.patch is a safe in-repo relative path',
    typeof patchRel === 'string' && patchRel.startsWith('./') && !patchRel.includes('..'),
    'an absolute path or one escaping the repo is rejected outright',
  )

  const patchPath = typeof patchRel === 'string' ? join(ROOT, patchRel) : undefined
  const patchExists = patchPath !== undefined && existsSync(patchPath)
  check('the patch file exists', patchExists, 'the marketplace reads it straight from the repository')

  if (patchExists) {
    const patch = readFileSync(patchPath, 'utf8')
    // Gate: the bundle patch must be a YAML operation list inserting at least one
    // loader entry whose `name` equals the npm package name, or the marketplace
    // cannot recognise which package the plugin actually is.
    const insertedNames = [...patch.matchAll(/^\s+name:\s*'?([^'\r\n]+?)'?\s*$/gm)].map((m) => m[1])
    check(
      'bundle patch inserts an entry named exactly the npm package name',
      insertedNames.includes(manifest.name),
      `names found: ${JSON.stringify(insertedNames)} — a repo name or short name is not recognised`,
    )
    check(
      'bundle patch is an operation list at the top level',
      /^\s*-\s+(insert|id):/m.test(patch),
      'a patch that is not an operation list cannot be applied',
    )
  }

  const client = manifest.dsh?.client
  if (client !== undefined) {
    check('dsh.client.platform is "web"', client.platform === 'web', 'any other value is refused')
    check(
      'package.json exports ./client',
      typeof manifest.exports?.['./client'] !== 'undefined',
      'the client bundle must be reachable through the declared export',
    )
    const clientPath = join(ROOT, 'lib', 'client.js')
    check('lib/client.js exists', existsSync(clientPath), 'a declared client with no artifact cannot be served')
    if (existsSync(clientPath)) {
      // Gate: the client artifact must actually be in the Git tree. A `.gitignore`
      // rule that swallows `lib/` is the classic way this breaks — the file is on
      // the developer's disk, so every local test passes, while the marketplace
      // sees no artifact and downgrades the listing to the npm/tarball source.
      const ignored = readFileSync(join(ROOT, '.gitignore'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .some((line) => ['lib', 'lib/', '/lib', '/lib/'].includes(line))
      check(
        'the client artifact is not excluded by .gitignore',
        !ignored,
        'an artifact missing from the Git tree downgrades the listing to the npm/tarball source',
      )
    }
  }

  const mk = manifest.dsh?.marketplace
  if (mk !== undefined) {
    check(
      'dsh.marketplace declares profiles',
      Array.isArray(mk.profiles) && mk.profiles.length > 0,
      'the marketplace needs to know which profiles this plugin supports',
    )
    check(
      'requiresBuildApproval matches the "published artifact" reading',
      typeof mk.requiresBuildApproval === 'boolean' && mk.requiresBuildApproval === false,
      'the tarball ships full artifacts and runs no install script, so false is the honest value',
    )
    check(
      'requiresRestart is true for a plugin that contributes a bundle',
      mk.requiresRestart === true,
      'a new bundle is read from the profile manifest at startup, so installing needs a restart',
    )
    check(
      'manualSteps is a boolean',
      typeof mk.manualSteps === 'boolean',
      'the marketplace renders this as a badge',
    )
    check(
      'the declared manifests are not the legacy {"source","repo"} shape',
      mk.source === undefined && mk.repo === undefined,
      'the legacy shape is a historical leftover, not a current declaration',
    )
  }

  // README gates: the identity in the README has to match the repository, and the
  // GitHub install command has to be spelled out, or the auto-install classifier has
  // no evidence that this repo can be installed from GitHub.
  for (const file of ['README.md', 'README.en.md']) {
    const path = join(ROOT, file)
    if (!existsSync(path)) {
      check(`${file} exists`, false, 'both language front pages are required')
      continue
    }
    const text = readFileSync(path, 'utf8')
    const ownerRepo = (manifest.repository?.url ?? '').match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1]
    check(
      `${file} gives the GitHub install command`,
      ownerRepo !== undefined && text.includes(`add github:${ownerRepo}`),
      `expected "dsh plugin --profile <profile> add github:${ownerRepo}"`,
    )
    check(
      `${file} names the repository owner/repo`,
      ownerRepo !== undefined && text.includes(ownerRepo),
      `README identity must match the candidate repository (${ownerRepo})`,
    )
    check(
      `${file} is free of replacement characters`,
      !text.includes('\uFFFD'),
      'indicates an encoding accident that would show as mojibake on the page',
    )
  }
}

// ①.1 screenshots.json
const shotsPath = join(ROOT, 'screenshots.json')
if (existsSync(shotsPath)) {
  let shots
  try {
    shots = JSON.parse(readFileSync(shotsPath, 'utf8'))
    check('screenshots.json parses', true, 'the marketplace fetches previews from it')
  } catch (error) {
    check('screenshots.json parses', false, error.message)
  }
  if (Array.isArray(shots)) {
    check('declares 1-8 screenshots', shots.length >= 1 && shots.length <= 8, `declared: ${shots.length}`)
    check(
      'all entries are https URLs or repo-relative paths',
      shots.every((s) => s.startsWith('https://') || !s.includes('://')),
      'a non-https remote URL is not fetched',
    )
    check(
      'no .svg entries (the marketplace discards SVG)',
      !shots.some((s) => s.toLowerCase().endsWith('.svg')),
      'SVG is filtered out as logo/badge noise',
    )
    const missing = shots.filter((s) => !s.startsWith('https://') && !existsSync(join(ROOT, s)))
    check('every relative screenshot exists in the repo', missing.length === 0, `missing: ${JSON.stringify(missing)}`)
    // Only stat the files that are actually there. Reading every declared path
    // unconditionally threw ENOENT and killed the whole run before the
    // "missing" gate above could report — a crash is not a diagnostic.
    const sizes = shots
      .filter((s) => !s.startsWith('https://') && existsSync(join(ROOT, s)))
      .map((s) => [s, readFileSync(join(ROOT, s)).length])
    check(
      'screenshots are non-trivial in size',
      sizes.every(([, n]) => n > 4096),
      `sizes: ${JSON.stringify(sizes)}`,
    )
  }
} else {
  check('screenshots.json exists', false, 'without it the marketplace falls back to heuristic README scraping, which usually yields no preview at all')
}

// Network-dependent gates. Off by default so `npm test` stays hermetic and fast;
// set MMM_ONLINE=1 to include them (the release checklist does).
if (process.env.MMM_ONLINE === '1') {
  const repo = (manifest.repository?.url ?? '').match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1]
  const headers = { 'user-agent': 'dsh-release-gate', accept: 'application/vnd.github+json' }
  const token = process.env.GITHUB_TOKEN
  if (token) headers.authorization = `Bearer ${token}`
  try {
    const repoJson = await (await fetch(`https://api.github.com/repos/${repo}`, { headers })).json()
    check(
      'repository carries the dsh-plugin topic',
      Array.isArray(repoJson.topics) && repoJson.topics.includes('dsh-plugin'),
      'the registry scan keys on this topic',
    )
    check('repository is public', repoJson.private === false, 'private repositories are not scanned')
    check('default branch is main', repoJson.default_branch === 'main', `is: ${repoJson.default_branch}`)
  } catch (error) {
    check('GitHub repository reachable', false, error.message)
  }
  try {
    const registry = await (await fetch('https://registry.npmjs.org/' + manifest.name)).json()
    const latest = registry['dist-tags'].latest
    const meta = registry.versions[latest]
    check(
      'published npm version matches the repository version',
      latest === manifest.version,
      `npm latest=${latest} repo=${manifest.version}`,
    )
    check(
      'published tarball ships the runtime artifacts',
      meta.dist.fileCount >= 5,
      `fileCount=${meta.dist.fileCount}`,
    )
    const bundlePatch = meta.dsh?.bundle?.patch
    check('published manifest keeps a relative dsh.bundle.patch', typeof bundlePatch === 'string' && bundlePatch.startsWith('./'), `is: ${bundlePatch}`)
  } catch (error) {
    check('npm registry reachable', false, error.message)
  }
}

// Each gate becomes its own subtest, so a failure names the gate and the consequence
// instead of collapsing every gate into one opaque assertion.
test('marketplace gates', async (t) => {
  for (const { name, fails } of pending) {
    await t.test(name, () => {
      assert.equal(fails, null, fails ?? '')
    })
  }
})
