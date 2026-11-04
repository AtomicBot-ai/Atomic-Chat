---
date: 2026-11-04
title: 'Name the model a send without a selection will start, and give composer actions full-size targets'
---

# 2026-11-04 — Name the model a send without a selection will start, and give composer actions full-size targets

- **Context:** With no model selected, the composer's arrow was named
  "Choose what to reply with", yet pressing it loaded the last used model and
  sent the draft (ATO-461 auto-start; QA 2.3.4 AC-02). The 2.3.4 design review
  (D3) also asked for one composer action system with 36 px icon targets, 8 px
  gaps and a 40 px Send, while the 2026-10-27 density record keeps controls at
  28 px.
- **Decision:** Keep the auto-start, but say it. The pick is one pure function,
  `pickReplyModel`, used both by `tryAutoStart` and by a side-effect-free
  `useReplyModelPreview`. When a model would start, Send is the filled primary
  action named "Send with {{model}}"; only when nothing resolves does it keep
  "Choose what to reply with", and then it opens the reply-model widget. The
  composer's icon actions are the same 28 px ghost button with an invisible
  36 px click target (`hit-area-36`), 8 px apart; Send and Stop are drawn at
  28 px with a 40 px target (`hit-area-40`). The tools button is the dropdown's
  own trigger, so the keyboard opens it. At Extra Large, message body leading is
  capped near 24 px.
- **Consequences:** The visible density is unchanged; target sizes meet the
  review without larger buttons. The mic's and Send's targets overlap by 2 px
  inside their gap (Send wins). A model that finishes downloading or a cloud key
  that gets connected relabels the button. Chromium layout tests cover Medium
  and Extra Large at 1024/1280 px with the sidebar open and closed; the real
  WKWebView/WebView2 app was not checked.
- **Owner:** `team`
- **Links:** `web-app/src/lib/reply-model-gate.ts` (`pickReplyModel`),
  `web-app/src/hooks/useReplyModelAutoStart.ts`,
  `web-app/src/containers/ChatInput.tsx`, `web-app/src/index.css`,
  `web-app/src/containers/ChatInput.actions.layout.test.tsx`,
  [Make the default interface denser](2026-10-27-make-the-default-interface-denser.md).
