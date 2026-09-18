// scripts/download.js
import https from 'https'
import fs, { copyFile, mkdirSync } from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import unzipper from 'unzipper'
import tar from 'tar'
import { copySync } from 'cpx'

// ----- cloudflared (Remote access sidecar) -----
// The one bundled binary that opens public ingress to the user's machine, so
// unlike bun/uv below it is pinned to a release and verified before it is
// allowed anywhere near the bundle. A mismatch fails the build.
//
// Two independent sources, because they do not describe the same bytes:
//   `sha256` / `size`  — the *release asset* as GitHub reports it
//       (`gh api repos/cloudflare/cloudflared/releases/tags/<version>` → `digest`).
//   `binarySha256`     — the executable *inside* a macOS `.tgz`, which is the
//       value Cloudflare prints in the release notes. For those two assets the
//       notes' checksum is NOT the archive's hash, so it cannot go in `sha256`.
// Linux and Windows assets are the executable itself: one hash covers both.
//
// To update: change `version`, then every hash and size, in this one place.
const CLOUDFLARED = {
  version: '2026.9.1',
  assets: {
    'darwin-arm64': {
      file: 'cloudflared-darwin-arm64.tgz',
      size: 19217478,
      sha256: 'c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe',
      binarySha256: '9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e',
    },
    'darwin-amd64': {
      file: 'cloudflared-darwin-amd64.tgz',
      size: 21118723,
      sha256: 'ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4',
      binarySha256: '1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75',
    },
    'linux-amd64': {
      file: 'cloudflared-linux-amd64',
      size: 39838488,
      sha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc',
    },
    // Not bundled (Linux ships x86_64 only); lets an arm64 Linux dev box build.
    'linux-arm64': {
      file: 'cloudflared-linux-arm64',
      size: 37466252,
      sha256: '3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3',
    },
    'windows-amd64': {
      file: 'cloudflared-windows-amd64.exe',
      size: 54976432,
      sha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
    },
  },
}

function sha256Of(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

// Unlike `download()` below, this resolves redirects *before* it opens the
// output file, so no handle is left open on it. The caller renames the file
// afterwards, which Windows refuses while any handle exists.
function downloadFollowingRedirects(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'atomic-chat-build' } }, (response) => {
        const { statusCode, headers } = response
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume()
          if (redirectsLeft === 0) {
            reject(new Error(`Too many redirects for ${url}`))
            return
          }
          const next = new URL(headers.location, url).toString()
          downloadFollowingRedirects(next, dest, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (statusCode !== 200) {
          response.resume()
          reject(new Error(`GET ${url} failed with status ${statusCode}`))
          return
        }
        const file = fs.createWriteStream(dest)
        response.on('error', reject)
        file.on('error', reject)
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())))
        response.pipe(file)
      })
      .on('error', reject)
  })
}

