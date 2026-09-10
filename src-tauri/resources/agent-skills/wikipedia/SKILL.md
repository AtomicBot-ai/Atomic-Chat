---
name: wikipedia
description: Wikipedia research patterns - point-in-time revisions (oldid), revision history API, reliable section lookup. Use when a question says "as of <year>" or "the <year> version" of a Wikipedia page.
version: 1.0.0
requires_tools:
  - os.web.fetch
dangerous: false
platforms:
  - darwin
  - linux
  - win32
---

# wikipedia

Answer Wikipedia questions from the RIGHT VERSION of the page. The live page is
wrong for any question that says "as of 2020", "the latest 2022 version",
"before December 2022", or similar — fetch a historical revision instead.

## Point-in-time revisions (oldid)

Every revision has a permanent URL:

- `https://en.wikipedia.org/w/index.php?title=<Title>&oldid=<REVISION_ID>`

To find the last revision before a cutoff date, use the revisions API
(`os.web.fetch` the URL; it returns JSON):

- `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&titles=<Title>&rvlimit=1&rvdir=older&rvstart=<ISO8601>&rvprop=ids|timestamp&format=json`

`rvstart` = the cutoff, e.g. `2023-01-01T00:00:00Z` for "the latest 2022
version". Read `query.pages.<id>.revisions[0].revid`, then fetch the oldid URL
above with that revid.

## Full history

- `https://en.wikipedia.org/w/index.php?title=<Title>&action=history` — human view
- The API above with `rvlimit=20` lists recent revisions with timestamps.

## Other patterns

- Underscores in titles: `Mercedes_Sosa`, not spaces.
- Discography/albums questions: the answer is usually a table or section on the
  artist page or a dedicated `<Artist>_discography` page — check both.
- Featured-article promotion questions: the article's talk page and
  `https://en.wikipedia.org/wiki/Wikipedia:Featured_article_candidates/<Title>`
  record who nominated it and when.
- If a fetched page is long, the full text is saved to disk by the fetch tool —
  search it with `os.fs.grep { pattern, path }` rather than re-fetching.
