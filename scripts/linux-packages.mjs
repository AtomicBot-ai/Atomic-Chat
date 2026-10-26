#!/usr/bin/env node
// Stage the Linux payload, build the deb and rpm from it with nfpm, and render the AUR PKGBUILD. Names,
// the layout, the dependency rules and the PKGBUILD filling are in linux-packaging.mjs.
//
//   node scripts/linux-packages.mjs stage --arch x86_64|aarch64 (--tauri-deb FILE | --tauri-root DIR)
//                                         [--bin-dir src-tauri/resources/bin] [--out dist/linux-stage]
//   node scripts/linux-packages.mjs build --version X.Y.Z [--stage dist/linux-stage] [--out dist/pkg]
//   node scripts/linux-packages.mjs pkgbuild --version X.Y.Z --assets DIR [--source-base URL] [--out aur] [--partial]
//
// `stage` runs in the AppImage job, on the architecture it stages, after `tauri build --bundles
// appimage,deb`: it takes the app, its sidecars and resources from Tauri's deb (unpacked: no linuxdeploy,
// no patchelf, none of the AppImage's bundled system libraries), adds bun and the core binaries from
// `--bin-dir` as buildAppImage.sh does, moves it all under /opt/atomic-chat, and writes deps.json: the
// system libraries every ELF file of it links, as deb packages (looked up on this machine with ldconfig
// and dpkg) and as rpm soname requirements. `--tauri-root` takes an unpacked tree instead (usr/bin,
// usr/lib/Atomic Chat), e.g. an extracted AppImage's AppDir for a local try.
//
// `build` runs anywhere nfpm does and packs every architecture staged under `--stage`. It signs the rpm
// when RPM_SIGNING_KEY_FILE names an armored private key (its passphrase in NFPM_RPM_PASSPHRASE); unset,
// the rpm is unsigned. `pkgbuild` checksums the debs in `--assets`; `--source-base` defaults to the
// release's download URL on GitHub; `--partial` writes SKIP for a deb that is not there (a smoke test
// of a one-architecture build, never the AUR).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AUR_INSTALL_FILE,
  CORE_BINARIES,
  MAIN_BINARY,
  PACKAGE_FORMATS,
  PACKAGE_MANAGED_MARKER,
  PACKAGE_TARGETS,
  PRODUCT_NAME,
  RUNTIME_DEPENDENCIES,
  SIDECARS,
  debDepends,
  externalLibraries,
  glibcFloor,
  hicolorPath,
  nfpmConfig,
  packageFileName,
  parseDpkgSearch,
  parseDynamic,
  parseLdconfig,
  parseVersionNeeds,
  renderPkgbuild,
  rpmRequires,
  targetFor,
} from './linux-packaging.mjs'

// No trailing slash: nfpm's globs do not match a path with `//` in it.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPO = 'AtomicBot-ai/Atomic-Chat'

function fail(message) {
  console.error(`linux-packages: ${message}`)
  process.exit(1)
}

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--'))
    fail(`--${name} needs a value`)
  return value
}

function run(command, args, options = {}) {
  const res = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    ...options,
  })
  if (res.error) fail(`${command}: ${res.error.message}`)
  if (res.status !== 0)
    fail(`${command} ${args.join(' ')} failed:\n${res.stderr ?? ''}`)
  return res.stdout
}

function required(name) {
  const value = option(name)
  if (!value) fail(`--${name} is required; see the header of this file`)
  return value
}

/** Every regular file and every symlink under `dir` (symlinks not followed). */
function walk(dir) {
  const paths = readdirSync(dir, { recursive: true }).map((p) =>
    join(dir, String(p))
  )
  return {
    files: paths.filter((p) => lstatSync(p).isFile()),
    links: paths.filter((p) => lstatSync(p).isSymbolicLink()),
  }
}

