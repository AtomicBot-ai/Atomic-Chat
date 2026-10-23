---
date: 2026-10-22
title: "Give a connector's name the title row and its badges the line below"
---

# 2026-10-22 — Give a connector's name the title row and its badges the line below

- **Context:** UI audit 2.2.23, finding 01. At the minimum window (1024 px,
  sidebar open) each MCP connector card is about 340 px wide. The title row
  held the name, the Featured (or Official) badge and, at its right edge, Set
  Up or the menu and switch. The name was the only part that could shrink, so
  "Atomic Mail" read "Atomic …" (82 px left for a 90 px name at Medium, 113 px
  at Extra Large).
- **Decision:** The title row holds only the name. Featured and Official are
  10 px pills at the end of the second line, after the byline or the state
  pill (Inactive, Connecting…, Couldn't connect, Connected, Error). That line
  keeps its 16 px height and now centres its items, so a pill sits level with
  the byline at every font size. The byline truncates first; the state pill
  and the badges never shrink.
- **Rejected:** wrapping the badge under the name only when it does not fit.
  The wrapped card's description would start lower than its neighbour's in
  the same row. Moving Set Up to a footer row would also have worked, but it
  takes the primary action out of the header slot that configured cards use
  for their menu and switch.
- **Consequences:** At Extra Large the byline of a featured card that is not
  set up truncates ("By Atomic M…"). The state pill's centre, not its top,
  now lines up with the byline across cards. The Official chip is now a pill
  of the same height as Featured.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/connectors/ConnectorCard.tsx`,
  `web-app/src/containers/connectors/ConnectorCard.layout.test.tsx`,
  [Say on the card why an MCP server did not start](2026-10-21-say-on-the-card-why-an-mcp-server-did-not-start.md)
