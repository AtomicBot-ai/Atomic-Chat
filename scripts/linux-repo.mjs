#!/usr/bin/env node
// The apt and dnf repository (REPOSITORY in linux-packaging.mjs: a public Hetzner Object Storage bucket).
// GitHub Releases are the source of truth: the repository is rebuilt from scratch out of the newest
// releases' packages on every release, signed, and mirrored to the bucket, so a failed or repeated run
// never leaves state to repair. The pure parts (which releases, layout, upload order) are in
// linux-packaging.mjs. Ported from AtomicBot-ai/eye-cli, which runs the `atc` repository the same way.
//
//   node scripts/linux-repo.mjs fetch --out dl [--keep 3]                     # packages of the window, checked
//   node scripts/linux-repo.mjs build --assets dl --key FPR --out site [--base-url URL]
//                                     [--publish-keys FPR,FPR] [--unsigned-packages]
//   node scripts/linux-repo.mjs sync --site site [--bucket NAME --endpoint URL --region R] [--dry-run]
//   node scripts/linux-repo.mjs readme --block apt|dnf [--base-url URL]       # the README's commands
//
// `fetch` needs `gh` (GH_TOKEN) and checks each package against the sha256 GitHub lists for it; `build`
// needs dpkg-scanpackages, apt-ftparchive, createrepo_c and gpg (the key's passphrase, if any, in
// LINUX_PACKAGES_GPG_PASSPHRASE); `sync` needs the aws CLI with the bucket's credentials in
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  contentType,
  PACKAGE_FILE,
  PACKAGE_TARGETS,
  packageDigests,
  readmeInstallBlock,
  REPOSITORY,
  REPOSITORY_KEEP,
  renderRepoFile,
  repoPath,
  selectReleases,
  syncPlan,
} from './linux-packaging.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPO = 'AtomicBot-ai/Atomic-Chat'
const BASE_URL = REPOSITORY.baseUrl

function fail(message) {
  console.error(`linux-repo: ${message}`)
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

/** Every file under `dir`, as forward-slash paths relative to it. */
function walk(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => statSync(join(dir, p)).isFile())
    .map((p) => p.split(sep).join('/'))
}

/** In chunks: a package is a few hundred MB. */
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

function fetchReleases() {
  const out = resolve(option('out', 'dl'))
  const keep = Number(option('keep', String(REPOSITORY_KEEP)))
  const pages = JSON.parse(
    run('gh', [
      'api',
      '--paginate',
      '--slurp',
      `repos/${REPO}/releases?per_page=100`,
    ])
  )
  const window = selectReleases(pages.flat(), keep)
  if (window.length === 0) fail('no published stable release carries packages')
  rmSync(out, { recursive: true, force: true })
  for (const { tag, assets } of window) {
    let digests
    try {
      digests = packageDigests(assets)
    } catch (error) {
      fail(`${tag}: ${error.message}`)
    }
    const dir = join(out, tag)
    run('gh', [
      'release',
      'download',
      tag,
      '--repo',
      REPO,
      '--dir',
      dir,
      '-p',
      'atomic-chat_*.deb',
      '-p',
      'atomic-chat_*.rpm',
    ])
    for (const file of readdirSync(dir).filter((f) => PACKAGE_FILE.test(f))) {
      if (digests[file] !== sha256(join(dir, file)))
        fail(`${tag}/${file} does not match the sha256 GitHub lists for it`)
    }
    console.log(`${tag}: ${readdirSync(dir).join(', ')}`)
  }
}

function gpg(args, input) {
  const pass = process.env.LINUX_PACKAGES_GPG_PASSPHRASE
  const prefix = ['--batch', '--yes', '--pinentry-mode', 'loopback']
  return run(
    'gpg',
    [...prefix, ...(pass ? ['--passphrase-fd', '0'] : []), ...args],
    {
      input: pass ? `${pass}\n${input ?? ''}` : input,
    }
  )
}

