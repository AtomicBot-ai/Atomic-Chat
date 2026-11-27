# Share projects between Chat and Agent

Accepted on 2026-11-27.

A project owns its settings, assistant, document collection and history. Chat and Agent use the existing project ID and the same membership stored in each conversation. Existing projects appear in both modes without migration.

The mode switch lives on the Chat and Agent start pages. Opening a project from either mode selects its corresponding composer and records the mode in the project URL. Each composer keeps its own draft. History combines chats and tasks in activity order. Opening an entry restores its original conversation and execution mode.

A project task can enumerate and read the project's indexed files through the desktop host. The host looks up the task's persisted project before each read. The configured project assistant supplies instructions on each turn. A secure project's shell goes through the existing secure command runner. Moving a task or changing its project's security policy ends the old child session so the next turn picks up the current scope.
