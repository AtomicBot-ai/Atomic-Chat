---
date: 2026-11-19
title: Group configured Strata models by weights repository
---

# Group configured Strata models by weights repository

Catalog-defined models can reuse an engine profile across independent releases.
Group their compatible quantizations by family, source host and repository of
the first weight shard. The source of auxiliary files such as Engram is shared
between releases. Each choice retains its own installation ID and disk check.

The browser SDK and bundled app core must both support the optional
`strata-profile-models` collection before a desktop release exposes it.
