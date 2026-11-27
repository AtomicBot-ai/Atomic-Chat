import { readFileSync, writeFileSync, renameSync } from 'node:fs'

const manifest = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(manifest))
const version = process.argv[2]?.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version ?? ''))
  throw new Error('Usage: yarn bump:pi <version>')

async function get(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'atomic-chat-build' },
  })
  if (!response.ok) throw new Error(`GET ${url} failed (${response.status})`)
  return response
}

const base = `https://api.github.com/repos/${pkg.piAgent.repo}/releases/tags/v${version}`
const release = await (await get(base)).json()
const sums = release.assets.find((asset) => asset.name === 'SHA256SUMS')
if (!sums) throw new Error('The pi release is missing SHA256SUMS')
const hashes = new Map(
  (await (await get(sums.browser_download_url)).text())
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line)
      if (!match) throw new Error('Invalid SHA256SUMS entry')
      return [match[2], match[1]]
    })
)
for (const name of Object.keys(pkg.piAgent.assets)) {
  const asset = release.assets.find((item) => item.name === name)
  const sha256 = hashes.get(name)
  if (
    !asset ||
    !sha256 ||
    asset.digest !== `sha256:${sha256}` ||
    !(asset.size > 0)
  ) {
    throw new Error(`Missing or inconsistent release metadata for ${name}`)
  }
  pkg.piAgent.assets[name] = { size: asset.size, sha256 }
}
pkg.piAgent.version = version
const temporary = new URL(`../.package-pi-${process.pid}.tmp`, import.meta.url)
writeFileSync(temporary, JSON.stringify(pkg, null, 2) + '\n', { flag: 'wx' })
renameSync(temporary, manifest)
console.log(`Pinned pi ${version}`)
