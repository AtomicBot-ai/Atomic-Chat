// The pure part of the Linux packages and their repository (scripts/linux-packaging.mjs): names, the
// dependencies read from readelf/ldconfig/dpkg output, the nfpm config, the PKGBUILD and the repository.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  APP_ID,
  AUR_INSTALL_FILE,
  CORE_BINARIES,
  INSTALL_DIR,
  LOCAL_NAME,
  MAIN_BINARY,
  PACKAGE_MANAGED_MARKER,
  PACKAGE_TARGETS,
  PRODUCT_NAME,
  REPOSITORY,
  SIDECARS,
  archPkgver,
  cacheControl,
  contentType,
  debDepends,
  externalLibraries,
  glibcFloor,
  nfpmConfig,
  packageAssets,
  packageDigests,
  parseDpkgSearch,
  parseDynamic,
  parseLdconfig,
  parseVersionNeeds,
  readmeInstallBlock,
  renderPkgbuild,
  renderRepoFile,
  repoPath,
  rpmRequires,
  selectReleases,
  syncPlan,
} from '../scripts/linux-packaging.mjs'

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'))
const tauriLinux = JSON.parse(read('src-tauri/tauri.linux.conf.json'))

test('one deb and one rpm per architecture, matching no glob of the other release assets', () => {
  const names = packageAssets('2.3.0')
  assert.deepEqual(names, [
    'atomic-chat_2.3.0_amd64.deb',
    'atomic-chat_2.3.0_arm64.deb',
    'atomic-chat_2.3.0_x86_64.rpm',
    'atomic-chat_2.3.0_aarch64.rpm',
  ])
  for (const name of names) {
    assert.ok(
      !name.startsWith('Atomic.Chat_') && !name.startsWith('atomic-chat-mac-'),
      name
    )
    assert.ok(!/\.(AppImage|sig|exe|msi|dmg|zip|tar\.gz)$/.test(name), name)
  }
})

test('the layout follows the Tauri config the app is built from', () => {
  assert.equal(PRODUCT_NAME, tauri.productName)
  assert.equal(APP_ID, tauri.identifier)
  assert.equal(MAIN_BINARY, tauri.mainBinaryName ?? 'Atomic-Chat')
  assert.deepEqual(
    SIDECARS,
    tauriLinux.bundle.externalBin.map((p) => p.split('/').pop())
  )
  // The core binaries stay out of bundle.resources (linuxdeploy's patchelf); the stage adds them.
  for (const name of CORE_BINARIES) {
    assert.ok(!tauriLinux.bundle.resources.some((r) => r.includes(name)), name)
  }
  assert.equal(INSTALL_DIR, '/opt/atomic-chat')
})

test('the marker is the one the updater looks for next to the executable', () => {
  const rust = read('src-tauri/src/core/updater/package_managed.rs')
  assert.match(
    rust,
    new RegExp(`PACKAGE_MANAGED_MARKER: &str = "${PACKAGE_MANAGED_MARKER}"`)
  )
})

test('the desktop entry starts the installed binary and is matched by the Wayland app id', () => {
  const entry = read('packaging/atomic-chat.desktop')
  const appId = APP_ID.replaceAll('.', '\\.')
  assert.match(
    entry,
    new RegExp(`^Exec=${INSTALL_DIR}/bin/${MAIN_BINARY}$`, 'm')
  )
  assert.match(entry, new RegExp(`^Icon=${appId}$`, 'm'))
  // The same class the bundled template declares (build-utils/atomic-chat.desktop).
  assert.match(entry, new RegExp(`^StartupWMClass=${appId}$`, 'm'))
  assert.match(
    read('src-tauri/build-utils/atomic-chat.desktop'),
    new RegExp(`^StartupWMClass=${appId}$`, 'm')
  )
  assert.match(entry, /^Type=Application$/m)
})

test('pacman versions drop the hyphen and still sort before the release', () => {
  assert.equal(archPkgver('2.3.0'), '2.3.0')
  assert.equal(archPkgver('v2.3.0-rc.1'), '2.3.0rc.1')
})

