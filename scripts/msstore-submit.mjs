#!/usr/bin/env node
// Submits a published Atomic Chat release to the Microsoft Store. It points
// the Partner Center product's x64 EXE package at the installer that
// msstore.yml uploaded, rewrites the en-US "What's new" from the release
// notes, and creates a submission. It uses the Microsoft Store submission API
// for MSI/EXE apps:
// https://learn.microsoft.com/en-us/windows/apps/publish/store-submission-api
//
// Usage (msstore.yml runs it after the upload):
//   node scripts/msstore-submit.mjs --tag v2.3.7 --package-url <url>
//     [--notes-file notes.md] [--release-url <url>] [--force] [--dry-run]
//
// Credentials come from the environment: MSSTORE_TENANT_ID, MSSTORE_CLIENT_ID
// and MSSTORE_CLIENT_SECRET (an Entra app with the Manager role in Partner
// Center), MSSTORE_SELLER_ID and MSSTORE_PRODUCT_ID. Without them it warns and
// exits 0, so releases keep publishing while the Store is not wired up.
//
// It submits nothing, and exits 0 with a warning, when:
// - another submission is still in certification or publishing. The API
//   cannot cancel it; rerun once it is live, or the next release goes in;
// - the Store already points at this version (--force resubmits it);
// - the Store points at a newer version.
// --dry-run makes only read calls and prints what it would change.
//
// MSSTORE_API_URL and MSSTORE_LOGIN_URL override the endpoints for tests.

import { appendFileSync, readFileSync } from 'node:fs'

const API_URL = process.env.MSSTORE_API_URL || 'https://api.store.microsoft.com'
const LOGIN_URL =
  process.env.MSSTORE_LOGIN_URL || 'https://login.microsoftonline.com'
const SCOPE = 'https://api.store.microsoft.com/.default'
const LANGUAGE = 'en-us'
const WHATS_NEW_LIMIT = 1500
const POLL_MS = Number(process.env.MSSTORE_POLL_SECONDS || 10) * 1000
const READY_TIMEOUT_MS =
  Number(process.env.MSSTORE_READY_TIMEOUT_MINUTES || 20) * 60 * 1000
const PREFIX = 'Microsoft Store'

const inActions = process.env.GITHUB_ACTIONS === 'true'

class StoreError extends Error {}

function escapeCommand(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function report(level, message) {
  const text = `${PREFIX}: ${message}`
  if (inActions) console.log(`::${level}::${escapeCommand(text)}`)
  else console.log(`[${level}] ${text}`)
}

function summary(lines) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) appendFileSync(file, `${lines.join('\n')}\n`)
}

function parseArgs(argv) {
  const args = {
    tag: null,
    packageUrl: null,
    notesFile: null,
    releaseUrl: null,
    force: false,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tag') args.tag = argv[++i]
    else if (arg === '--package-url') args.packageUrl = argv[++i]
    else if (arg === '--notes-file') args.notesFile = argv[++i]
    else if (arg === '--release-url') args.releaseUrl = argv[++i]
    else if (arg === '--force') args.force = true
    else if (arg === '--dry-run') args.dryRun = true
    else throw new StoreError(`unknown argument: ${arg}`)
  }
  if (!parseVersion(args.tag ?? ''))
    throw new StoreError(`--tag must look like v2.3.7, got "${args.tag}"`)
  if (!/^https:\/\//.test(args.packageUrl ?? ''))
    throw new StoreError(`--package-url must be an https URL`)
  return args
}

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text)
  return match ? match.slice(1).map(Number) : null
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

// msstore.yml uploads to msstore/<version>/Atomic.Chat_<version>_x64_msstore.exe.
function versionInUrl(url) {
  const match =
    /\/msstore\/(\d+\.\d+\.\d+)\//.exec(url ?? '') ??
    /_(\d+\.\d+\.\d+)_x64[^/]*$/.exec(url ?? '')
  return match ? parseVersion(match[1]) : null
}

function plainText(markdown) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The release notes (scripts/release-notes/generate.py) are Markdown sections
// of bullets. The Store field is plain text of at most 1500 characters, so it
// gets the bullets of every section but Contributors, cut at a whole bullet.
function whatsNewFrom(markdown, releaseUrl) {
  const items = []
  let skip = false
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      skip = /contributor/i.test(heading[1])
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (!skip && bullet) {
      const text = plainText(bullet[1])
      if (text) items.push(`• ${text}`)
    }
  }
  const more = releaseUrl ? `Full release notes: ${releaseUrl}` : ''
  if (items.length === 0)
    return ['Stability fixes and improvements.', more]
      .filter(Boolean)
      .join('\n')
  const kept = []
  let length = 0
  for (const item of items) {
    const added = (kept.length ? 1 : 0) + item.length
    const reserve = kept.length + 1 < items.length && more ? more.length + 1 : 0
    if (length + added + reserve > WHATS_NEW_LIMIT) break
    kept.push(item)
    length += added
  }
  if (kept.length === 0)
    kept.push(`${items[0].slice(0, WHATS_NEW_LIMIT - more.length - 2)}…`)
  if (kept.length < items.length && more) kept.push(more)
  return kept.join('\n')
}