function buildDeb(site, sign) {
  const deb = join(site, 'deb')
  const dist = join(deb, 'dists/stable')
  const arches = PACKAGE_TARGETS.map((t) => t.deb)
  for (const arch of arches) {
    const index = run(
      'dpkg-scanpackages',
      ['--multiversion', '--arch', arch, 'pool'],
      { cwd: deb }
    )
    const dir = join(dist, `main/binary-${arch}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Packages'), index)
    writeFileSync(join(dir, 'Packages.gz'), gzipSync(index, { level: 9 }))
  }
  const release = run(
    'apt-ftparchive',
    [
      ...['-o', 'APT::FTPArchive::Release::Origin=Atomic Chat'],
      ...['-o', 'APT::FTPArchive::Release::Label=Atomic Chat'],
      ...['-o', 'APT::FTPArchive::Release::Suite=stable'],
      ...['-o', 'APT::FTPArchive::Release::Codename=stable'],
      ...['-o', `APT::FTPArchive::Release::Architectures=${arches.join(' ')}`],
      ...['-o', 'APT::FTPArchive::Release::Components=main'],
      'release',
      'dists/stable',
    ],
    { cwd: deb }
  )
  writeFileSync(join(dist, 'Release'), release)
  sign([
    '--clearsign',
    '--output',
    join(dist, 'InRelease'),
    join(dist, 'Release'),
  ])
  sign([
    '--armor',
    '--detach-sign',
    '--output',
    join(dist, 'Release.gpg'),
    join(dist, 'Release'),
  ])
}

function buildRpm(site, sign, { baseUrl, packageSignatures }) {
  const rpm = join(site, 'rpm')
  // gzip metadata: RHEL 8's dnf cannot read the zstd that newer createrepo_c defaults to. The metadata
  // files keep their checksum in the name, so new ones never overwrite what the old repomd.xml lists.
  run('createrepo_c', ['--general-compress-type=gz', rpm])
  sign([
    '--armor',
    '--detach-sign',
    '--output',
    join(rpm, 'repodata/repomd.xml.asc'),
    join(rpm, 'repodata/repomd.xml'),
  ])
  writeFileSync(
    join(rpm, 'atomic-chat.repo'),
    renderRepoFile({ baseUrl, packageSignatures })
  )
}

function build() {
  const assets = resolve(option('assets', 'dl'))
  const site = resolve(option('out', 'site'))
  const key = option('key')
  if (!key) fail('build needs --key <fingerprint of the signing key>')
  const baseUrl = option('base-url', BASE_URL).replace(/\/$/, '')
  const publishKeys = option('publish-keys', key).split(',')
  const packageSignatures = !process.argv.includes('--unsigned-packages')

  rmSync(site, { recursive: true, force: true })
  const files = walk(assets).filter((p) =>
    PACKAGE_FILE.test(p.split('/').pop())
  )
  if (
    !files.some((f) => f.endsWith('.deb')) ||
    !files.some((f) => f.endsWith('.rpm'))
  )
    fail(`${assets} has no deb or no rpm packages`)
  const seen = new Set()
  for (const file of files) {
    const name = file.split('/').pop()
    if (seen.has(name)) fail(`${name} appears twice under ${assets}`)
    seen.add(name)
    const target = join(site, repoPath(name))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(assets, file), target)
  }
  const sign = (args) => gpg(['--local-user', key, ...args])
  buildDeb(site, sign)
  buildRpm(site, sign, { baseUrl, packageSignatures })
  writeFileSync(
    join(site, 'atomic-chat.asc'),
    run('gpg', ['--armor', '--export', ...publishKeys])
  )
  const binary = spawnSync('gpg', ['--export', ...publishKeys])
  if (binary.status !== 0 || binary.stdout.length === 0)
    fail(`gpg could not export ${publishKeys.join(', ')}`)
  writeFileSync(join(site, 'atomic-chat.gpg'), binary.stdout)
  console.log(`built ${site}: ${seen.size} packages, signed by ${key}`)
}

function sync() {
  const site = resolve(option('site', 'site'))
  const bucket = option('bucket', REPOSITORY.bucket)
  const endpoint = option('endpoint', REPOSITORY.endpoint)
  // Newer aws CLIs add checksums by default that not every S3-compatible store accepts; only send what
  // is required.
  const env = {
    ...process.env,
    AWS_DEFAULT_REGION: option('region', REPOSITORY.region),
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
    AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required',
  }
  const aws = (args) =>
    run('aws', [...args, '--endpoint-url', endpoint], { env })
  const listing = JSON.parse(
    aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--output', 'json']) ||
      '{}'
  )
  const remote = (listing.Contents ?? []).map((o) => o.Key)
  const plan = syncPlan(walk(site), remote)
  for (const step of plan) {
    console.log(`${step.op} ${step.path}`)
    if (process.argv.includes('--dry-run')) continue
    if (step.op === 'delete')
      aws(['s3', 'rm', `s3://${bucket}/${step.path}`, '--only-show-errors'])
    // Each object is public-read: the bucket itself stays private (no listing, no anonymous writes), and
    // the repository needs no setting outside this script.
    else
      aws([
        ...[
          's3',
          'cp',
          join(site, step.path),
          `s3://${bucket}/${step.path}`,
          '--only-show-errors',
        ],
        ...['--acl', 'public-read'],
        ...[
          '--cache-control',
          step.cacheControl,
          '--content-type',
          contentType(step.path),
        ],
      ])
  }
  console.log(
    `synced ${relative(process.cwd(), site) || '.'} to ${bucket}: ${plan.length} steps`
  )
}

function readme() {
  const block = option('block')
  const text = readmeInstallBlock(
    readFileSync(join(ROOT, 'README.md'), 'utf8'),
    block
  )
  process.stdout.write(
    text.replaceAll(BASE_URL, option('base-url', BASE_URL).replace(/\/$/, ''))
  )
}

const command = process.argv[2]
if (command === 'fetch') fetchReleases()
else if (command === 'build') build()
else if (command === 'sync') sync()
else if (command === 'readme') readme()
else
  fail(
    'usage: linux-repo.mjs fetch|build|sync|readme [options]; see the header of this file'
  )