// Returns the path of a verified copy of the asset in `tempBinDir`.
async function fetchCloudflaredAsset(key, tempBinDir) {
  const asset = CLOUDFLARED.assets[key]
  if (!asset) throw new Error(`No pinned cloudflared asset for ${key}`)
  const cached = path.join(tempBinDir, `cloudflared-${CLOUDFLARED.version}-${asset.file}`)
  // Hashed on every run, not just trusted because it exists: a truncated or
  // tampered cache must never be bundled.
  if (fs.existsSync(cached) && sha256Of(cached) === asset.sha256) {
    console.log(`cloudflared ${CLOUDFLARED.version} (${key}) already downloaded and verified`)
    return cached
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED.version}/${asset.file}`
  const partial = `${cached}.part`
  fs.rmSync(partial, { force: true })
  console.log(`Downloading ${url}`)
  try {
    await downloadFollowingRedirects(url, partial)
    const size = fs.statSync(partial).size
    const actual = sha256Of(partial)
    if (size !== asset.size || actual !== asset.sha256) {
      throw new Error(
        `cloudflared ${asset.file} failed verification: ` +
          `expected ${asset.size} bytes sha256 ${asset.sha256}, got ${size} bytes sha256 ${actual}`
      )
    }
  } catch (err) {
    fs.rmSync(partial, { force: true })
    throw err
  }
  fs.renameSync(partial, cached)
  return cached
}

function installBinary(source, target) {
  fs.copyFileSync(source, target)
  if (os.platform() !== 'win32') fs.chmodSync(target, 0o755)
  console.log(`cloudflared installed at ${target}`)
}

// File names Tauri expects for this machine: an `externalBin` entry resolves
// as `<name>-<target triple>[.exe]`.
function cloudflaredTargets() {
  const platform = os.platform()
  const isArm = os.arch() === 'arm64'
  if (platform === 'darwin') {
    return [
      'cloudflared-aarch64-apple-darwin',
      'cloudflared-x86_64-apple-darwin',
      'cloudflared-universal-apple-darwin',
    ]
  }
  if (platform === 'linux') {
    return [`cloudflared-${isArm ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`]
  }
  if (platform === 'win32') return ['cloudflared-x86_64-pc-windows-msvc.exe']
  throw new Error(`Unsupported platform for cloudflared: ${platform}`)
}

// Written after an install that came from a verified archive. It records what
// was installed, so a later run can tell "already there" from a missing file,
// a truncated one, a `make stub-resources` placeholder, or an older pin —
// without touching the network. Lives in the gitignored bin dir and is not
// listed in any bundle's resources.
const CLOUDFLARED_STAMP = '.cloudflared-installed.json'

function isCloudflaredInstalled(binDir) {
  let stamp
  try {
    stamp = JSON.parse(fs.readFileSync(path.join(binDir, CLOUDFLARED_STAMP), 'utf8'))
  } catch {
    return false
  }
  if (!stamp || stamp.version !== CLOUDFLARED.version || !stamp.files) return false
  return cloudflaredTargets().every((name) => {
    const file = path.join(binDir, name)
    return (
      typeof stamp.files[name] === 'string' &&
      fs.existsSync(file) &&
      sha256Of(file) === stamp.files[name]
    )
  })
}

function writeCloudflaredStamp(binDir) {
  const files = {}
  for (const name of cloudflaredTargets()) {
    files[name] = sha256Of(path.join(binDir, name))
  }
  fs.writeFileSync(
    path.join(binDir, CLOUDFLARED_STAMP),
    JSON.stringify({ version: CLOUDFLARED.version, files }, null, 2) + '\n'
  )
}

// Installs the pinned cloudflared for this machine, downloading only when it
// has to: verified files already in place → nothing to do; verified archive in
// the `scripts/dist` cache → reinstall offline; otherwise fetch and verify.
async function installCloudflared(binDir, tempBinDir) {
  const platform = os.platform()
  const arch = os.arch()
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(tempBinDir, { recursive: true })

  if (isCloudflaredInstalled(binDir)) {
    console.log(`cloudflared ${CLOUDFLARED.version} already installed and verified, skipping download`)
    return
  }

  if (platform === 'darwin') {
    // The release build targets `universal-apple-darwin`, which needs a fat
    // binary; both slices are fetched and merged for real (bun/uv above ship
    // one architecture under the universal name).
    const slices = []
    for (const [key, triple] of [
      ['darwin-arm64', 'aarch64-apple-darwin'],
      ['darwin-amd64', 'x86_64-apple-darwin'],
    ]) {
      const archive = await fetchCloudflaredAsset(key, tempBinDir)
      const extractDir = path.join(tempBinDir, `cloudflared-${CLOUDFLARED.version}-${key}`)
      fs.rmSync(extractDir, { recursive: true, force: true })
      fs.mkdirSync(extractDir, { recursive: true })
      // `.tgz` is a gzipped tar; node-tar detects that from the content and
      // refuses absolute and `..` paths by default.
      await tar.x({ file: archive, cwd: extractDir })
      const binary = path.join(extractDir, 'cloudflared')
      if (!fs.existsSync(binary)) {
        throw new Error(`No cloudflared binary inside ${archive}`)
      }
      // Second, independent check: the executable itself against the checksum
      // Cloudflare publishes (the archive was checked against GitHub's digest).
      const expectedBinary = CLOUDFLARED.assets[key].binarySha256
      const actualBinary = sha256Of(binary)
      if (actualBinary !== expectedBinary) {
        throw new Error(
          `cloudflared inside ${archive} failed verification: ` +
            `expected sha256 ${expectedBinary}, got ${actualBinary}`
        )
      }
      const target = path.join(binDir, `cloudflared-${triple}`)
      installBinary(binary, target)
      slices.push(target)
    }
    const universal = path.join(binDir, 'cloudflared-universal-apple-darwin')
    fs.rmSync(universal, { force: true })
    execFileSync('lipo', ['-create', '-output', universal, ...slices], { stdio: 'inherit' })
    fs.chmodSync(universal, 0o755)
    console.log(`cloudflared installed at ${universal}`)
  } else if (platform === 'linux') {
    const isArm = arch === 'arm64'
    const binary = await fetchCloudflaredAsset(isArm ? 'linux-arm64' : 'linux-amd64', tempBinDir)
    const triple = isArm ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
    installBinary(binary, path.join(binDir, `cloudflared-${triple}`))
  } else if (platform === 'win32') {
    const binary = await fetchCloudflaredAsset('windows-amd64', tempBinDir)
    installBinary(binary, path.join(binDir, 'cloudflared-x86_64-pc-windows-msvc.exe'))
  } else {
    throw new Error(`Unsupported platform for cloudflared: ${platform}`)
  }
  writeCloudflaredStamp(binDir)
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${url} to ${dest}`)
    const file = fs.createWriteStream(dest)
    https
      .get(url, (response) => {
        console.log(`Response status code: ${response.statusCode}`)
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          // Handle redirect
          const redirectURL = response.headers.location
          console.log(`Redirecting to ${redirectURL}`)
          download(redirectURL, dest).then(resolve, reject) // Recursive call
          return
        } else if (response.statusCode !== 200) {
          reject(`Failed to get '${url}' (${response.statusCode})`)
          return
        }
        response.pipe(file)
        file.on('finish', () => {
          file.close(resolve)
        })
      })
      .on('error', (err) => {
        fs.unlink(dest, () => reject(err.message))
      })
  })
}