function readCredentials() {
  const names = {
    tenantId: 'MSSTORE_TENANT_ID',
    clientId: 'MSSTORE_CLIENT_ID',
    clientSecret: 'MSSTORE_CLIENT_SECRET',
    sellerId: 'MSSTORE_SELLER_ID',
    productId: 'MSSTORE_PRODUCT_ID',
  }
  const creds = {}
  const missing = []
  for (const [key, name] of Object.entries(names)) {
    creds[key] = process.env[name]?.trim()
    if (!creds[key]) missing.push(name)
  }
  return { creds, missing }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class StoreClient {
  constructor(creds) {
    this.creds = creds
    this.token = null
  }

  async authenticate() {
    const { tenantId, clientId, clientSecret } = this.creds
    const res = await fetch(`${LOGIN_URL}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: SCOPE,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.access_token) {
      throw new StoreError(
        `could not get an API token (HTTP ${res.status}): ${json.error_description ?? json.error ?? 'no access_token'}`
      )
    }
    this.token = json.access_token
  }

  // Returns the envelope { isSuccess, errors, responseData }; throws when the
  // call failed, unless `allowFailure` asks for the envelope anyway.
  async call(method, path, body, { allowFailure = false } = {}) {
    if (!this.token) await this.authenticate()
    const url = `${API_URL}/submission/v1/product/${this.creds.productId}${path}`
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'X-Seller-Account-Id': this.creds.sellerId,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (res.status === 401 && attempt === 1) {
        await this.authenticate()
        continue
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep((retryAfter > 0 ? retryAfter : attempt * 5) * 1000)
        continue
      }
      const text = await res.text()
      let envelope = null
      try {
        envelope = JSON.parse(text)
      } catch {
        // not JSON: reported below
      }
      const ok = res.ok && envelope && envelope.isSuccess !== false
      if (ok || (allowFailure && envelope)) {
        return {
          ok,
          errors: envelope.errors ?? [],
          data: envelope.responseData ?? {},
        }
      }
      const detail = envelope ? describeErrors(envelope.errors) : text.trim()
      const correlation = res.headers.get('x-correlation-id')
      throw new StoreError(
        `${method} ${path} failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 500)}` : ''}${correlation ? ` [correlation ${correlation}]` : ''}`
      )
    }
  }

  // Package and listing updates are processed asynchronously; /status says
  // when every module, the package upload included, is ready to submit.
  async waitUntilReady(stage) {
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      const { data, errors } = await this.call('GET', '/status')
      const uploadError = errors.find(
        (e) => String(e.code).toLowerCase() === 'packageuploaderror'
      )
      if (uploadError) {
        throw new StoreError(
          `the Store could not take the package (${stage}): ${describeErrors([uploadError])}`
        )
      }
      if (data.isReady) return data
      if (Date.now() > deadline) {
        throw new StoreError(
          `the Store draft did not become ready within ${Math.max(1, Math.round(READY_TIMEOUT_MS / 60000))} min (${stage})${errors.length ? `: ${describeErrors(errors)}` : ''}`
        )
      }
      await sleep(POLL_MS)
    }
  }
}

function describeErrors(errors) {
  return (errors ?? [])
    .map((e) =>
      [e.code, e.message, e.target ? `(${e.target})` : '']
        .filter(Boolean)
        .join(' ')
    )
    .join('; ')
}

