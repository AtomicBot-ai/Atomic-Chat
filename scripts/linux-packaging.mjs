// The Linux packages (deb, rpm, the AUR PKGBUILD) and their apt/dnf repository, the pure part: names,
// versions, the install layout, the dependencies read from the payload's ELF files, the nfpm config, the
// PKGBUILD, which releases the repository carries, its layout and its upload order.
// `linux-packages.mjs` and `linux-repo.mjs` do the file system and the tools. Ported from
// AtomicBot-ai/eye-cli (scripts/linux-packaging.mjs), which packages the `atc` CLI the same way.

export const PACKAGE_NAME = 'atomic-chat'
export const AUR_PACKAGE = 'atomic-chat-bin'
/** The PKGBUILD's `install=` script, pushed to the AUR beside it. */
export const AUR_INSTALL_FILE = `${AUR_PACKAGE}.install`

/**
 * Everything the app needs lives under one directory, in the layout Tauri resolves at run time:
 * sidecars (uv, cloudflared) and bun next to the executable, resources in `../lib/<productName>`
 * (tauri-utils `resource_dir`). /usr/bin gets a symlink only, so nothing collides with the distro's own
 * uv or cloudflared.
 */
export const INSTALL_DIR = '/opt/atomic-chat'
export const PRODUCT_NAME = 'Atomic Chat'
export const MAIN_BINARY = 'Atomic-Chat'
export const COMMAND = '/usr/bin/atomic-chat'
/** The bundle identifier: the Wayland app_id, so the desktop entry is found by it. */
export const APP_ID = 'chat.atomic.app'
/** Next to the executable it turns the built-in updater off (src-tauri/src/core/updater/package_managed.rs). */
export const PACKAGE_MANAGED_MARKER = 'atomic-chat-package-managed'
/** tauri.linux.conf.json `externalBin`, installed without their target-triple suffix. */
export const SIDECARS = ['uv', 'cloudflared']
/**
 * Bun-compiled binaries kept out of `bundle.resources` (buildAppImage.sh copies them into the AppImage
 * after linuxdeploy, whose patchelf would cut their payload off); the stage copies them the same way.
 */
export const CORE_BINARIES = [
  'atomic-chat-core',
  'atomic-chat-app-core',
  'jan-cli',
]

/**
 * Where a PNG icon goes in the hicolor theme: by its own pixel size, read from the PNG header (IHDR width
 * and height at bytes 16-23). The stage takes the icons from Tauri's deb, whose directory names are not
 * the size (it puts the 256 px icon in `256x256@2`, the theme's 512 px HiDPI directory); src-tauri/icons
 * is generated at build time and not in the checkout the packages job packs from.
 */
export function hicolorPath(png) {
  if (
    png.length < 24 ||
    png.toString('latin1', 1, 4) !== 'PNG' ||
    png.toString('latin1', 12, 16) !== 'IHDR'
  )
    throw new Error('not a PNG file')
  return `hicolor/${png.readUInt32BE(16)}x${png.readUInt32BE(20)}/apps/${APP_ID}.png`
}

/** One package per architecture, each built from that architecture's AppImage job. */
export const PACKAGE_TARGETS = [
  { arch: 'x86_64', deb: 'amd64', rpm: 'x86_64', node: 'x64' },
  { arch: 'aarch64', deb: 'arm64', rpm: 'aarch64', node: 'arm64' },
]

export const PACKAGE_FORMATS = ['deb', 'rpm']

/**
 * What the app opens at run time rather than links, so no ELF file names it. tray-icon dlopens
 * libayatana-appindicator3 when the tray is created and panics when it is missing; WebKit plays media
 * through GStreamer plugins; links open with xdg-open.
 */
export const RUNTIME_DEPENDENCIES = {
  deb: {
    depends: ['libayatana-appindicator3-1'],
    recommends: [
      'gstreamer1.0-plugins-base',
      'gstreamer1.0-plugins-good',
      'xdg-utils',
    ],
  },
  rpm: {
    depends: ['libayatana-appindicator3.so.1()(64bit)'],
    recommends: [
      'gstreamer1-plugins-base',
      'gstreamer1-plugins-good',
      'xdg-utils',
    ],
  },
}