// readelf --dynamic --wide of a llama.cpp backend library (abridged).
const DYNAMIC = [
  'Dynamic section at offset 0x1d8c8 contains 31 entries:',
  '  Tag        Type                         Name/Value',
  ' 0x0000000000000001 (NEEDED)             Shared library: [libggml-base.so]',
  ' 0x0000000000000001 (NEEDED)             Shared library: [libvulkan.so.1]',
  ' 0x0000000000000001 (NEEDED)             Shared library: [libstdc++.so.6]',
  ' 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]',
  ' 0x000000000000000e (SONAME)             Library soname: [libggml-vulkan.so]',
  ' 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN]',
].join('\n')

// readelf --version-info --wide, with a definitions section whose Name: lines must not count.
const VERSIONS = [
  "Version definition section '.gnu.version_d' contains 2 entries:",
  '  0x0000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: libggml-vulkan.so',
  '  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBC_9.99',
  '',
  "Version needs section '.gnu.version_r' contains 2 entries:",
  ' Addr: 0x0000000000003a10  Offset: 0x003a10  Link: 7 (.dynstr)',
  '  000000: Version: 1  File: libstdc++.so.6  Cnt: 2',
  '  0x0010:   Name: GLIBCXX_3.4  Flags: none  Version: 5',
  '  0x0020:   Name: CXXABI_1.3  Flags: none  Version: 4',
  '  0x0030: Version: 1  File: libc.so.6  Cnt: 3',
  '  0x0040:   Name: GLIBC_2.17  Flags: none  Version: 3',
  '  0x0050:   Name: GLIBC_2.34  Flags: none  Version: 2',
  '  0x0060:   Name: GLIBC_2.38  Flags: WEAK  Version: 6',
].join('\n')

test('parseDynamic reads the libraries a file links and its own soname', () => {
  assert.deepEqual(parseDynamic(DYNAMIC), {
    needed: [
      'libggml-base.so',
      'libvulkan.so.1',
      'libstdc++.so.6',
      'libc.so.6',
    ],
    soname: 'libggml-vulkan.so',
  })
  assert.deepEqual(parseDynamic('There is no dynamic section in this file.'), {
    needed: [],
    soname: undefined,
  })
})

test('parseVersionNeeds reads only the needs section', () => {
  assert.deepEqual(parseVersionNeeds(VERSIONS), [
    {
      file: 'libstdc++.so.6',
      versions: [
        { name: 'GLIBCXX_3.4', weak: false },
        { name: 'CXXABI_1.3', weak: false },
      ],
    },
    {
      file: 'libc.so.6',
      versions: [
        { name: 'GLIBC_2.17', weak: false },
        { name: 'GLIBC_2.34', weak: false },
        { name: 'GLIBC_2.38', weak: true },
      ],
    },
  ])
})

const elves = [
  {
    path: '/s/opt/atomic-chat/lib/x/libggml-vulkan.so',
    ...parseDynamic(DYNAMIC),
    versionNeeds: parseVersionNeeds(VERSIONS),
  },
  {
    path: '/s/opt/atomic-chat/lib/x/libggml-base.so',
    needed: ['libc.so.6', 'libm.so.6'],
    soname: 'libggml-base.so',
    versionNeeds: [
      { file: 'libc.so.6', versions: [{ name: 'GLIBC_2.35', weak: false }] },
    ],
  },
]

test('glibcFloor is the newest non-WEAK glibc any file needs, compared as numbers', () => {
  assert.equal(glibcFloor(elves), '2.35')
  assert.equal(
    glibcFloor([
      {
        versionNeeds: [
          {
            file: 'libc.so.6',
            versions: [
              { name: 'GLIBC_2.9', weak: false },
              { name: 'GLIBC_2.17', weak: false },
            ],
          },
        ],
      },
    ]),
    '2.17'
  )
  assert.throws(() => glibcFloor([{ versionNeeds: [] }]), /GLIBC_/)
})

test("externalLibraries leaves out what the payload provides itself, under a symlink's name too", () => {
  assert.deepEqual(externalLibraries(elves), [
    'libc.so.6',
    'libm.so.6',
    'libstdc++.so.6',
    'libvulkan.so.1',
  ])
  assert.deepEqual(externalLibraries(elves, ['libvulkan.so.1']), [
    'libc.so.6',
    'libm.so.6',
    'libstdc++.so.6',
  ])
})