function isX64(pkg) {
  return (pkg.architectures ?? []).some(
    (a) => String(a).toLowerCase() === 'x64'
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.tag.replace(/^v/, '')
  const target = parseVersion(version)

  const { creds, missing } = readCredentials()
  if (missing.length > 0) {
    report(
      'warning',
      `${args.tag} was not submitted: ${missing.join(', ')} not set (the packages environment holds them).`
    )
    summary([
      `### Microsoft Store: not configured`,
      '',
      `Missing: ${missing.join(', ')}.`,
    ])
    return
  }
  const store = new StoreClient(creds)

  const status = (await store.call('GET', '/status')).data
  if (status.ongoingSubmissionId) {
    report(
      'warning',
      `submission ${status.ongoingSubmissionId} is still in certification or publishing, so ${args.tag} was not submitted. Once Partner Center shows it in the Store, rerun: make release-prod ${version} (or the next release goes in).`
    )
    summary([
      `### Microsoft Store: busy`,
      '',
      `Submission ${status.ongoingSubmissionId} is in progress; ${args.tag} was not submitted.`,
    ])
    return
  }

  const packages = (await store.call('GET', '/packages')).data.packages ?? []
  const x64 = packages.filter(isX64)
  if (x64.length !== 1) {
    throw new StoreError(
      `expected one x64 package in the Store draft, found ${x64.length}; fix the packages in Partner Center`
    )
  }
  const current = x64[0]
  const currentVersion = versionInUrl(current.packageUrl)
  if (current.packageUrl === args.packageUrl && !args.force) {
    report(
      'notice',
      `the Store already points at ${args.tag}; nothing to submit (rerun msstore.yml with force to resubmit it).`
    )
    summary([`### Microsoft Store: ${args.tag} is already there`])
    return
  }
  if (currentVersion && compareVersions(currentVersion, target) > 0) {
    report(
      'warning',
      `the Store points at ${currentVersion.join('.')}, newer than ${args.tag}; not submitting an older version.`
    )
    summary([`### Microsoft Store: has ${currentVersion.join('.')}, newer`])
    return
  }

  // PUT replaces the whole package set, as msstore-cli does; package ids are
  // regenerated, so they are not sent.
  const nextPackages = packages.map((pkg) => {
    const rest = Object.fromEntries(
      Object.entries(pkg).filter(([key]) => key !== 'packageId')
    )
    return pkg === current ? { ...rest, packageUrl: args.packageUrl } : rest
  })

  const listings =
    (
      await store.call(
        'GET',
        `/metadata/listings?languages=${LANGUAGE}&includelanguagelist=false`
      )
    ).data.listings ?? []
  const listing = listings.find(
    (l) => String(l.language).toLowerCase() === LANGUAGE
  )
  let whatsNew = null
  if (!args.notesFile) {
    report('notice', `no release notes given; "What's new" stays as it is.`)
  } else if (!listing) {
    report(
      'warning',
      `the draft has no ${LANGUAGE} listing; "What's new" stays as it is.`
    )
  } else {
    whatsNew = whatsNewFrom(
      readFileSync(args.notesFile, 'utf8'),
      args.releaseUrl
    )
  }
  const updateListing = whatsNew !== null && whatsNew !== listing.whatsNew

  console.log(`Store package: ${current.packageUrl}`)
  console.log(`         -> ${args.packageUrl}`)
  if (updateListing)
    console.log(`What's new (${whatsNew.length} chars):\n${whatsNew}`)

  if (args.dryRun) {
    report(
      'notice',
      `dry run: would point the x64 package at ${args.packageUrl}${updateListing ? `, rewrite "What's new"` : ''} and submit ${args.tag}. Draft ready: ${status.isReady}.`
    )
    summary([
      `### Microsoft Store: dry run for ${args.tag}`,
      '',
      `- package: ${current.packageUrl} → ${args.packageUrl}`,
      `- What's new: ${updateListing ? 'rewritten' : 'unchanged'}`,
    ])
    return
  }

  await store.waitUntilReady('before the package update')
  await store.call('PUT', '/packages', { packages: nextPackages })
  // From here on the draft points at the new version, so a plain rerun would
  // find it "already there": every failure says how to push it through.
  let submit
  try {
    await store.call('POST', '/packages/commit')
    await store.waitUntilReady('after the package update')

    if (updateListing) {
      // The documented full-module update: the listing as read, one field changed.
      await store.call('PUT', '/metadata', {
        listings: { ...listing, whatsNew },
      })
      await store.waitUntilReady(`after the "What's new" update`)
    }

    submit = await store.call('POST', '/submit', undefined, {
      allowFailure: true,
    })
    if (!submit.ok || !submit.data.submissionId) {
      const other = submit.data.ongoingSubmissionId
      throw new StoreError(
        `the submission failed${other ? ` (submission ${other} is in progress)` : ''}: ${describeErrors(submit.errors) || 'no submission id'}.`
      )
    }
  } catch (error) {
    if (error instanceof StoreError) {
      error.message = `${error.message.replace(/\.?$/, '.')} The draft already points at ${args.tag}; once that is fixed, retry: gh workflow run msstore.yml --ref ${args.tag} -f force=true`
    }
    throw error
  }
  const submissionId = submit.data.submissionId
  const publishing = (
    await store.call('GET', `/submission/${submissionId}/status`)
  ).data
  report(
    'notice',
    `submitted ${args.tag} (submission ${submissionId}, ${publishing.publishingStatus ?? 'status unknown'}). Certification can take a few days; Partner Center shows the result.`
  )
  summary([
    `### Microsoft Store: submitted ${args.tag}`,
    '',
    `- submission: ${submissionId} (${publishing.publishingStatus ?? 'unknown'})`,
    `- package URL: ${args.packageUrl}`,
    `- What's new: ${updateListing ? 'rewritten from the release notes' : 'unchanged'}`,
  ])
}

try {
  await main()
} catch (error) {
  if (!(error instanceof StoreError)) throw error
  report('error', error.message)
  process.exit(1)
}
