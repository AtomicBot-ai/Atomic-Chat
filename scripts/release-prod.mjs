#!/usr/bin/env node
// Publishes the newest draft (or pre-release) of Atomic Chat as the latest
// release, then points the landing page's download manifest
// (atomic-chat-conf app/latest.json) at that release's installers, then
// follows msstore.yml, which the publish starts: it uploads the Microsoft
// Store installer and submits it to the Store.
//
// Usage:
//   node scripts/release-prod.mjs [--tag 2.1.3] [--yes] [--dry-run]
//   make release-prod 2.1.3 [DRY_RUN=1]
//
// Without --tag it picks the newest draft. The tag may omit the leading "v".
// --tag on a release that is already published and latest skips publishing,
// rewrites the manifest and starts msstore.yml again: the recovery path when
// the manifest commit or the Store submission failed after the publish went
// through, or when an earlier Store submission was still in certification.
// --dry-run prints the manifest it would write and changes nothing.

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

const APP_REPO = 'AtomicBot-ai/Atomic-Chat'
const CONF_REPO = 'AtomicBot-ai/atomic-chat-conf'
const MANIFEST_PATH = 'app/latest.json'
const MANIFEST_RAW_URL = `https://raw.githubusercontent.com/${CONF_REPO}/main/${MANIFEST_PATH}`
const STORE_WORKFLOW = 'msstore.yml'

// The installers the landing page links to. A release missing any of them is
// not published: the page would keep pointing that platform at an old build.
const INSTALLERS = {
  macos: /^Atomic\.Chat_\d+\.\d+\.\d+_universal\.dmg$/,
  windows: /^Atomic\.Chat_\d+\.\d+\.\d+_x64-setup\.exe$/,
  linux: /^Atomic\.Chat_\d+\.\d+\.\d+_amd64\.AppImage$/,
}
// Uploaded by the release workflow's last job; a draft without it is still building.
const UPDATER_MANIFEST = 'latest.json'

function parseArgs(argv) {
  const args = { tag: null, yes: false, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tag') args.tag = argv[++i] ?? ''
    else if (arg === '--yes') args.yes = true
    else if (arg === '--dry-run') args.dryRun = true
    else fail(`Unknown argument: ${arg}`)
  }
  if (args.tag !== null) {
    const tag = args.tag.replace(/^(?=\d)/, 'v')
    if (!parseVersion(tag))
      fail(`the version must look like 2.1.3, got "${args.tag}"`)
    args.tag = tag
  }
  return args
}

function fail(message) {
  console.error(`Error: ${message}`)
  process.exit(1)
}

function gh(args, input) {
  const result = spawnSync('gh', args, { encoding: 'utf8', input })
  if (result.error) fail(`could not run gh: ${result.error.message}`)
  return {
    ok: result.status === 0,
    stdout: result.stdout,
    stderr: result.stderr.trim(),
  }
}

