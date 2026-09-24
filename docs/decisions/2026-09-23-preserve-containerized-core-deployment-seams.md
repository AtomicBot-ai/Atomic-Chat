---
date: 2026-09-23
title: "Preserve deployment seams for a future containerized core"
status: accepted
---

# Preserve deployment seams for a future containerized core

- **Context:** A future web wrapper may run `atomic-chat-core` in a container and use sibling
  engine containers. The desktop TensorRT plan is already being implemented. Its host provisioning,
  loopback addresses and bind paths must remain desktop choices rather than engine requirements.
- **Decision:** Add internal deployment boundaries and focused fake-backed evidence to the current
  desktop work. Deliver Linux native Docker and Windows WSL Docker only. Defer the server product,
  distribution and orchestration transport.
- **Consequences:** One new child, T01e, precedes the unimplemented executor and adapter contracts.
  Completed wire types, operation records, protocol 2 and artifact identities retain their formats.
- **Owner:** team.
- **Links:** [backlog](2026-09-22-sequence-tensorrt-llm-agent-tasks.md),
  [contracts](2026-09-22-specify-managed-runtime-coding-contracts.md),
  [architecture](2026-09-22-propose-managed-tensorrt-llm-architecture.md).

## Agent handoff: what changed and why

Read this amendment before T01e, T06, T07, T13b/T13c, T14, T19b or T24a. It supersedes only
the assumption that deployment details belong in the shared engine lifecycle. The desktop product
decisions in architecture §0 still apply. This amendment changes planning documents, not runtime code.

Inspection on 2026-09-23 found CORE at `632b934`, a clean CORE worktree, no
`src/runtime/container/` or `src/runtime/managed-text/`, and 19 completed children in the backlog.
APP already had progress edits in the plan and backlog; those edits are retained. Recheck status
before implementing a card: another agent may have advanced it after this inspection.

Changes to the assignment sequence:

1. **New T01e:** implement internal endpoint/deployment contracts and desktop session projection.
   It owns no new public protocol or storage schema. Complete it before T06a and T14a.
2. **T06a/T06c:** retain desktop Docker argv and security policy, but resolve mounts and reachable
   endpoints through injected deployment bindings. Docker daemon paths and core-visible paths
   can refer to different filesystems; copying one path into the other is not a mapping.
3. **T07:** retain exact execution identity and mandatory heartbeat watchdog. Lifecycle calls the
   executor heartbeat operation; it does not touch a presumed local path itself.
4. **T13b/T13c:** retain native/guest file transports and identity. Route storage access through
   those transports rather than adding local filesystem calls to shared download/lifecycle code.
5. **T14a/T14c:** engine builders return engine requirements; deployment code adds host publication
   and heartbeat bindings. Engines still listen on their container port.
6. **T14b/T14d:** readiness uses the executor-resolved internal URL. Desktop registration projects
   that target into today's `SessionInfo.port`; an unreachable/non-loopback target fails before
   publication and follows normal container cleanup. Do not route a browser to a Docker DNS name.
7. **T19b:** the app owner decides full exit versus tray and invokes normal shutdown/unload;
   shared lifecycle does not inspect Tauri or UI state. No configurable heartbeat bypass.
8. **T24a:** add a fake deployment with a non-loopback internal endpoint and differently mapped
   storage, alongside the two fake engines. Prove the same lifecycle works through its dependencies
   and that the desktop session projection refuses that fake endpoint.

The new card is pending. Existing completed statuses are not reopened. Counts become 72 child
headings, 71 live assignments (T01d remains withdrawn), with 19 done. Existing pending IDs retain
their meanings. The copyable next prompt now points at T01e rather than completed T01a.

A related dispatch consistency fix removes leftover dependencies on withdrawn T01d from T08c,
T09b and T16a. Helpers depend on the existing T01a wire contract; T16a depends on T01a/T01b/T01c
and T05b and owns its consumer fixtures, as the already-recorded T01d withdrawal requires. This
prevents dispatching a withdrawn task or creating a self-dependency through T16a.

## Boundaries to implement now

**Provisioning versus execution.** `EnvironmentService` already accepts an injected provisioner.
Keep OS detection and Linux/WSL installers in desktop composition and platform adapters. A load
consumes a verified environment; it does not install Docker, invoke elevation or infer host
capabilities from `process.platform`. An absent provisioner remains unsupported/blocked under
today's contract, never implicitly ready. Future external provisioning needs its own verified
readiness implementation; it is not represented by a successful no-op today.