/**
 * Where the apt/dnf repository lives: a public bucket on Hetzner Object Storage, served on its own HTTPS
 * host. Its own bucket, not eye-cli's `atc-packages`: that repository is rebuilt from eye-cli's releases
 * alone and would delete these packages. README.md's install commands name the same URL (a test keeps
 * them equal).
 */
export const REPOSITORY = {
  bucket: 'atomic-chat-packages',
  region: 'fsn1',
  endpoint: 'https://fsn1.your-objectstorage.com',
  baseUrl: 'https://atomic-chat-packages.fsn1.your-objectstorage.com',
}

/** Releases the repository keeps: each one is ~1 GB of packages, and apt/dnf only ever install the newest. */
export const REPOSITORY_KEEP = 3

/**
 * The names a user's machine gets for this repository (README.md). `atomic-chat` is taken there by
 * eye-cli's repository of the `atc` CLI, which a user may have added too.
 */
export const LOCAL_NAME = 'atomic-chat-app'

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/
export const PACKAGE_FILE = /^atomic-chat_.+\.(deb|rpm)$/

/** `atomic-chat_<version>_<arch>.<format>`: no glob of the other release assets (Atomic.Chat_*, atomic-chat-mac-*) matches it. */
export function packageFileName(version, format, target) {
  return `${PACKAGE_NAME}_${version}_${target[format]}.${format}`
}

export function packageAssets(version) {
  return PACKAGE_FORMATS.flatMap((format) =>
    PACKAGE_TARGETS.map((t) => packageFileName(version, format, t))
  )
}

export function targetFor(arch) {
  const target = PACKAGE_TARGETS.find((t) => t.arch === arch)
  if (!target)
    throw new Error(
      `no package target for ${arch}; one of ${PACKAGE_TARGETS.map((t) => t.arch).join(', ')}`
    )
  return target
}

/** pacman's pkgver allows no hyphen: 2.3.0-rc.1 → 2.3.0rc.1 (which still sorts before 2.3.0). */
export function archPkgver(version) {
  return version.replace(/^v/, '').replaceAll('-', '')
}

// ── ELF dependencies ─────────────────────────────────────────────────────────────────────────────
// nfpm writes no dependencies of its own (dpkg-shlibdeps and rpm's elfdeps belong to debhelper and
// rpmbuild), so the stage reads them from every ELF file of the payload with readelf.

/** `readelf --dynamic` → { needed: sonames it links, soname: its own SONAME or undefined }. */
export function parseDynamic(readelfDynamic) {
  const needed = [
    ...readelfDynamic.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g),
  ].map((m) => m[1])
  const soname = /\(SONAME\)\s+Library soname: \[([^\]]+)\]/.exec(
    readelfDynamic
  )?.[1]
  return { needed, soname }
}

/**
 * `readelf --version-info` → the versions it needs, per library: [{ file, versions: [{ name, weak }] }].
 * Only the "Version needs" section: the definitions section has Name: lines of its own.
 */