test('rpmRequires writes sonames and their symbol versions the way rpmbuild does, without WEAK ones', () => {
  assert.deepEqual(rpmRequires(elves), [
    'libc.so.6()(64bit)',
    'libc.so.6(GLIBC_2.17)(64bit)',
    'libc.so.6(GLIBC_2.34)(64bit)',
    'libc.so.6(GLIBC_2.35)(64bit)',
    'libm.so.6()(64bit)',
    'libstdc++.so.6()(64bit)',
    'libstdc++.so.6(CXXABI_1.3)(64bit)',
    'libstdc++.so.6(GLIBCXX_3.4)(64bit)',
    'libvulkan.so.1()(64bit)',
  ])
})

test('parseLdconfig keeps this architecture and the first path of a soname', () => {
  const text = [
    "1234 libs found in cache `/etc/ld.so.cache'",
    '\tlibvulkan.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so.1',
    '\tlibvulkan.so.1 (libc6) => /lib/i386-linux-gnu/libvulkan.so.1',
    '\tlibc.so.6 (libc6,x86-64, OS ABI: Linux 3.2.0) => /lib/x86_64-linux-gnu/libc.so.6',
    '\tlibc.so.6 (libc6,x86-64) => /usr/lib/other/libc.so.6',
    '\tlibz.so.1 (libc6,AArch64) => /lib/aarch64-linux-gnu/libz.so.1',
  ].join('\n')
  assert.deepEqual(parseLdconfig(text, 'x86_64'), {
    'libvulkan.so.1': '/lib/x86_64-linux-gnu/libvulkan.so.1',
    'libc.so.6': '/lib/x86_64-linux-gnu/libc.so.6',
  })
  assert.deepEqual(parseLdconfig(text, 'aarch64'), {
    'libz.so.1': '/lib/aarch64-linux-gnu/libz.so.1',
  })
})

test('parseDpkgSearch names the owning package without its architecture', () => {
  assert.equal(
    parseDpkgSearch('libvulkan1:amd64: /lib/x86_64-linux-gnu/libvulkan.so.1\n'),
    'libvulkan1'
  )
  assert.equal(
    parseDpkgSearch('libc6:arm64: /lib/aarch64-linux-gnu/libc.so.6'),
    'libc6'
  )
  assert.equal(
    parseDpkgSearch(
      'diversion by libc6 from: /lib/ld-linux.so.2\nlibc6:i386: /lib/ld-linux.so.2'
    ),
    'libc6'
  )
  assert.throws(
    () => parseDpkgSearch('dpkg-query: no path found matching pattern /x'),
    /no package/
  )
})

test('debDepends pins libc6 to the glibc floor and lists the rest once, sorted', () => {
  assert.deepEqual(
    debDepends(['libvulkan1', 'libc6', 'libstdc++6', 'libvulkan1'], '2.35'),
    ['libc6 (>= 2.35)', 'libstdc++6', 'libvulkan1']
  )
})

test('nfpmConfig installs the tree under /opt, a /usr/bin link, the desktop entry, icons and the license', () => {
  const deps = {
    deb: { depends: ['libc6 (>= 2.35)'], recommends: ['xdg-utils'] },
    rpm: { depends: ['libc.so.6()(64bit)'], recommends: [] },
  }
  const [x64] = PACKAGE_TARGETS
  const deb = nfpmConfig({
    version: '2.3.0',
    target: x64,
    format: 'deb',
    stage: '/st/x86_64',
    deps,
    root: '/repo',
  })
  assert.equal(deb.name, 'atomic-chat')
  assert.equal(deb.arch, 'amd64')
  assert.deepEqual(deb.depends, ['libc6 (>= 2.35)'])
  assert.deepEqual(deb.recommends, ['xdg-utils'])
  assert.deepEqual(deb.contents[0], {
    src: '/st/x86_64/opt/atomic-chat',
    dst: '/opt/atomic-chat',
    type: 'tree',
  })
  assert.deepEqual(deb.contents[1], {
    src: '/opt/atomic-chat/bin/Atomic-Chat',
    dst: '/usr/bin/atomic-chat',
    type: 'symlink',
  })
  const dsts = deb.contents.map((c) => c.dst)
  assert.ok(dsts.includes('/usr/share/applications/chat.atomic.app.desktop'))
  assert.ok(
    dsts.includes('/usr/share/icons/hicolor/256x256/apps/chat.atomic.app.png')
  )
  assert.ok(dsts.includes('/usr/share/licenses/atomic-chat/LICENSE'))
  assert.equal(deb.rpm.signature, undefined)
  assert.deepEqual(deb.scripts, {
    postinstall: '/repo/packaging/postinstall.sh',
  })

  const rpm = nfpmConfig({
    version: '2.3.0',
    target: x64,
    format: 'rpm',
    stage: '/st/x86_64',
    deps,
    root: '/repo',
    rpmSigningKeyFile: '/k.asc',
  })
  assert.equal(rpm.arch, 'x86_64')
  assert.deepEqual(rpm.depends, ['libc.so.6()(64bit)'])
  assert.deepEqual(rpm.rpm.signature, { key_file: '/k.asc' })
})