function ghJson(args) {
  const result = gh(args)
  if (!result.ok)
    fail(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseVersion(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag ?? '')
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

function listReleases() {
  return ghJson([
    'release',
    'list',
    '--repo',
    APP_REPO,
    '--limit',
    '100',
    '--json',
    'tagName,isDraft,isPrerelease,isLatest',
  ]).filter((release) => parseVersion(release.tagName))
}

function viewRelease(tag) {
  return ghJson([
    'release',
    'view',
    tag,
    '--repo',
    APP_REPO,
    '--json',
    'tagName,isDraft,isPrerelease,url,assets',
  ])
}

function pickRelease(releases, tag, latest) {
  const floor = latest ? parseVersion(latest.tagName) : [0, 0, 0]
  if (tag) {
    const release = releases.find((r) => r.tagName === tag)
    if (!release) fail(`${tag} is not a release of ${APP_REPO}`)
    const unpublished = release.isDraft || release.isPrerelease
    if (!unpublished && !release.isLatest) {
      fail(
        `${tag} is published but ${latest?.tagName} is the latest release; refusing to point the landing page back at it`
      )
    }
    if (unpublished && compareVersions(parseVersion(tag), floor) <= 0) {
      fail(`${tag} is not newer than the latest release ${latest.tagName}`)
    }
    return release
  }
  const candidates = releases
    .filter(
      (r) =>
        (r.isDraft || r.isPrerelease) &&
        compareVersions(parseVersion(r.tagName), floor) > 0
    )
    .sort((a, b) =>
      compareVersions(parseVersion(b.tagName), parseVersion(a.tagName))
    )
  if (candidates.length === 0) {
    fail(
      `no draft or pre-release newer than the latest release ${latest?.tagName ?? '(none)'}`
    )
  }
  return candidates[0]
}

function findInstallers(release) {
  const uploaded = release.assets.filter((asset) => asset.state === 'uploaded')
  const downloads = {}
  const missing = []
  for (const [platform, pattern] of Object.entries(INSTALLERS)) {
    const asset = uploaded.find((a) => pattern.test(a.name))
    if (asset) downloads[platform] = asset.url
    else missing.push(platform)
  }
  if (!uploaded.some((a) => a.name === UPDATER_MANIFEST))
    missing.push(UPDATER_MANIFEST)
  return { downloads, missing }
}

function buildManifest(release, downloads) {
  for (const url of Object.values(downloads)) {
    if (!url.includes(`/releases/download/${release.tagName}/`)) {
      fail(
        `asset URL is not under the published tag ${release.tagName}: ${url}`
      )
    }
  }
  return {
    $schema: './schema.json',
    schema_version: 1,
    updated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    version: release.tagName.slice(1),
    tag: release.tagName,
    release_url: release.url,
    downloads,
  }
}

async function confirm(question) {
  if (!process.stdin.isTTY)
    fail('not a terminal; pass --yes to publish without a prompt')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return answer.trim().toLowerCase() === 'y'
}

function writeManifest(manifest) {
  const existing = gh([
    'api',
    `repos/${CONF_REPO}/contents/${MANIFEST_PATH}`,
    '--jq',
    '.sha',
  ])
  if (!existing.ok && !existing.stderr.includes('404'))
    fail(`could not read ${MANIFEST_PATH}: ${existing.stderr}`)
  const body = {
    message: `chore(app): point the landing downloads at ${manifest.tag}`,
    content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString(
      'base64'
    ),
    branch: 'main',
    ...(existing.ok ? { sha: existing.stdout.trim() } : {}),
  }
  const result = gh(
    [
      'api',
      '-X',
      'PUT',
      `repos/${CONF_REPO}/contents/${MANIFEST_PATH}`,
      '--input',
      '-',
    ],
    JSON.stringify(body)
  )
  if (!result.ok) {
    fail(
      `the release is published but ${MANIFEST_PATH} was not updated: ${result.stderr}\n` +
        `Retry with: make release-prod ${manifest.version}`
    )
  }
}

function listStoreRuns(tag, event) {
  return ghJson([
    'run',
    'list',
    '--repo',
    APP_REPO,
    '--workflow',
    STORE_WORKFLOW,
    '--event',
    event,
    '--limit',
    '20',
    '--json',
    'databaseId,headBranch,createdAt,url',
  ]).filter((run) => run.headBranch === tag)
}

// The publish event starts the run within seconds; a dispatch may not print
// the run's URL. Either way it shows up in the run list.
async function waitForStoreRun(tag, event, since) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const run = listStoreRuns(tag, event).find(
      (r) => Date.parse(r.createdAt) >= since - 60_000
    )
    if (run) return run
    await sleep(5000)
  }
  return null
}

async function startStoreRun(tag) {
  const since = Date.now()
  const result = gh([
    'workflow',
    'run',
    STORE_WORKFLOW,
    '--repo',
    APP_REPO,
    '--ref',
    tag,
    '-f',
    `tag=${tag}`,
  ])
  if (!result.ok) {
    console.error(`Could not start ${STORE_WORKFLOW}: ${result.stderr}`)
    return null
  }
  const url = /https:\/\/\S+\/actions\/runs\/(\d+)/.exec(
    `${result.stdout}\n${result.stderr}`
  )
  if (url) return { databaseId: Number(url[1]), url: url[0] }
  return waitForStoreRun(tag, 'workflow_dispatch', since)
}

// GitHub adds notices of its own (runner images, deprecated actions); only
// failures and the submit script's "Microsoft Store: ..." lines are repeated.
const STORE_PREFIX = 'Microsoft Store:'

