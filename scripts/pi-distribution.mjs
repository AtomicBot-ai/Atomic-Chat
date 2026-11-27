import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const pin = JSON.parse(readFileSync(join(root, 'package.json'))).piAgent
const resources = join(root, 'src-tauri/resources')
const installed = join(resources, 'pi')

async function checksum(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function unpack(name, stage) {
  const metadata = pin.assets[name]
  if (!metadata) throw new Error(`No pi ${pin.version} pin for ${name}`)
  const cache = join(root, 'scripts/dist/pi', pin.version)
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, name)
  const matches = async (file) =>
    existsSync(file) &&
    statSync(file).size === metadata.size &&
    (await checksum(file)) === metadata.sha256
  if (!(await matches(archive))) {
    const response = await fetch(
      `https://github.com/${pin.repo}/releases/download/v${pin.version}/${name}`
    )
    if (!response.ok || !response.body)
      throw new Error(`Downloading ${name} failed (${response.status})`)
    const temporary = join(stage, name)
    await pipeline(response.body, createWriteStream(temporary))
    if (!(await matches(temporary)))
      throw new Error(`Invalid size or SHA-256 for ${name}`)
    renameSync(temporary, archive)
  }
  const directory = join(stage, `unpacked-${name}`)
  mkdirSync(directory)
  // Release ZIPs contain pi.exe at their root. The Unix tarballs contain pi/pi.
  execFileSync('tar', ['-xf', archive, '-C', directory])
  return name.endsWith('.zip') ? directory : join(directory, 'pi')
}

function commonAssets(directory, relative = '') {
  return readdirSync(join(directory, relative), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      if (!relative && (entry.name === 'pi' || entry.name === 'native'))
        return []
      const path = join(relative, entry.name)
      return entry.isDirectory() ? commonAssets(directory, path) : [path]
    })
}

async function makeUniversal(stage) {
  const arm = await unpack('pi-darwin-arm64.tar.gz', stage)
  const intel = await unpack('pi-darwin-x64.tar.gz', stage)
  const assets = commonAssets(arm)
  if (JSON.stringify(assets) !== JSON.stringify(commonAssets(intel))) {
    throw new Error('macOS pi archives have different common assets')
  }
  for (const name of assets) {
    if (
      !readFileSync(join(arm, name)).equals(readFileSync(join(intel, name)))
    ) {
      throw new Error(`macOS pi asset differs by architecture: ${name}`)
    }
  }
  cpSync(join(intel, 'native'), join(arm, 'native'), { recursive: true })
  const executable = join(stage, 'universal-pi')
  execFileSync('lipo', [
    '-create',
    join(arm, 'pi'),
    join(intel, 'pi'),
    '-output',
    executable,
  ])
  execFileSync('codesign', [
    '--force',
    '--sign',
    '-',
    '--entitlements',
    join(root, 'src-tauri/Entitlements.sidecar.plist'),
    executable,
  ])
  renameSync(executable, join(arm, 'pi'))
  return arm
}

export function verifyPi(directory = installed) {
  const executable = join(
    directory,
    process.platform === 'win32' ? 'pi.exe' : 'pi'
  )
  const profile = mkdtempSync(join(tmpdir(), 'atomic-pi-version-'))
  try {
    const version = execFileSync(executable, ['--version'], {
      cwd: profile,
      timeout: 15000,
      encoding: 'utf8',
      env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1' },
    }).trim()
    if (version !== pin.version)
      throw new Error(`Expected pi ${pin.version}, got ${version}`)
    console.log(`Verified pi ${version}`)
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}

export async function installPi() {
  mkdirSync(resources, { recursive: true })
  const stage = mkdtempSync(join(resources, '.pi-install-'))
  const previous = join(stage, 'previous')
  try {
    const platform = process.platform === 'win32' ? 'windows' : process.platform
    const name = `pi-${platform}-${process.arch}.${platform === 'windows' ? 'zip' : 'tar.gz'}`
    const prepared =
      platform === 'darwin'
        ? await makeUniversal(stage)
        : await unpack(name, stage)
    verifyPi(prepared)
    if (existsSync(installed)) renameSync(installed, previous)
    try {
      renameSync(prepared, installed)
    } catch (error) {
      if (existsSync(previous) && !existsSync(installed))
        renameSync(previous, installed)
      throw error
    }
  } finally {
    // If publication and recovery both failed, retain the previous installation.
    if (existsSync(installed) || !existsSync(previous))
      rmSync(stage, { recursive: true, force: true })
  }
}
