---
date: 2026-09-04
title: 'Project MCP schemas before llama.cpp grammar compilation'
---

# 2026-09-04 — Project MCP schemas before llama.cpp grammar compilation

- **Context:** normal chat sends every enabled MCP tool schema to the selected
  provider. llama.cpp turns those schemas into constrained GBNF. Firecrawl's 25
  tools produced a 168 KB, 596-rule grammar containing repetitions such as
  `char{0,10000}` and arrays up to 100 items; both shipped llama.cpp providers
  rejected it before generation with `Failed to initialize samplers` because it
  could not parse the grammar. Increasing context cannot fix a grammar compiler
  limit.
- **Decision:** for `llamacpp` and `llamacpp-upstream` chat requests only,
  recursively omit JSON Schema validation keywords that expand into bounded or
  regex grammar rules: string, array, object and `contains` cardinality bounds,
  plus `pattern`, `patternProperties`, and `format`. Preserve tool names,
  descriptions, property structure, types, required fields, enums and the
  original MCP catalog. Cloud and MLX providers continue receiving the full
  schema. Include provider identity in the tool-cache key so switching providers
  rebuilds the correct projection.
- **Consequences:** complex connectors can initialize llama.cpp grammars without
  silently dropping tools. A local model can emit an argument outside a removed
  constraint; the MCP server still validates the original contract and returns
  its normal tool error. Tool-cost reporting follows the projected schema. Raw
  tool count and context cost remain governed by per-chat connector scoping.
- **Owner:** @xDenside
- **Links:** `web-app/src/lib/custom-chat-transport-helpers.ts`,
  `web-app/src/lib/custom-chat-transport.ts`,
  `docs/decisions/2026-09-02-measure-and-surface-mcp-tool-cost-in-chat.md`

Supersedes: 2026-09-02-measure-and-surface-mcp-tool-cost-in-chat.md (local
llama.cpp schema validation constraints only)