function printStoreRunResult(runId) {
  const view = ghJson([
    'run',
    'view',
    String(runId),
    '--repo',
    APP_REPO,
    '--json',
    'conclusion,jobs',
  ])
  const jobs = Object.fromEntries(view.jobs.map((job) => [job.name, job]))
  for (const job of view.jobs) {
    const annotations = gh([
      'api',
      `repos/${APP_REPO}/check-runs/${job.databaseId}/annotations`,
      '--jq',
      '.[] | select(.annotation_level != null) | "\\(.annotation_level)\\t\\(.message)"',
    ])
    if (!annotations.ok) continue
    for (const line of annotations.stdout.split('\n').filter(Boolean)) {
      const [level, ...rest] = line.split('\t')
      const message = rest.join('\t')
      if (level !== 'failure' && !message.startsWith(STORE_PREFIX)) continue
      console.log(`  ${job.name} ${level}: ${message}`)
    }
  }
  if (!jobs.submit) {
    console.log(
      "  This tag's msstore.yml has no Store submission yet; submit it in Partner Center by hand."
    )
  } else if (jobs.submit.conclusion === 'skipped') {
    console.log(
      '  The Store submission was skipped (repository variable MSSTORE_SUBMIT is "off", or the upload did not happen).'
    )
  }
  return view.conclusion === 'success'
}

async function followStoreRun(tag, { started, publishedAt }) {
  const run = started
    ? await startStoreRun(tag)
    : await waitForStoreRun(tag, 'release', publishedAt)
  if (!run) {
    fail(
      `the release is live, but no ${STORE_WORKFLOW} run for ${tag} showed up; start it by hand: ` +
        `gh workflow run ${STORE_WORKFLOW} --repo ${APP_REPO} --ref ${tag}`
    )
  }
  console.log(
    `\nMicrosoft Store: following ${STORE_WORKFLOW} (upload, then submission): ${run.url}`
  )
  console.log('Ctrl+C stops watching here; the run goes on.')
  spawnSync(
    'gh',
    [
      'run',
      'watch',
      String(run.databaseId),
      '--repo',
      APP_REPO,
      '--interval',
      '10',
    ],
    { stdio: 'inherit' }
  )
  console.log(`\nMicrosoft Store run ${run.url}:`)
  if (!printStoreRunResult(run.databaseId)) {
    fail(
      `the release is live and the landing page updated; only the Microsoft Store run failed ` +
        `(${run.url}). Its error above says how to retry.`
    )
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const releases = listReleases()
  const latest = releases.find((r) => r.isLatest)
  const picked = pickRelease(releases, args.tag, latest)
  const needsPublish = picked.isDraft || picked.isPrerelease

  let release = viewRelease(picked.tagName)
  let storeRun = { started: true }
  const { downloads, missing } = findInstallers(release)
  if (missing.length > 0) {
    fail(
      `${picked.tagName} is missing ${missing.join(', ')}; is its release build still running or did a platform fail?`
    )
  }

  if (needsPublish) {
    const kind = picked.isDraft ? 'draft' : 'pre-release'
    console.log(`Latest release: ${latest?.tagName ?? '(none)'}`)
    console.log(`To publish:     ${picked.tagName} (${kind})`)
    for (const name of Object.keys(downloads))
      console.log(
        `  ${name}: ${release.assets.find((a) => a.url === downloads[name]).name}`
      )
    if (args.dryRun) {
      console.log(
        `\nDry run: would publish ${picked.tagName}, write ${MANIFEST_PATH} from its published asset URLs ` +
          `and follow ${STORE_WORKFLOW} (Microsoft Store upload and submission).`
      )
      return
    }
    if (
      !args.yes &&
      !(await confirm(
        `Publish ${picked.tagName} as the latest release for every user and the landing page?`
      ))
    ) {
      fail('aborted')
    }
    const publishedAt = Date.now()
    const published = gh([
      'release',
      'edit',
      picked.tagName,
      '--repo',
      APP_REPO,
      '--draft=false',
      '--prerelease=false',
      '--latest',
    ])
    if (!published.ok)
      fail(`could not publish ${picked.tagName}: ${published.stderr}`)
    console.log(`Published ${picked.tagName}.`)
    release = viewRelease(picked.tagName)
    storeRun = { started: false, publishedAt }
  } else {
    console.log(
      `${picked.tagName} is already the latest release; rewriting ${MANIFEST_PATH} and starting ${STORE_WORKFLOW} again.`
    )
  }

  const manifest = buildManifest(release, findInstallers(release).downloads)
  if (args.dryRun) {
    console.log(JSON.stringify(manifest, null, 2))
    console.log(
      `\nDry run: would start ${STORE_WORKFLOW} on ${picked.tagName} again (Microsoft Store upload and submission).`
    )
    return
  }
  writeManifest(manifest)
  console.log(`Updated ${CONF_REPO}/${MANIFEST_PATH} -> ${manifest.tag}.`)
  console.log(
    `The landing page picks it up within ~5 minutes (raw.githubusercontent.com cache): ${MANIFEST_RAW_URL}`
  )
  await followStoreRun(picked.tagName, storeRun)
}

await main()