export function parseVersionNeeds(readelfVersions) {
  const entries = []
  let inNeeds = false
  for (const line of readelfVersions.split('\n')) {
    if (/^Version needs section/.test(line)) {
      inNeeds = true
      continue
    }
    if (/^Version (definition|symbols) section/.test(line)) {
      inNeeds = false
      continue
    }
    if (!inNeeds) continue
    const file = /\sFile: (\S+)/.exec(line)
    if (file) {
      entries.push({ file: file[1], versions: [] })
      continue
    }
    const version = /\sName: (\S+)\s+Flags: (\S+)/.exec(line)
    if (version && entries.length)
      entries
        .at(-1)
        .versions.push({ name: version[1], weak: version[2].includes('WEAK') })
  }
  return entries
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

/**
 * The oldest glibc the payload runs on: the highest non-WEAK GLIBC_x.y any of its files requires.
 * `elves`: [{ versionNeeds }] as parseVersionNeeds returns them.
 */
export function glibcFloor(elves) {
  const versions = elves
    .flatMap((e) => e.versionNeeds)
    .flatMap((n) => n.versions)
    .filter((v) => !v.weak && /^GLIBC_\d+(\.\d+)+$/.test(v.name))
    .map((v) => v.name.slice('GLIBC_'.length).split('.').map(Number))
  if (versions.length === 0)
    throw new Error('no ELF file of the payload names a GLIBC_ version')
  return versions
    .reduce((max, v) => (compareVersions(v, max) > 0 ? v : max))
    .join('.')
}

/**
 * The libraries the payload needs from the system: every NEEDED soname that no file of the payload
 * provides (by its SONAME, its file name, or a symlink's name in `ownNames`). `elves`: [{ path,
 * needed, soname }].
 */
export function externalLibraries(elves, ownNames = []) {
  const own = new Set([
    ...ownNames,
    ...elves.flatMap((e) =>
      [e.path.split('/').pop(), e.soname].filter(Boolean)
    ),
  ])
  return [...new Set(elves.flatMap((e) => e.needed))]
    .filter((so) => !own.has(so))
    .sort()
}

/**
 * rpm requirements the way rpmbuild's elfdeps writes them for 64-bit ELF files: `soname()(64bit)` for
 * each library and `soname(VERSION)(64bit)` for each symbol version it needs, so dnf and zypper resolve
 * them on any rpm distro, whatever its package names.
 */
export function rpmRequires(elves, ownNames = []) {
  const external = new Set(externalLibraries(elves, ownNames))
  const requires = new Set([...external].map((so) => `${so}()(64bit)`))
  for (const need of elves.flatMap((e) => e.versionNeeds)) {
    if (!external.has(need.file)) continue
    for (const v of need.versions)
      if (!v.weak) requires.add(`${need.file}(${v.name})(64bit)`)
  }
  return [...requires].sort()
}

/** `ldconfig -p` → { soname: path } for this machine's architecture (the `x86-64` / `AArch64` tag). */
export function parseLdconfig(text, arch) {
  const tag = { x86_64: 'x86-64', aarch64: 'AArch64' }[arch]
  if (!tag) throw new Error(`no ldconfig tag for ${arch}`)
  const paths = {}
  for (const line of text.split('\n')) {
    const match = /^\s*(\S+) \(([^)]*)\) => (\S+)$/.exec(line)
    if (match && match[2].split(',').includes(tag) && !(match[1] in paths))
      paths[match[1]] = match[3]
  }
  return paths
}

/** `dpkg -S <path>` → the package that owns it (`libfoo1:amd64: /usr/lib/...` → `libfoo1`). */
export function parseDpkgSearch(text) {
  const line = text
    .split('\n')
    .find((l) => l.includes(': /') && !l.startsWith('diversion '))
  if (!line) throw new Error(`dpkg -S found no package: ${text.trim()}`)
  const owner = line.slice(0, line.indexOf(': /')).split(',')[0].trim()
  return owner.replace(/:[a-z0-9]+$/, '')
}

/**
 * The deb Depends: the packages that own the payload's system libraries on the build machine
 * (Ubuntu 22.04, the oldest the AppImage supports), unversioned but for libc6, which gets the glibc
 * floor. Newer releases renamed some of them (libasound2 → libasound2t64); those provide the old name.
 */
export function debDepends(owners, glibc) {
  const packages = new Set(owners)
  packages.delete('libc6')
  return [`libc6 (>= ${glibc})`, ...[...packages].sort()]
}

// ── nfpm ─────────────────────────────────────────────────────────────────────────────────────────

const DESCRIPTION = [
  'Local AI app and inference engine for agents',
  'Run open-weight LLMs locally, private, on your machine: chat with them, and serve them to',
  'agents, editors and scripts over an OpenAI-compatible API on localhost.',
].join('\n')

