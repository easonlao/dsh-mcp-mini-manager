/**
 * ③.6 self-check: is this repository in the central registry snapshot yet?
 *
 * The snapshot is ~17 MB, so this does a substring scan rather than parsing it.
 * Mirrors are tried in order: jsDelivr (faster, but it 403s for this file at times)
 * then raw.githubusercontent.com, which drops the connection intermittently.
 *
 * Absence is NOT a failure and NOT grounds for an issue. The scan runs daily, and a
 * 0-star repository is also pushed past the "top 1000 by stars" cut. The script
 * therefore always exits 0 and prints the interpretation alongside the facts.
 */
const REPO = 'runcat-tommy/dsh-mcp-mini-manager'
const OWNER = REPO.split('/')[0]

const MIRRORS = [
  { name: 'jsDelivr', url: 'https://cdn.jsdelivr.net/gh/YELEBAI/dsh-plugin-marketplace@main/registry/plugins.json' },
  { name: 'raw.githubusercontent.com', url: 'https://raw.githubusercontent.com/YELEBAI/dsh-plugin-marketplace/main/registry/plugins.json' },
]

let text
let source
for (const mirror of MIRRORS) {
  try {
    const response = await fetch(mirror.url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    text = await response.text()
    source = mirror.name
    break
  } catch (error) {
    console.log(`mirror unavailable: ${mirror.name} -> ${error.message}`)
  }
}

// Node's fetch resets on this file fairly often. curl handles the same transfer
// reliably, so it is the last resort rather than the first: it is an external
// process, and this script is otherwise dependency-free.
if (text === undefined) {
  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { readFileSync } = await import('node:fs')
  const target = join(tmpdir(), 'dsh-marketplace-plugins.json')
  for (const mirror of MIRRORS) {
    try {
      execFileSync('curl.exe', ['-sSL', '--max-time', '180', '-o', target, mirror.url], { stdio: 'ignore' })
      const candidate = readFileSync(target, 'utf8')
      if (candidate.length > 1_000_000) {
        text = candidate
        source = `${mirror.name} (curl)`
        break
      }
    } catch (error) {
      console.log(`curl fallback failed: ${mirror.name} -> ${error.message.split('\n')[0]}`)
    }
  }
}

if (text === undefined) {
  console.log('\nno mirror answered; this says nothing about inclusion — retry later')
  process.exit(0)
}

console.log(`\nsnapshot: ${(text.length / 1024 / 1024).toFixed(1)} MB via ${source}`)

const listed = text.includes(REPO)
console.log(`\n${listed ? 'LISTED' : 'NOT LISTED'}  ${REPO}`)

const siblings = [...new Set([...text.matchAll(new RegExp(`${OWNER}/([a-z0-9-]+)`, 'g'))].map((m) => m[1]))].sort()
console.log(`\n${OWNER} plugins in the snapshot (${siblings.length}):`)
for (const name of siblings) console.log(`  ${name === 'dsh-mcp-mini-manager' ? '->' : '  '} ${name}`)

if (listed) {
  // Print the entry itself, so the version/commit/profile fields can be eyeballed.
  const at = text.indexOf(`"repo": "dsh-mcp-mini-manager"`)
  const from = at >= 0 ? text.lastIndexOf('{', at) : text.indexOf(REPO)
  const entry = text.slice(from, from + 1100)
  console.log('\n--- entry ---')
  console.log(entry.split('\n').slice(0, 34).join('\n'))

  const fields = ['verifiedCommit', 'verifiedAt', 'mode', 'requiresRestart', 'requiresBuildApproval']
  for (const field of fields) {
    const match = new RegExp(`"${field}"\\s*:\\s*("[^"]*"|[a-z]+)`).exec(entry)
    console.log(`${field.padEnd(22)} ${match ? match[1] : '(absent)'}`)
  }
} else {
  console.log('\ninterpretation: the daily scan has not reached this repository yet, or the')
  console.log('0-star entry was cut by the "top 1000 by stars" truncation. Both are normal on')
  console.log('the day of publication — wait for the next round; do not open an issue.')
}
