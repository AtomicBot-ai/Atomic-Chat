---
date: 2026-10-22
title: "Show an assistant's initial when it has no avatar"
---

# 2026-10-22 — Show an assistant's initial when it has no avatar

- **Context:** UI audit 2.2.23, finding 12. An assistant's avatar is optional
  (an emoji or an `/images/…` path). Settings → Assistants, the run settings
  assistant picker, the project dialog and the project page each rendered
  `AvatarEmoji` only when an avatar was set, and `AvatarEmoji` rendered
  nothing for a missing one. An assistant without an avatar, such as "RC 2.2.0
  QA Assistant", showed an empty tile in Settings and no mark in the pickers.
  An avatar image that failed to load showed a broken image.
- **Decision:** `AvatarEmoji` takes the assistant's `name`. When the avatar is
  missing or blank, or its image fires `error`, it shows the name's first
  letter or digit, upper-cased, in the image's slot. If the name has no letter
  or digit, it shows the robot-head glyph. The default slot is a 16 px square
  with a light fill, which is the pickers' image size. Settings passes
  `fallbackClassName` for a 24 px slot without a fill, because its tile
  already has one. Every place that shows an assistant avatar passes the name.
  The assistant editor passes `fallback` to keep its emoji-picker icon, which
  now also replaces an image that fails to load.
- **Rejected:** a colour per assistant derived from a hash of its name. It is
  more recognisable, but it adds colours to the palette in both themes and
  says nothing the name next to it does not. The initial uses the existing
  muted colours.
- **Consequences:** A failed image is tried again only when the avatar changes
  or the view mounts again.
  The initial is `aria-hidden`, since the name is always shown beside it.
  `AvatarEmoji` without `name` or `fallback` still renders nothing for a
  missing avatar.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/AvatarEmoji.tsx`,
  `web-app/src/containers/AvatarEmoji.layout.test.tsx`,
  `web-app/src/routes/settings/assistant.tsx`,
  `web-app/src/containers/RunSettingsPanel.tsx`,
  `web-app/src/containers/dialogs/AddProjectDialog.tsx`,
  `web-app/src/routes/project/$projectId.tsx`,
  `web-app/src/containers/dialogs/AddEditAssistant.tsx`