function isElf(path) {
  const fd = openSync(path, 'r')
  try {
    const magic = Buffer.alloc(4)
    return (
      readSync(fd, magic, 0, 4, 0) === 4 &&
      magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
  } finally {
    closeSync(fd)
  }
}

/** In chunks: a deb is a few hundred MB. */
function sha256(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1 << 20)
  const fd = openSync(path, 'r')
  try {
    for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0; )
      hash.update(buffer.subarray(0, n))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** The package that owns `path`, trying the path ldconfig reported, its real path and its /usr-merged twin. */
function owningPackage(path) {
  const real = realpathSync(path)
  const candidates = new Set([path, real])
  for (const p of [path, real]) {
    if (p.startsWith('/usr/lib/')) candidates.add(p.slice('/usr'.length))
    else if (p.startsWith('/lib/')) candidates.add(`/usr${p}`)
  }
  for (const candidate of candidates) {
    const res = spawnSync('dpkg', ['-S', candidate], { encoding: 'utf8' })
    if (res.status === 0) return parseDpkgSearch(res.stdout)
  }
  return undefined
}

function stage() {
  const target = targetFor(required('arch'))
  const binDir = resolve(
    option('bin-dir', join(ROOT, 'src-tauri/resources/bin'))
  )
  const out = resolve(
    option('out', join(ROOT, 'dist/linux-stage')),
    target.arch
  )
  if (process.platform !== 'linux' || process.arch !== target.node)
    fail(
      `stage ${target.arch} on Linux ${target.node}: it runs the core and reads this machine's libraries`
    )

  const scratch = mkdtempSync(join(tmpdir(), 'atomic-chat-stage-'))
  try {
    let tauriRoot = option('tauri-root')
    const tauriDeb = option('tauri-deb')
    if (!tauriRoot && !tauriDeb) fail('stage needs --tauri-deb or --tauri-root')
    if (tauriDeb) {
      tauriRoot = join(scratch, 'tauri')
      run('dpkg-deb', ['-x', resolve(tauriDeb), tauriRoot])
    }
    tauriRoot = resolve(tauriRoot)
    const resourceDir = join(tauriRoot, 'usr/lib', PRODUCT_NAME)
    if (!existsSync(resourceDir))
      fail(`${resourceDir} is missing: not a Tauri deb tree`)

    rmSync(out, { recursive: true, force: true })
    const bin = join(out, 'opt/atomic-chat/bin')
    const lib = join(out, 'opt/atomic-chat/lib')
    mkdirSync(bin, { recursive: true })
    mkdirSync(lib, { recursive: true })
    // cp -a keeps the modes and the symlinks the resources carry (versioned .so links).
    for (const name of [MAIN_BINARY, ...SIDECARS]) {
      const src = join(tauriRoot, 'usr/bin', name)
      if (!existsSync(src)) fail(`${src} is missing from the Tauri build`)
      run('cp', ['-a', src, join(bin, name)])
    }
    run('cp', ['-a', resourceDir, join(lib, PRODUCT_NAME)])
    const resBin = join(lib, PRODUCT_NAME, 'resources/bin')
    mkdirSync(resBin, { recursive: true })
    for (const [name, dir] of [
      ['bun', bin],
      ...CORE_BINARIES.map((n) => [n, resBin]),
    ]) {
      const src = join(binDir, name)
      if (!existsSync(src))
        fail(
          `${src} is missing; run \`yarn download:bin\`, \`yarn download:core\` and \`yarn build:cli\` first`
        )
      run('cp', [src, join(dir, name)])
      chmodSync(join(dir, name), 0o755)
    }
    // An intact Bun payload still runs; a truncated one does not (the reason for the copy above).
    run(join(resBin, 'atomic-chat-core'), ['--version'])
    writeFileSync(join(bin, PACKAGE_MANAGED_MARKER), '')
    // The icons Tauri bundled (from the generated src-tauri/icons), under the app id, by their size.
    const tauriIcons = join(tauriRoot, 'usr/share/icons/hicolor')
    const pngs = existsSync(tauriIcons)
      ? walk(tauriIcons).files.filter((p) => p.endsWith('.png'))
      : []
    if (pngs.length === 0) fail(`${tauriIcons} holds no icons`)
    for (const png of pngs) {
      const target = join(out, 'icons', hicolorPath(readFileSync(png)))
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(png, target)
    }
    // nfpm keeps the stage's modes. Whatever the source tree had (an extracted AppImage has 0700
    // directories), users must read everything and run what is executable: 0755 / 0644.
    run('chmod', ['-R', 'u+rwX,go=rX', join(out, 'opt'), join(out, 'icons')])

    const tree = walk(join(out, 'opt'))
    // A versioned library's links (libfoo.so → libfoo.so.1) provide it under their names too.
    const ownNames = tree.links.map((p) => p.split('/').pop())
    const elves = tree.files.filter(isElf).map((path) => ({
      path,
      ...parseDynamic(run('readelf', ['--dynamic', '--wide', path])),
      versionNeeds: parseVersionNeeds(
        run('readelf', ['--version-info', '--wide', path])
      ),
    }))
    const glibc = glibcFloor(elves)
    const libraries = externalLibraries(elves, ownNames)
    const paths = parseLdconfig(run('ldconfig', ['-p']), target.arch)
    const owners = []
    for (const so of libraries) {
      const users = elves
        .filter((e) => e.needed.includes(so))
        .map((e) => e.path.slice(out.length + 1))
      const where = `${so} (needed by ${users.slice(0, 3).join(', ')}${users.length > 3 ? ', …' : ''})`
      if (!paths[so])
        fail(
          `${where} is not installed here; install its package in the workflow so the deb can depend on it`
        )
      const owner = owningPackage(paths[so])
      if (!owner) fail(`no package owns ${paths[so]}, which provides ${where}`)
      owners.push(owner)
    }
    const deps = {
      glibc,
      libraries,
      deb: {
        depends: [
          ...new Set([
            ...debDepends(owners, glibc),
            ...RUNTIME_DEPENDENCIES.deb.depends,
          ]),
        ],
        recommends: RUNTIME_DEPENDENCIES.deb.recommends,
      },
      rpm: {
        depends: [
          ...new Set([
            ...rpmRequires(elves, ownNames),
            ...RUNTIME_DEPENDENCIES.rpm.depends,
          ]),
        ],
        recommends: RUNTIME_DEPENDENCIES.rpm.recommends,
      },
    }
    writeFileSync(join(out, 'deps.json'), `${JSON.stringify(deps, null, 2)}\n`)
    console.log(
      `staged ${out}: ${elves.length} ELF files, ${libraries.length} system libraries, glibc >= ${glibc}`
    )
    console.log(`deb Depends: ${deps.deb.depends.join(', ')}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function build() {
  const version = required('version')
  const stageDir = resolve(option('stage', join(ROOT, 'dist/linux-stage')))
  const out = resolve(option('out', join(ROOT, 'dist/pkg')))
  const staged = PACKAGE_TARGETS.filter((t) =>
    existsSync(join(stageDir, t.arch, 'deps.json'))
  )
  if (staged.length === 0)
    fail(
      `${stageDir} holds no staged architecture (${PACKAGE_TARGETS.map((t) => t.arch).join(', ')})`
    )
  mkdirSync(out, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'atomic-chat-nfpm-'))
  try {
    for (const target of staged) {
      const stage = join(stageDir, target.arch)
      const deps = JSON.parse(readFileSync(join(stage, 'deps.json'), 'utf8'))
      for (const format of PACKAGE_FORMATS) {
        const config = nfpmConfig({
          version,
          target,
          format,
          stage,
          deps,
          root: ROOT,
          rpmSigningKeyFile: process.env.RPM_SIGNING_KEY_FILE || undefined,
        })
        const configFile = join(scratch, `${target.arch}-${format}.json`)
        writeFileSync(configFile, JSON.stringify(config, null, 2))
        const file = join(out, packageFileName(version, format, target))
        run(
          'nfpm',
          [
            'package',
            '--config',
            configFile,
            '--packager',
            format,
            '--target',
            file,
          ],
          { cwd: ROOT }
        )
        console.log(`built ${file}`)
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function pkgbuild() {
  const version = required('version')
  const assets = resolve(required('assets'))
  const sourceBase = option(
    'source-base',
    `https://github.com/${REPO}/releases/download/v${version}`
  )
  const out = resolve(option('out', 'aur'))
  const sums = {}
  for (const target of PACKAGE_TARGETS) {
    const name = packageFileName(version, 'deb', target)
    const path = join(assets, name)
    if (existsSync(path)) sums[name] = sha256(path)
    else if (process.argv.includes('--partial')) sums[name] = 'SKIP'
    else fail(`${path} is missing; the PKGBUILD pins both debs`)
  }
  const template = readFileSync(join(ROOT, 'packaging/PKGBUILD.in'), 'utf8')
  let text
  try {
    text = renderPkgbuild(template, { version, sums, sourceBase })
  } catch (error) {
    fail(error.message)
  }
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'PKGBUILD'), text)
  // The PKGBUILD's `install=` file goes into the AUR repository beside it.
  copyFileSync(
    join(ROOT, 'packaging', AUR_INSTALL_FILE),
    join(out, AUR_INSTALL_FILE)
  )
  console.log(
    `wrote ${join(out, 'PKGBUILD')} and ${AUR_INSTALL_FILE} for Atomic Chat ${version}`
  )
}

const command = process.argv[2]
if (command === 'stage') stage()
else if (command === 'build') build()
else if (command === 'pkgbuild') pkgbuild()
else
  fail(
    'usage: linux-packages.mjs stage|build|pkgbuild [options]; see the header of this file'
  )