async function decompress(filePath, targetDir) {
  console.log(`Decompressing ${filePath} to ${targetDir}`)
  if (filePath.endsWith('.zip')) {
    await fs
      .createReadStream(filePath)
      .pipe(unzipper.Extract({ path: targetDir }))
      .promise()
  } else if (filePath.endsWith('.tar.gz')) {
    await tar.x({
      file: filePath,
      cwd: targetDir,
    })
  } else {
    throw new Error(`Unsupported archive format: ${filePath}`)
  }
}

async function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url)
    opts.headers = {
      'User-Agent': 'jan-app',
      'Accept': 'application/vnd.github+json',
      ...headers,
    }
    https
      .get(opts, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return getJson(res.headers.location, headers).then(resolve, reject)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} failed with status ${res.statusCode}`))
          return
        }
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

function matchSqliteVecAsset(assets, platform, arch) {
  const osHints =
    platform === 'darwin'
      ? ['darwin', 'macos', 'apple-darwin']
      : platform === 'win32'
        ? ['windows', 'win', 'msvc']
        : ['linux']

  const archHints = arch === 'arm64' ? ['arm64', 'aarch64'] : ['x86_64', 'x64', 'amd64']
  const extHints = ['zip', 'tar.gz']

  const lc = (s) => s.toLowerCase()
  const candidates = assets
    .filter((a) => a && a.browser_download_url && a.name)
    .map((a) => ({ name: lc(a.name), url: a.browser_download_url }))

  // Prefer exact OS + arch matches
  let matches = candidates.filter((c) => osHints.some((o) => c.name.includes(o)) && archHints.some((h) => c.name.includes(h)) && extHints.some((e) => c.name.endsWith(e)))
  if (matches.length) return matches[0].url
  // Fallback: OS only
  matches = candidates.filter((c) => osHints.some((o) => c.name.includes(o)) && extHints.some((e) => c.name.endsWith(e)))
  if (matches.length) return matches[0].url
  // Last resort: any asset with shared library extension inside is unknown here, so pick any zip/tar.gz
  matches = candidates.filter((c) => extHints.some((e) => c.name.endsWith(e)))
  return matches.length ? matches[0].url : null
}

async function fetchLatestSqliteVecUrl(platform, arch) {
  try {
    const rel = await getJson('https://api.github.com/repos/asg017/sqlite-vec/releases/latest')
    const url = matchSqliteVecAsset(rel.assets || [], platform, arch)
    return url
  } catch (e) {
    console.log('Failed to query sqlite-vec latest release:', e.message)
    return null
  }
}

function getPlatformArch() {
  const platform = os.platform() // 'darwin', 'linux', 'win32'
  const arch = os.arch() // 'x64', 'arm64', etc.

  let bunPlatform, uvPlatform

  if (platform === 'darwin') {
    bunPlatform = arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x64'
    uvPlatform =
      arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  } else if (platform === 'linux') {
    bunPlatform = arch === 'arm64' ? 'linux-aarch64' : 'linux-x64'
    uvPlatform =
      arch === 'arm64'
        ? 'aarch64-unknown-linux-gnu'
        : 'x86_64-unknown-linux-gnu'
  } else if (platform === 'win32') {
    bunPlatform = 'windows-x64' // Bun has limited Windows support
    uvPlatform = 'x86_64-pc-windows-msvc'
  } else {
    throw new Error(`Unsupported platform: ${platform}`)
  }

  return { bunPlatform, uvPlatform }
}

async function main() {
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping binaries download.')
    process.exit(0)
  }
  // `--only=cloudflared` (yarn download:cloudflared, make download-cloudflared):
  // just the Remote access sidecar, leaving bun/uv/sqlite-vec alone.
  const only = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--only='))
    ?.slice('--only='.length)
  if (only !== undefined) {
    if (only !== 'cloudflared') {
      throw new Error(`Unknown --only target '${only}' (supported: cloudflared)`)
    }
    await installCloudflared('src-tauri/resources/bin', 'scripts/dist')
    return
  }
  console.log('Starting main function')
  const platform = os.platform()
  const { bunPlatform, uvPlatform } = getPlatformArch()
  console.log(`bunPlatform: ${bunPlatform}, uvPlatform: ${uvPlatform}`)

  const binDir = 'src-tauri/resources/bin'
  const tempBinDir = 'scripts/dist'
  const bunPath = `${tempBinDir}/bun-${bunPlatform}.zip`
  let uvPath = `${tempBinDir}/uv-${uvPlatform}.tar.gz`
  if (platform === 'win32') {
    uvPath = `${tempBinDir}/uv-${uvPlatform}.zip`
  }
  try {
    mkdirSync('scripts/dist')
  } catch (err) {
    // Expect EEXIST error if the directory already exists
  }

  // Adjust these URLs based on latest releases
  const bunUrl = `https://github.com/oven-sh/bun/releases/latest/download/bun-${bunPlatform}.zip`

  let uvUrl = `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvPlatform}.tar.gz`
  if (platform === 'win32') {
    uvUrl = `https://github.com/astral-sh/uv/releases/latest/download/uv-${uvPlatform}.zip`
  }

  console.log(`Downloading Bun for ${bunPlatform}...`)
  const bunSaveDir = path.join(tempBinDir, `bun-${bunPlatform}.zip`)
  if (!fs.existsSync(bunSaveDir)) {
    await download(bunUrl, bunSaveDir)
    await decompress(bunPath, tempBinDir)
  }
  try {
    copySync(
      path.join(tempBinDir, `bun-${bunPlatform}`, 'bun'),
      path.join(binDir)
    )
    if (platform !== 'win32') {
      fs.chmod(path.join(binDir, 'bun'), 0o755, (err) => {
        if (err) {
          console.log('Add execution permission failed!', err)
        }
      })
    }
    if (platform === 'darwin') {
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-x86_64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-aarch64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-universal-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    } else if (platform === 'linux') {
      copyFile(
        path.join(binDir, 'bun'),
        path.join(binDir, 'bun-x86_64-unknown-linux-gnu'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  try {
    copySync(
      path.join(tempBinDir, `bun-${bunPlatform}`, 'bun.exe'),
      path.join(binDir)
    )
    if (platform === 'win32') {
      copyFile(
        path.join(binDir, 'bun.exe'),
        path.join(binDir, 'bun-x86_64-pc-windows-msvc.exe'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  console.log('Bun downloaded.')

  console.log(`Downloading UV for ${uvPlatform}...`)
  const uvExt = platform === 'win32' ? `zip` : `tar.gz`
  const uvSaveDir = path.join(tempBinDir, `uv-${uvPlatform}.${uvExt}`)
  if (!fs.existsSync(uvSaveDir)) {
    await download(uvUrl, uvSaveDir)
    await decompress(uvPath, tempBinDir)
  }
  try {
    copySync(path.join(tempBinDir, `uv-${uvPlatform}`, 'uv'), path.join(binDir))
    if (platform !== 'win32') {
      fs.chmod(path.join(binDir, 'uv'), 0o755, (err) => {
        if (err) {
          console.log('Add execution permission failed!', err)
        }
      })
    }
    if (platform === 'darwin') {
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-x86_64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-aarch64-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-universal-apple-darwin'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    } else if (platform === 'linux') {
      copyFile(
        path.join(binDir, 'uv'),
        path.join(binDir, 'uv-x86_64-unknown-linux-gnu'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  try {
    copySync(path.join(tempBinDir, 'uv.exe'), path.join(binDir))
    if (platform === 'win32') {
      copyFile(
        path.join(binDir, 'uv.exe'),
        path.join(binDir, 'uv-x86_64-pc-windows-msvc.exe'),
        (err) => {
          if (err) {
            console.log('Error Found:', err)
          }
        }
      )
    }
  } catch (err) {
    // Expect EEXIST error
  }
  console.log('UV downloaded.')

  // Fatal on purpose (see `CLOUDFLARED` above): the bundle lists it as an
  // `externalBin`, and an unverified tunnel binary must not ship.
  await installCloudflared(binDir, tempBinDir)

  // ----- sqlite-vec (optional, ANN acceleration) -----
  try {
    const binDir = 'src-tauri/resources/bin'
    const platform = os.platform()
    const ext = platform === 'darwin' ? 'dylib' : platform === 'win32' ? 'dll' : 'so'
    const targetLibPath = path.join(binDir, `sqlite-vec.${ext}`)

    if (fs.existsSync(targetLibPath)) {
      console.log(`sqlite-vec already present at ${targetLibPath}`)
    } else {
      let sqlvecUrl = await fetchLatestSqliteVecUrl(platform, os.arch())
      // Allow override via env if needed
      if ((process.env.SQLVEC_URL || process.env.JAN_SQLITE_VEC_URL) && !sqlvecUrl) {
        sqlvecUrl = process.env.SQLVEC_URL || process.env.JAN_SQLITE_VEC_URL
      }
      if (!sqlvecUrl) {
        console.log('Could not determine sqlite-vec download URL; skipping (linear fallback will be used).')
      } else {
        console.log(`Downloading sqlite-vec from ${sqlvecUrl}...`)
        const sqlvecArchive = path.join(tempBinDir, `sqlite-vec-download`)
        const guessedExt = sqlvecUrl.endsWith('.zip') ? '.zip' : sqlvecUrl.endsWith('.tar.gz') ? '.tar.gz' : ''
        const archivePath = sqlvecArchive + guessedExt
        await download(sqlvecUrl, archivePath)
        if (!guessedExt) {
          console.log('Unknown archive type for sqlite-vec; expecting .zip or .tar.gz')
        } else {
          await decompress(archivePath, tempBinDir)
          // Try to find a shared library in the extracted files
          const candidates = []
          function walk(dir) {
            for (const entry of fs.readdirSync(dir)) {
              const full = path.join(dir, entry)
              const stat = fs.statSync(full)
              if (stat.isDirectory()) walk(full)
              else if (full.endsWith(`.${ext}`)) candidates.push(full)
            }
          }
          walk(tempBinDir)
          if (candidates.length === 0) {
            console.log('No sqlite-vec shared library found in archive; skipping copy.')
          } else {
            // Pick the first match and copy/rename to sqlite-vec.<ext>
            const libSrc = candidates[0]
            // Ensure we copy the FILE, not a directory (fs-extra copySync can copy dirs)
            if (fs.statSync(libSrc).isFile()) {
              fs.copyFileSync(libSrc, targetLibPath)
              console.log(`sqlite-vec installed at ${targetLibPath}`)
            } else {
              console.log(`Found non-file at ${libSrc}; skipping.`)
            }
          }
        }
      }
    }
  } catch (err) {
    console.log('sqlite-vec download step failed (non-fatal):', err)
  }

  console.log('Downloads completed.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
