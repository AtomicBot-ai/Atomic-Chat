---
date: 2026-09-19
title: "Say when MCP tools are auto-approved"
---

# 2026-09-19 — Say when MCP tools are auto-approved

- **Context:** The composer's approval select shows `manual` — "Ask for approval" — on a thread whose mode the user never picked. For MCP and RAG tool calls such a thread follows the global "Allow All MCP Tool Permissions" switch instead (`lib/mcp-approval.ts`), and that switch is on for everyone: `useToolApproval`'s migration forces it on, a deliberate choice to hide the approval popup by default. So the label promised a question that was never asked. Found by `tests/e2e/desktop/mcp-tool.spec.ts`.
- **Decision:** Keep the behaviour — it is a product decision with its own setting and description — and make the label true: on a thread with no chosen mode, while the global switch is on, the select reads "Ask for approval · MCP tools auto-approved". Once the user picks a mode the select governs MCP tools too and shows the plain label. Rejected: turning the global default off, which would reverse that decision for every user; and showing "Full access" there, which would misdescribe the agent's built-in tools, which do ask.
- **Consequences:** The composer no longer contradicts what happens. The caveat is English with a Russian translation; other locales fall back to English. The agent's built-in dangerous tools are unaffected: they gate on the approval mode alone, defaulting to manual.
- **Owner:** team
- **Links:** `web-app/src/containers/ChatInput.tsx`, `web-app/src/lib/mcp-approval.ts`, `web-app/src/hooks/useToolApproval.ts`, `tests/e2e/desktop/mcp-tool.spec.ts`