/**
 * The nfpm config of one package, as an object (`linux-packages.mjs` writes it as JSON, which nfpm reads
 * as YAML): the dependencies are lists read from the payload, which nfpm's ${VAR} expansion cannot fill.
 * `stage`: the directory holding opt/atomic-chat; `deps`: the stage's deps.json; `root`: the checkout.
 */
export function nfpmConfig({
  version,
  target,
  format,
  stage,
  deps,
  root,
  rpmSigningKeyFile,
}) {
  const file = (src, dst, mode = 0o644) => ({ src, dst, file_info: { mode } })
  const config = {
    name: PACKAGE_NAME,
    arch: target[format],
    platform: 'linux',
    version,
    release: '1',
    section: 'utils',
    priority: 'optional',
    maintainer: 'Atomic Chat <support@atomic.chat>',
    vendor: 'Atomic Chat',
    homepage: 'https://atomic.chat',
    license: 'Apache-2.0',
    description: DESCRIPTION,
    depends: deps[format].depends,
    recommends: deps[format].recommends,
    contents: [
      // Modes come from the stage, which keeps the executable bits of the build.
      { src: `${stage}/opt/atomic-chat`, dst: INSTALL_DIR, type: 'tree' },
      {
        src: `${INSTALL_DIR}/bin/${MAIN_BINARY}`,
        dst: COMMAND,
        type: 'symlink',
      },
      file(
        `${root}/packaging/atomic-chat.desktop`,
        `/usr/share/applications/${APP_ID}.desktop`
      ),
      // The stage's icons, renamed to the app id (hicolorPath).
      { src: `${stage}/icons`, dst: '/usr/share/icons', type: 'tree' },
      file(`${root}/LICENSE`, `/usr/share/licenses/${PACKAGE_NAME}/LICENSE`),
    ],
    // On an upgrade: quit and restart the running app (packaging/postinstall.sh says why).
    scripts: { postinstall: `${root}/packaging/postinstall.sh` },
    // The payload is mostly compressed already (tarballs, models' runtimes); zstd packs ~1 GB in seconds
    // where nfpm's xz takes minutes. dpkg reads it since Debian 12 / Ubuntu 21.10, rpm since RHEL 8.
    deb: { compression: 'zstd' },
    rpm: {
      compression: 'zstd',
      ...(rpmSigningKeyFile
        ? { signature: { key_file: rpmSigningKeyFile } }
        : {}),
    },
  }
  return config
}

// ── AUR ──────────────────────────────────────────────────────────────────────────────────────────

/** packaging/PKGBUILD.in with this release's version, download base and the debs' checksums. */
export function renderPkgbuild(template, { version, sums, sourceBase }) {
  const sum = (name) => {
    const hash = sums[name]
    if (!hash) throw new Error(`no checksum for ${name}`)
    return hash
  }
  const [x64, arm64] = PACKAGE_TARGETS
  const values = {
    VERSION: version,
    PKGVER: archPkgver(version),
    SOURCE_BASE: sourceBase,
    SHA_X86_64: sum(packageFileName(version, 'deb', x64)),
    SHA_AARCH64: sum(packageFileName(version, 'deb', arm64)),
  }
  // A Windows checkout has CRLF line ends; bash would read the \r as part of every line.
  return template
    .replace(/\r\n/g, '\n')
    .replace(/@([A-Z0-9_]+)@/g, (match, key) => {
      if (!(key in values))
        throw new Error(`PKGBUILD.in has an unknown placeholder ${match}`)
      return values[key]
    })
}

// ── The repository ───────────────────────────────────────────────────────────────────────────────

function stableVersion(tag) {
  const match = STABLE.exec(tag)
  return match ? match.slice(1).map(Number) : undefined
}

/**
 * The releases the repository carries: the newest `keep` published, stable releases that have packages
 * (GitHub's release JSON). Drafts and pre-releases never; releases from before the packages are skipped.
 */
export function selectReleases(releases, keep = REPOSITORY_KEEP) {
  return releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      tag: r.tag_name,
      parts: stableVersion(r.tag_name),
      assets: r.assets ?? [],
    }))
    .filter((r) => r.parts && r.assets.some((a) => PACKAGE_FILE.test(a.name)))
    .sort((a, b) => -compareVersions(a.parts, b.parts))
    .slice(0, keep)
    .map((r) => ({ tag: r.tag, version: r.parts.join('.'), assets: r.assets }))
}

