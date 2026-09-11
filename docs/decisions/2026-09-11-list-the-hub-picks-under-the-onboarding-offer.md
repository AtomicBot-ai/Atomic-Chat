---
date: 2026-09-11
title: 'List the Hub picks under the onboarding offer'
---

# 2026-09-11 — List the Hub picks under the onboarding offer

- **Context:** since d29b99b85 the model step painted exactly one model — the
  rung of the hardware ladder this machine sits on — and nothing else to
  download. The reasoning was sound: the manifest had served two models per
  tier plus whatever the scanners found, and shipped launches showed 6, 10 and
  11 rows, a comparison table where a first screen should say "start
  chatting". But the single card overshot. A user who did not want *that*
  model had Skip, an empty chat, and the Hub to find on their own; the Hub's
  curated list — the one place that already answers "what else is there" —
  was a screen away from the screen that needed it. Two cosmetic debts sat on
  the same screen: the Gemma rows wore Google's 2015 flat four-colour "G"
  (Google replaced it with a gradient in May 2025), and the "Connect ChatGPT"
  button carried no mark although the comment beside it said it did.

- **Decision:** the model step keeps its single **offer** — same recommender,
  same "why this one" line — and lists, under it, every one of the Hub's staff
  picks in one box that scrolls, headed "Recommended models". Every row has
  the same layout (mark, name, one line, button). The offer wears a *Best fit
  for your device* badge and the only primary button, a size up from the
  rest; each pick is the Hub's own row (its title, summary and mark, from the
  same `useStaffPicks` the Hub renders) with a **secondary** Download. The
  header lost its "Hey," and its subtitle, and shows the sidebar's own logo
  lockup (tile plus wordmark, now the shared `components/AppLogo.tsx`) rather
  than a hand-copied tile — a copy with identical classes still read as a
  different size next to the sidebar. Notable choices:

  - **The list is the Hub's, not the registry's tail.** The recommendation
    manifest's other rungs are what `useResolvedRecommendedModels` steps down
    through when the offer would not load; rendered as rows they *were* the old
    comparison table. The staff-picks manifest is curated to be browsed, and
    it changes without a release, so onboarding force-refreshes it on entry
    exactly as it does the recommendation manifest.
  - **GGUF only, in manifest order — dealt by publisher.** GGUF is what the
    Hub opens on and what every platform runs; the MLX twins stay behind the
    Hub's format filter. The one liberty taken with the manifest's order is
    `interleaveByPublisher`: each slot takes the earliest remaining pick whose
    brand differs from the row above it (the offer included), so no two
    neighbours are from one publisher. The manifest groups a family's sizes,
    which in a scrolling list read as five Gemma rows then five Qwen rows — a
    catalogue, not a choice. Deterministic, so the list never reshuffles
    between renders and `position` stays meaningful. "Publisher" is the brand
    mark a row wears, not the repo owner: most picks are our own `AtomicChat/…`
    repacks.
  - **Dropped from the list:** only the offer itself and anything already
    installed — both are on screen elsewhere. Nothing is dropped for size: the
    list is the Hub's, not a second recommender, so a pick larger than this
    machine's memory is listed exactly as Models lists it. A pick whose card
    has not resolved keeps its row as a placeholder ("Loading models…" / "Not
    in catalog yet", button disabled), as the registry rows always have, so
    the list is complete from the first paint and fills in.
  - **The box scrolls; the page does not.** The cloud-provider and ChatGPT
    buttons and Skip sit below the box at a fixed place, so the list can be
    as long as the manifest without moving the exits.
  - **Impressions are per row and position, once.** `recommended_model_shown`
    used to fire for the offer alone at the moment `setup_screen_shown` did.
    Rows now get an impression when they first appear — a pick resolved from
    Hugging Face after the first paint included — keyed by section, model id
    *and* position: a late pick slots into the Hub's order above rows already
    reported, and a click on a moved row carries its new index, so the moved
    row is reported there too. Nothing fires while the auto-start of a model
    found on disk hides the picker behind a status line. A row nobody saw
    still has no denominator, and clicks (`position` = index in the painted
    list, offer at 0) divide by an impression at the same position.
  - **The manifest split stays; the screen-level guard goes.** ADR 2026-08-06
    asserted, in `services/__tests__/external-contracts.test.ts`, that
    `SetupScreen` never mentions staff picks — a proxy for "the recommended
    manifest and loader stay independent". The screen now lists them by
    design, so that one assertion is dropped; the test still pins the
    recommended manifest's shape and `schema_version`, that the offer comes
    from `useResolvedRecommendedModels`, and that the recommended loader is
    staff-picks-free. This record supersedes that clause of 2026-08-06 and
    nothing else in it.
  - **Google mark:** `public/svg/google-color.svg` is now the 2025 gradient
    "G" (Wikimedia Commons `File:Google_Favicon_2025.svg`, public domain).
    Same path, so `model-logo.ts` and every Gemma row pick it up unchanged.
  - **The cloud buttons:** "Add a cloud provider" and "Connect ChatGPT
    subscription". The first stays generic — the gallery behind it is where
    the key-versus-sign-in distinction is made, and its subscription card now
    says so ("Subscription — sign in, no API key" where it said only "Sign in
    — no API key"). The buttons are sized to their labels and centred, not
    stretched across the column (a full-width pill reads as the primary
    action), and carry an explicit hover: the theme's `secondary` hover moves
    the fill a fifth of a shade towards the page background, which on this
    screen is invisible.
  - **ChatGPT mark:** `components/icons/chatgpt-mark.tsx`, the OpenAI blossom
    as a `currentColor` SVG, so it takes the button's text colour in both
    themes. The bundled `openai.svg` sits on a white disc for avatar tiles
    and reads as a sticker inside a button.

- **Consequences:** a user who wants something other than the offer can get it
  without leaving onboarding, and the funnel can finally say how far down the
  list people read (`recommended_model_shown.position`). Costs: the step now
  depends on the staff-picks store (one more manifest fetch on entry, and up
  to one Hugging Face round-trip per pick the seed catalog does not carry —
  the same cost the Hub pays). **Watch for:** the box's `max-h` is a fixed
  50 vh / 26 rem; on a very short window the offer scrolls out of view with
  the rest of the list. A pick larger than the machine's memory is listed
  and downloadable with no warning on this screen — the Hub's "Download
  anyway" dialog is not wired here. If that shows up in `model_load`
  failures right after onboarding, the fix is a per-row fit line
  (`describeRecommendationFit` already produces one), not a filter.

- **Owner:** `team`

- **Links:** `web-app/src/containers/SetupScreen.tsx`,
  `web-app/src/containers/__tests__/SetupScreen.test.tsx`,
  `web-app/src/components/icons/chatgpt-mark.tsx`,
  `web-app/public/svg/google-color.svg`,
  `web-app/src/lib/__tests__/model-logo.test.ts`,
  `web-app/src/locales/{en,ru}/setup.json`; supersedes the single-offer
  layout of d29b99b85 (which recorded no ADR of its own), keeps its
  recommender.