**Engine specification versus deployment binding.** Keep the existing `buildLaunchSpec` method
name; change its not-yet-implemented return type to `EngineLaunchSpec`, which omits host publication
and heartbeat from desktop `LaunchSpec`. `AdapterContext` loses `host_port` but retains
`container_port`. An injected `ManagedDeployment.prepareLaunch` adds the current desktop bindings.
The shared lifecycle does not allocate host ports, select a socket/distro or branch on the OS.

**Internal address versus desktop session.** Use `BackendTarget { base_url: string }` internally,
resolved by the executor for the recorded execution. This is an HTTP(S) server-root URL, without
credentials, query, fragment or a `/v1` prefix; readiness paths include `/health`. Production
desktop adapters return only validated HTTP targets on `127.0.0.1`. Desktop projection requires
that exact host, a valid TCP port and an empty/root path; projecting another loopback address to
just a port would point existing callers at the wrong listener. Arbitrary URLs from UI, descriptors
or chat input are not accepted, and target validation is retained across redirects (or redirects
are rejected). The future server may reach a sibling by private DNS; its browser would still use
the web wrapper/API. Existing public API forwarding and direct desktop callers are unchanged.

**Storage versus mounts.** Retain persisted `ArtifactLocation` and storage-domain identity.
Resolve each validated location into the Docker daemon's namespace at the executor boundary;
the resolver is bound to that engine and scope and cannot authorize arbitrary mounts. For Linux
today the mapping is local; for WSL it uses the validated guest path. The same mapping discipline
applies to models, cache, entrypoint and heartbeat. Downloads still require their own file
transport. Future named volumes need both a mount mapping and a read/write transport; merely
adding a volume name to a union would not provide them. Implement no volume variant now.

**Ownership and shutdown.** Keep scope, owner instance, session generation, daemon identity and
full container ID as authority. Labels are discovery hints, not permission to stop a container.
The owner invokes shutdown; the watchdog still kills an orphaned managed engine. Keep the existing
per-scope GPU rule, including interruption on model switch, and never stop external workloads.
Future service restarts, Compose-owned engines and ownership handover need an explicit later policy.

## Preserve completed work

- T01a/T01b/T01c: no `ExecutorKind` server variant, descriptor version change, new persisted
  `ArtifactLocation` variant or data-root migration. New interfaces stay internal to runtime modules.
- T02a/T02b/T02c: retain nullable PID, generation and control protocol 2. Actual `SessionInfo` has
  `port`, not a general URL or `host` field; do not implement the earlier conversational sketch as
  a wire migration. Desktop projection supplies the existing port representation.
- T04/T05: reuse state, store, recovery, injected effects, routes and events. T05c's platform
  selection remains desktop composition; it is not a future server host-detection algorithm.
- T08a/T09a: keep probes for their native deployment. A future Linux container must not run the
  Linux probe against itself and treat the result as facts about the Docker host.
- T11a/T13a: preserve residency proofs, artifact hashes, references and storage domains.

If code has advanced beyond the inspected baseline, port these boundaries into the affected pending
card without resetting completed work. Any necessary public/persisted change requires an explicit
paired migration card and amended contract; this document does not authorize such a migration.

## Deferred decisions and delivery

No server mode, web wrapper, server/installer images, Compose stack, bootstrap command, supervisor
service/RPC, Docker socket mounting, remote control authentication, named-volume transport or real
vLLM/SGLang adapter is part of this delivery. Earlier example image names and install commands in
the conversation are illustrative proposals, not published artifacts or executable instructions.

The future server work must choose its controller placement (host service or separate container),
Docker privileges, authentication, network exposure, persistent storage mapping, update/rollback
and restart ownership. A restricted supervisor API is a possible design, not a dependency of this
release. Access to a rootless Docker socket still controls that daemon; labels do not restrict it.

Future sibling containers do not require Docker inside Docker. Preserving the interfaces makes
that topology implementable later; fake tests here do not qualify or ship it. Current acceptance
still requires the real Linux and Windows desktop paths, loopback publication, cleanup and GPU
recovery already specified in the backlog.

## Verification of this documentation amendment

On 2026-09-23, checked local links, unique child IDs, dependency references and cycle freedom,
completion count, and whitespace. `make verify` with Yarn 4.5.3 passed lint (29 warnings), typecheck
and telemetry checks, then exited 2 at the existing test-quality failure in
`web-app/src/providers/__tests__/restore-server-model.test.ts`, already recorded in T00a.
Later verification stages did not run in this invocation. Runtime code and CORE were not edited;
new boundary behavior is acceptance work for the pending implementation cards.
