---
date: 2026-11-06
title: 'Submit every published release to the Microsoft Store'
---

# 2026-11-06 — Submit every published release to the Microsoft Store

- **Context:** `make release-prod` published the release, and `msstore.yml` copied the Store installer to
  the `atomic-chat-downloads` bucket. A person then had to open Partner Center, paste the new package URL,
  rewrite "What's new" and resubmit, so the Store fell behind the releases. Partner Center has a REST API
  for "EXE or MSI apps" (the Microsoft Store submission API). It can replace the package set, update the
  listing and create a submission. It cannot cancel a submission, and it refuses a new one while another
  is in certification or publishing. Certification can take more than a day, and we release more often
  than that.
- **Decision:**
  - `msstore.yml` gets a `submit` job after `upload`. It runs `scripts/msstore-submit.mjs`, which:
    - points the product's x64 EXE package at the uploaded URL (GET then PUT of the whole package set,
      like msstore-cli);
    - rewrites the en-US "What's new" from the release notes (all bullets but Contributors, plain text, at
      most 1500 characters, cut at a whole bullet with a link to the notes). It sends the listing it read
      back with that one field changed, the documented full-module update;
    - waits until `/status` reports the draft ready, then submits. It does not wait for certification.
  - It changes nothing, and exits 0 with a warning, when another submission is in progress, the Store
    already points at this version (the `force` input resubmits it), the Store has a newer version, or the
    credentials are missing.
  - `make release-prod` follows that run (`gh run watch`) and repeats its Store messages. On a release that
    is already latest it starts `msstore.yml` again, so `make release-prod X.Y.Z` is also the retry once an
    earlier submission is live.
  - Credentials: an Entra app with the Manager role in Partner Center. `MSSTORE_TENANT_ID`,
    `MSSTORE_CLIENT_ID`, `MSSTORE_CLIENT_SECRET` and `MSSTORE_SELLER_ID` are secrets in the `packages`
    environment; the product id is in the workflow. Setting the repository variable `MSSTORE_SUBMIT` to
    `off` keeps the upload and skips the Store.
- **Consequences:**
  - Every published release goes to the Store unless a submission is already in progress. In that case
    the next release, or `make release-prod X.Y.Z` again, takes the newest version, so the Store can skip
    versions.
  - The job submits whatever else is in the Partner Center draft. Finish or discard hand edits there
    before publishing a release.
  - The first run with real credentials should be a dry run (`-f store=dry-run`). The listing's
    response shape and how long package processing takes were checked only against a mock of the
    documented API.
  - If a step fails after the package update, the draft already points at the new version, so a plain
    rerun says "already there". The error names the retry: `-f force=true`.
  - Tags created before this change carry an `msstore.yml` without the `submit` job. Their publish only
    uploads.
- **Owner:** team.
- **Links:** `.github/workflows/msstore.yml`, `scripts/msstore-submit.mjs`, `scripts/release-prod.mjs`,
  `docs/decisions/2026-10-29-host-the-microsoft-store-installer-in-its-own-bucket.md`,
  [Microsoft Store submission API for MSI or EXE app](https://learn.microsoft.com/en-us/windows/apps/publish/store-submission-api).
