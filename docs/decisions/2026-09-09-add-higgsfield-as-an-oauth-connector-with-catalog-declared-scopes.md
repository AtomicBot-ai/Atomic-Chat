---
date: 2026-09-09
title: "Add Higgsfield as an OAuth connector; a catalog entry may name its OAuth scopes"
---

# 2026-09-09 — Add Higgsfield as an OAuth connector; a catalog entry may name its OAuth scopes

- **Context:** Higgsfield exposes image and video generation over a hosted
  MCP server (`https://mcp.higgsfield.ai/mcp`, streamable HTTP) protected by
  OAuth 2.1: a 401 with `WWW-Authenticate … resource_metadata=…,
  scope="openid email offline_access"`, protected-resource metadata naming
  Clerk as the authorization server, and — verified 2026-09-09 — the MCP host
  also publishes `/.well-known/oauth-authorization-server` with its own
  `/oauth2/register|authorize|token` endpoints in front of Clerk (PKCE S256,
  public client, dynamic registration returns 201 and assigns those three
  scopes). The Connectors page already runs a generic MCP OAuth sign-in
  (rmcp discovery → DCR → PKCE, `core/mcp/oauth/`) for Linear, so the button
  the marketing handoff asked for is a catalog entry, not a new flow. That
  flow, however, always sent an empty `scope`, trusting the provider's
  defaults; a token without `offline_access` has no refresh token and would
  sign the user out every hour.
- **Decision:** Ship Higgsfield as a featured `auth: 'oauth'` connector
  (`serverKey: 'higgsfield'`, `matchUrls: ['mcp.higgsfield.ai']`, official
  app icon on the brand lime) with no Rust template entry, like Linear. Add an
  optional `oauthScopes` to `MCPConnector`; the page passes it through
  `mcpOauthLogin(name, url, scopes?)` to `mcp_oauth_login`, whose new
  `scopes: Option<Vec<String>>` reaches `start_authorization`. Empty or absent
  keeps today's behaviour for every other connector. rmcp's discovery is left
  alone: it reaches the MCP host's own authorization-server metadata first,
  which is a valid, DCR-capable server for this resource. The RFC 8707
  `resource` parameter is not sent (rmcp offers no hook and the proxy fronts a
  single resource).
- **Consequences:** One click, browser login, tools live in chat, billed to
  the user's Higgsfield credits; tokens stay in `atomic-mcp-oauth.json`, never
  in `mcp_config.json` or the frontend. Verified live on 2026-09-09 with a
  signed-in account using a script that mirrors rmcp's exact sequence: the
  consent page names "Atomic Chat", is followed by a plan upsell with a "Skip
  & proceed to MCP" link, and the token response carries a `refresh_token`
  and `id_token` (access token 86399 s; refresh rotates and the refreshed
  token is accepted by the MCP) — so the DCR echo listing only
  `authorization_code` is cosmetic. `tools/list` returns 101 tools
  (~73K characters of descriptions, ~149K tokens as a tool block), spanning
  image/video/audio, 3D, websites, TikTok publishing and billing. That block,
  not the generate-then-poll job shape (`job_status` has a `sync` mode that
  waits ~25 s server-side), is what will defeat small local models; a
  catalog-level default tool allowlist for this connector is the obvious next
  step and is deliberately not part of this change. The Rust change was
  reviewed but not compiled on the authoring machine (no cargo).
- **Owner:** `team`.
- **Links:** `web-app/src/constants/mcp-connectors.ts`,
  `web-app/src/routes/connectors/index.tsx`, `web-app/src/services/mcp/`,
  `src-tauri/src/core/mcp/oauth/{mod,flow}.rs`; Higgsfield MCP page
  https://higgsfield.ai/mcp; MCP authorization spec
  https://modelcontextprotocol.io/specification/2025-03-26/basic/authorization;
  marketing handoff `Documents/Marketing/HANDOFF-2026-09-09-higgsfield.md`.