/** A release's package assets with the sha256 GitHub computed for each (`digest: "sha256:…"`). */
export function packageDigests(assets) {
  const digests = {}
  for (const asset of assets.filter((a) => PACKAGE_FILE.test(a.name))) {
    const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')
    if (!match)
      throw new Error(`GitHub lists no sha256 digest for ${asset.name}`)
    digests[asset.name] = match[1]
  }
  return digests
}

/** Where a package file lives in the repository. */
export function repoPath(file) {
  if (file.endsWith('.deb')) return `deb/pool/main/a/${PACKAGE_NAME}/${file}`
  if (file.endsWith('.rpm')) return `rpm/packages/${file}`
  throw new Error(`not a package: ${file}`)
}

/** The dnf repository definition users download into /etc/yum.repos.d. */
export function renderRepoFile({ baseUrl, packageSignatures = true }) {
  return [
    `[${LOCAL_NAME}]`,
    'name=Atomic Chat',
    `baseurl=${baseUrl}/rpm`,
    'enabled=1',
    `gpgcheck=${packageSignatures ? 1 : 0}`,
    'repo_gpgcheck=1',
    `gpgkey=${baseUrl}/atomic-chat.asc`,
    '',
  ].join('\n')
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'no-cache'

/** Packages never change under a name; indexes and keys are checked on every request. */
export function cacheControl(path) {
  return PACKAGE_FILE.test(path.split('/').pop() ?? '') ? IMMUTABLE : REVALIDATE
}

const TYPES = [
  [/\.deb$/, 'application/vnd.debian.binary-package'],
  [/\.rpm$/, 'application/x-rpm'],
  [/\.gz$/, 'application/gzip'],
  [/\.xml$/, 'application/xml'],
  [/(^|\/)atomic-chat\.(asc|gpg)$/, 'application/pgp-keys'],
  [/(Release\.gpg|\.asc)$/, 'application/pgp-signature'],
]

export function contentType(path) {
  return (
    TYPES.find(([pattern]) => pattern.test(path))?.[1] ??
    'text/plain; charset=utf-8'
  )
}

/**
 * Upload order, so a client never sees an index that names a file not uploaded yet: packages, then the
 * indexes they are listed in, then what points at those (Release, InRelease, repomd.xml and their
 * signatures, the keys, the .repo file).
 */
function rank(path) {
  const name = path.split('/').pop() ?? ''
  if (PACKAGE_FILE.test(name)) return 0
  if (/^(Packages(\.gz)?)$/.test(name)) return 1
  if (path.startsWith('rpm/repodata/') && !name.startsWith('repomd.xml'))
    return 1
  return 2
}

/**
 * What to change in the bucket to make it `local`: upload new packages (an uploaded one is identical,
 * names are never reused), upload every index and key, then delete what is no longer listed.
 */
export function syncPlan(local, remote) {
  const remoteSet = new Set(remote)
  const localSet = new Set(local)
  const puts = local
    .filter((p) => rank(p) > 0 || !remoteSet.has(p))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((path) => ({ op: 'put', path, cacheControl: cacheControl(path) }))
  const deletes = remote
    .filter((p) => !localSet.has(p))
    .sort()
    .map((path) => ({ op: 'delete', path }))
  return [...puts, ...deletes]
}

/** The shell lines of the README block marked `<!-- install:<name> -->`, the instructions users follow. */
export function readmeInstallBlock(readme, name) {
  readme = readme.replace(/\r\n/g, '\n')
  const marker = `<!-- install:${name} -->`
  const at = readme.indexOf(marker)
  if (at < 0) throw new Error(`README.md has no ${marker}`)
  const match = /```(?:sh|bash)\n([\s\S]*?)```/.exec(readme.slice(at))
  if (!match) throw new Error(`README.md has no sh block after ${marker}`)
  return match[1]
}
