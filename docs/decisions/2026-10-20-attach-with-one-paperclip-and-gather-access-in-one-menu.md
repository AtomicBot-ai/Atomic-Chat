---
date: 2026-10-20
title: "Attach with one paperclip and gather what the model may do in the access menu"
---

# 2026-10-20 — Attach with one paperclip and gather what the model may do in the access menu

- **Context:** The composer's "+" menu mixed four jobs: per-type pickers
  ("Add Images", "Add audio" for audio models, "Add documents or files",
  disabled for models without tools), the hidden Agent mode switch, "Run
  commands" (`chatExecEnabled`,
  [2026-10-15](2026-10-15-run-commands-and-scripts-from-chat.md)) and the
  agent's "Add folder". Each picker had its own rules, while a drop of the same
  files went through `handleTauriDrop` → `classifyDroppedPaths`. Send sat in
  the toolbar disabled whenever the field was empty. The approved interface
  prototype (iteration 2 of the new design, after
  [the control scale](2026-10-20-put-every-control-on-a-36-24-40-px-scale.md))
  replaces the menu with one attach button, calls the asking mode
  "Restricted", shows Send only with something to send, puts an animated logo
  on the empty chat and drops the title rows above Images and Videos. The
  prototype attaches through a browser `FileReader` and drops Plugins, Run
  commands and Agent mode; those are real features here.
- **Decision:**
  - A paperclip opens one native picker filtered to every extension a drop
    accepts (images, audio, documents and code). The picked paths go through
    `handleTauriDrop`, so the drop's rules apply: the Attachments setting,
    the audio-capability gate, documents to retrieval, "Unsupported file type"
    for the rest. One difference: images for a model without vision open the
    vision-model dialog, as "Add Images" did, where a drop shows a toast. The
    web build, which has no paths, clicks a hidden file input routed like an
    HTML5 drop.
  - The approval select becomes the access menu: the two modes, then
    switches for what the model may do at all — "Run commands" (gated
    `PlatformFeature.CHAT_EXEC`) and Agent mode (gated `AGENT_MODE`, still
    hidden per [2026-10-15](2026-10-15-hide-agent-mode.md)). A switch is a
    `menuitemcheckbox`. The manual mode is labelled "Restricted" (en, ja, ru;
    "Full access" unchanged) and the label shows in the compact composer too.
    "Add folder" is an icon beside the paperclip while the agent serves the
    chat.
  - Plugins stays as the toolbar's compact icon around `DropdownPlugins`
    (per-chat connector mute and secure-project locks unchanged).
  - Send (or Stop while a reply streams) grows in from zero width in 0.24 s
    when the field has text, and leaves when it is empty; no animation with
    reduced motion. The slot clips only while it moves, so the focus ring is
    never cut.
  - The empty chat shows `LazyAtomicLogo`: the 112 px mark displaced by an
    animated SVG turbulence filter plus a 3 px float, both off with
    `prefers-reduced-motion`. The colour filter sits on the `<svg>`, because
    WebKit ignores CSS filter functions on SVG children.
  - Images and Videos lose the `HeaderPage` row: the form's heading names the
    page. The plural "Videos" comes from `common:video` and
    `videos:page.title` (en, ru).
- **Consequences:**
  - Documents can be picked for a model without tools, as they could already
    be dropped; retrieval decides at send time as before.
  - Images picked for a non-vision model are not kept for after the vision
    model downloads; the user picks them again.
  - Desktop E2E can no longer wait for Send as the end of a reply: specs wait
    for Stop to go away. `chooseFromMenu` also matches `menuitemcheckbox`.
  - Not verified in a real build: the animated SVG filter's cost and
    rendering in WKWebView (macOS) and WebKitGTK (Linux), light and dark.
- **Owner:** team
- **Links:** `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/containers/AgentApprovalModeSelect.tsx`,
  `web-app/src/components/LazyAtomicLogo.tsx`, `web-app/src/routes/index.tsx`,
  `web-app/src/containers/images/ImageGenerationPage.tsx`,
  `web-app/src/containers/videos/VideoGenerationPage.tsx`,
  `web-app/src/containers/ChatInput.composer.layout.test.tsx`,
  `tests/e2e/desktop/{document-attachment,mcp-tool,chat-workflows}.spec.ts`
