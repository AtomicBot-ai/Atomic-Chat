---
date: 2026-08-25
title: "Add Atomic Agent as a one-click Launch-page assistant, configured by merging an `openai-compatible` provider into `~/.atomic-agent/config.json`"
---

# 2026-08-25 — Add Atomic Agent as a one-click Launch-page assistant, configured by merging an `openai-compatible` provider into `~/.atomic-agent/config.json`

- **Context:** The Launch page already installs and points fifteen external
  agents at `http://localhost:1337/v1`, including Nous Research's Hermes
  (see `2026-06-01-add-a-launch-page-to-install-configure-external-coding-agents.md`).
  [`AtomicBot-ai/atomic-agent`](https://github.com/AtomicBot-ai/atomic-agent) —
  our own local-first operator agent — was not among them, so running it on
  Atomic Chat's models meant hand-editing its config file, the one flow the
  Launch page exists to remove. Its provider registry gained an
  `openai-compatible` kind (`src/llm/provider/registry/register-built-in-providers.ts`),
  so nothing new has to be built on either side.
- **Decision:** Add `atomic-agent` to the catalog as an **assistant** (the same
  kind as Hermes and OpenClaw), listed first in that group. `install_agent`
  spawns the project's official bootstrap script — `curl -fsSL
  https://atomicagent.io/install | sh` on Unix, `irm
  https://atomicagent.io/install.ps1 | iex` on Windows — because it ships as a
  Node SEA binary from GitHub Releases, not as an npm package; the prerequisite
  is therefore `curl` / `powershell`, matching Goose, Hermes and Poolside.
  A new `configure_atomic_agent` in `core/system/commands.rs` upserts a single
  provider entry into `<state dir>/config.json`:

  ```json
  { "id": "atomic-chat", "kind": "openai-compatible",
    "baseUrl": "http://127.0.0.1:1337/v1", "apiKey": "atomic",
    "defaultChatModel": "<running model>", "supportsTools": true,
    "requestTimeoutMs": 300000 }
  ```

  and sets `llm.activeTextProvider` to it. The state dir is resolved the way
  the agent's own `loadConfig()` resolves it: `ATOMIC_AGENT_STATE_DIR` first,
  else `~/.atomic-agent`.
- **Consequences:**
  - **The write is a merge, never a replacement.** `config.json` is the agent's
    own trust surface (it holds `agent.approvalLevel` and is guarded by its
    approval ladder), so the writer touches only `llm.providers[atomic-chat]`
    and `llm.activeTextProvider`. Other providers, their API keys, unknown
    top-level blocks and the `version` field survive verbatim — the agent fills
    every block it does not find with its own defaults on the next start, so we
    deliberately do **not** stamp a schema version we would have to track.
  - **`activeEmbeddingProvider` is load-bearing.** The agent rejects the whole
    config when it names a provider that is not in `llm.providers`. Embeddings
    drive memory recall rather than chat, so a working selection is left alone;
    an absent or dangling one is repaired, always to `local-llama` — the
    agent's own default — and never to `atomic-chat`, which would hand memory
    recall to Atomic Chat behind the user's back. The `local-llama` entry is
    seeded in both paths (empty provider list, and repair over a list that does
    not carry it), built from the same inputs the agent's own parser uses:
    `localModels.url`, or `http://127.0.0.1:<managed.port>` when
    `localModels.mode` is `managed`, which is what the agent talks to then.
  - **The absent case writes the key, unlike `toolTransport`.** Absent and
    dangling are repaired the same way on purpose: an absent
    `activeEmbeddingProvider` defaults to `local-llama` inside the agent's
    parser, which then rejects the file unless that entry is *listed* — so the
    absent case is already a write (the seeded provider), not a no-op. Naming
    the provider we just seeded next to it keeps a hand-edited file
    self-describing, and by construction the name matches what the parser would
    have chosen anyway. That is the one place we restate an agent default, and
    it is deliberate.
  - **The seeded `local-llama` entry carries `baseUrl`, not just `url`.** Chat
    and embeddings are two different daemons, and the embedding path resolves a
    provider entry as `baseUrl ?? url`
    (`src/memory/embeddings/embedding-provider-registry.ts`). Creating the
    `llm` block therefore moves a config from the branch that reads
    `localModels.*` directly to the branch that reads the entry — and an entry
    with only `url` would silently repoint embeddings at the chat daemon for
    everyone running the embeddings daemon, the exact outcome this writer
    exists to avoid. `baseUrl` mirrors the no-`llm`-block branch:
    `localModels.embeddings.url` (or `http://127.0.0.1:<embeddings.port>`) when
    that daemon is enabled, and the entry's own chat URL when it is not. The
    entry the agent synthesises for itself sets `baseUrl` to the embeddings URL
    *unconditionally*; copying that literally would point a default install at
    a port with nothing listening, so the branch that governs the files we
    convert is the one we mirror.
  - **`toolTransport` is deliberately not written.** The agent defaults an
    absent one to `"auto"`, so writing it could only ever restate the agent's
    own choice while adding a key to the user's file.
  - **Only the text provider is switched outright.** Pressing Run is an
    explicit "use this", the same contract as OpenCode's `model` key.
  - **`requestTimeoutMs` is a tightening, like Hermes'.** The agent's
    OpenAI-compatible provider defaults to 600 s, long enough that a wedged
    local turn looks like a hang; 300 s is seeded, and a `requestTimeoutMs`
    already tuned on our entry is preserved. Nothing else on the entry is: a
    re-run rewrites `atomic-chat` wholesale, because every other field on it is
    ours to state.
  - **`endpointWithPrefix: true`.** The stored `baseUrl` reads as the base URL
    a user would paste; the agent normalises a trailing `/v1` away in the
    provider constructor (`normalizeOpenAiBaseUrl`), so requests still land on
    `/v1/chat/completions`, not `/v1/v1/...`.
  - **An empty model is refused before the write.** The agent's
    `parseOptionalString` rejects `""` rather than treating it as absent, so an
    empty `defaultChatModel` would take the whole file down at its next start.
    Both callers already guarantee a model; failing in the writer makes that
    its own contract rather than an inherited one. The check is on the trimmed
    name, so the write is too — the agent asks the server for the string it
    finds, and `" qwen "` is not a model any server has.
  - **The Windows registry read is reused.** `ATOMIC_AGENT_STATE_DIR` is read
    from `HKCU\Environment` before `std::env::var`, for the same
    stale-snapshot reason as
    `2026-07-01-fix-hermes-agent-config-on-windows-writing-to-the-wrong-file.md`.
  - **Detection has the usual first-run gap.** The Unix installer drops the
    binary in `~/.local/bin` and appends to a shell rc file, which the
    memoised login-shell PATH in this process cannot see — same as Goose,
    Poolside and Zed. The terminal that Run opens is a fresh login shell, so
    the launch itself works; the "Installed" chip catches up on the next app
    start.
- **Owner:** team.
- **Links:**
  [`web-app/src/constants/integrations.ts`](web-app/src/constants/integrations.ts),
  [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx),
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs),
  [`src-tauri/src/core/cli/integrations.rs`](src-tauri/src/core/cli/integrations.rs),
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs),
  https://github.com/AtomicBot-ai/atomic-agent
