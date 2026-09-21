---
date: 2026-09-17
title: "Dock inline approvals to the composer border"
---

# 2026-09-17 — Dock inline approvals to the composer border

- **Context:** Inline folder/tool approval cards used the outer composer anchor's width, while the input border was inset by 2 px. The card's negative margin, separate corner radius and translucent fill produced an oversized overlapping panel, and its in-flow height moved the conversation when requests appeared.
- **Decision:** Dock the approval absolutely above the input's own width wrapper. Use an opaque muted surface, matching upper corner radii and side borders, and square the input's upper corners only while a request is present. Keep approval controls outside streaming opacity and disabled toolbar ancestors.
- **Consequences:** Showing, expanding and dismissing an approval preserves composer and conversation geometry. Long tool/resource text breaks within the card, action rows wrap only when necessary, and tall cards scroll within 60% of the viewport height. The upward surface overlays the lower conversation area; users can scroll the conversation to read behind it. Authorization, request resolution, keyboard shortcuts and folder paths are unchanged.
- **Owner:** team.
- **Links:** `web-app/src/containers/AgentApprovalInline.tsx`, `web-app/src/containers/ChatInput.tsx`, `web-app/src/containers/AgentApprovalInline.layout.test.tsx`.