test('every icon the packages install exists', () => {
  const deps = { deb: { depends: [], recommends: [] } }
  const config = nfpmConfig({
    version: '1.0.0',
    target: PACKAGE_TARGETS[0],
    format: 'deb',
    stage: '/s',
    deps,
    root: '',
  })
  for (const c of config.contents.filter((c) => c.dst.endsWith('.png')))
    assert.ok(read(c.src.replace(/^\//, '')).length > 0, c.src)
})

test('renderPkgbuild fills every placeholder of the template and pins both debs', () => {
  const sums = {
    'atomic-chat_2.3.0-rc.1_amd64.deb': 'a'.repeat(64),
    'atomic-chat_2.3.0-rc.1_arm64.deb': 'b'.repeat(64),
  }
  const out = renderPkgbuild(read('packaging/PKGBUILD.in'), {
    version: '2.3.0-rc.1',
    sums,
    sourceBase: 'https://example.invalid/v2.3.0-rc.1',
  })
  assert.doesNotMatch(out, /@[A-Z0-9_]+@/)
  assert.match(out, /^pkgname=atomic-chat-bin$/m)
  assert.match(out, /^pkgver=2\.3\.0rc\.1$/m)
  assert.match(out, /^_version=2\.3\.0-rc\.1$/m)
  assert.match(out, new RegExp(`sha256sums_x86_64=\\('${'a'.repeat(64)}'\\)`))
  assert.match(out, new RegExp(`sha256sums_aarch64=\\('${'b'.repeat(64)}'\\)`))
  assert.match(out, /options=\('!strip' '!debug'\)/)
  assert.match(
    out,
    new RegExp(`^install=${AUR_INSTALL_FILE.replaceAll('.', '\\.')}$`, 'm')
  )
  assert.ok(read(`packaging/${AUR_INSTALL_FILE}`).includes('post_upgrade()'))
  assert.throws(
    () => renderPkgbuild('@NOPE@', { version: '1.0.0', sums, sourceBase: '' }),
    /no checksum|unknown placeholder/
  )
})

const release = (
  tag,
  { draft = false, prerelease = false, packages = true } = {}
) => ({
  tag_name: tag,
  draft,
  prerelease,
  assets: packages
    ? [
        {
          name: `atomic-chat_${tag.slice(1)}_amd64.deb`,
          digest: `sha256:${'c'.repeat(64)}`,
        },
        { name: 'latest.json' },
      ]
    : [{ name: 'latest.json' }],
})

test('selectReleases keeps the newest published stable releases that carry packages', () => {
  const picked = selectReleases(
    [
      release('v2.2.9'),
      release('v2.2.10'),
      release('v2.3.0', { draft: true }),
      release('v2.2.11-rc.1', { prerelease: true }),
      release('v2.2.8', { packages: false }),
      release('v2.2.7'),
      release('v2.2.6'),
    ],
    3
  )
  assert.deepEqual(
    picked.map((r) => r.tag),
    ['v2.2.10', 'v2.2.9', 'v2.2.7']
  )
})

test("packageDigests reads GitHub's sha256 of each package and refuses one without it", () => {
  assert.deepEqual(packageDigests(release('v2.3.0').assets), {
    'atomic-chat_2.3.0_amd64.deb': 'c'.repeat(64),
  })
  assert.throws(
    () => packageDigests([{ name: 'atomic-chat_2.3.0_arm64.deb' }]),
    /no sha256 digest/
  )
})

test('the repository layout, caching and types', () => {
  assert.equal(
    repoPath('atomic-chat_2.3.0_amd64.deb'),
    'deb/pool/main/a/atomic-chat/atomic-chat_2.3.0_amd64.deb'
  )
  assert.equal(
    repoPath('atomic-chat_2.3.0_x86_64.rpm'),
    'rpm/packages/atomic-chat_2.3.0_x86_64.rpm'
  )
  assert.throws(() => repoPath('latest.json'))
  assert.match(
    cacheControl('rpm/packages/atomic-chat_2.3.0_x86_64.rpm'),
    /immutable/
  )
  assert.equal(cacheControl('deb/dists/stable/InRelease'), 'no-cache')
  assert.equal(contentType('atomic-chat.gpg'), 'application/pgp-keys')
  assert.equal(
    contentType('deb/dists/stable/Release.gpg'),
    'application/pgp-signature'
  )
})

test('the .repo file names its own repository id and checks both signatures', () => {
  const text = renderRepoFile({ baseUrl: 'https://r.invalid' })
  assert.match(text, new RegExp(`^\\[${LOCAL_NAME}\\]$`, 'm'))
  assert.match(text, /^baseurl=https:\/\/r\.invalid\/rpm$/m)
  assert.match(text, /^gpgcheck=1$/m)
  assert.match(text, /^repo_gpgcheck=1$/m)
  assert.match(
    renderRepoFile({ baseUrl: 'https://r.invalid', packageSignatures: false }),
    /^gpgcheck=0$/m
  )
})

test('syncPlan uploads packages before indexes before what points at them, then deletes', () => {
  const plan = syncPlan(
    [
      'rpm/repodata/repomd.xml',
      'deb/dists/stable/main/binary-amd64/Packages',
      'rpm/packages/atomic-chat_2.3.0_x86_64.rpm',
      'rpm/packages/atomic-chat_2.2.0_x86_64.rpm',
    ],
    [
      'rpm/packages/atomic-chat_2.2.0_x86_64.rpm',
      'rpm/packages/atomic-chat_2.1.0_x86_64.rpm',
    ]
  )
  assert.deepEqual(
    plan.map((s) => `${s.op} ${s.path}`),
    [
      'put rpm/packages/atomic-chat_2.3.0_x86_64.rpm',
      'put deb/dists/stable/main/binary-amd64/Packages',
      'put rpm/repodata/repomd.xml',
      'delete rpm/packages/atomic-chat_2.1.0_x86_64.rpm',
    ]
  )
})

test("README.md installs from REPOSITORY with this repository's local names", () => {
  const readme = read('README.md')
  const apt = readmeInstallBlock(readme, 'apt')
  const dnf = readmeInstallBlock(readme, 'dnf')
  for (const block of [apt, dnf])
    assert.ok(block.includes(REPOSITORY.baseUrl), block)
  assert.match(apt, new RegExp(`/usr/share/keyrings/${LOCAL_NAME}\\.gpg`))
  assert.match(apt, new RegExp(`/etc/apt/sources.list.d/${LOCAL_NAME}\\.list`))
  assert.match(apt, /apt install atomic-chat/)
  assert.match(
    dnf,
    new RegExp(
      `/etc/yum.repos.d/${LOCAL_NAME}\\.repo .*/rpm/atomic-chat\\.repo`
    )
  )
  assert.match(dnf, /dnf install atomic-chat/)
})

test('the upgrade notice speaks on an upgrade only, as dpkg and rpm call it', () => {
  const script = new URL('../packaging/postinstall.sh', import.meta.url)
    .pathname
  const say = (...args) =>
    execFileSync('sh', [script, ...args], { encoding: 'utf8' })
  assert.equal(say('configure', ''), '')
  assert.equal(say('1'), '')
  assert.match(say('configure', '2.2.26-1'), /quit it/)
  assert.match(say('2'), /quit it/)
  assert.equal(say('abort-upgrade'), '')
})
