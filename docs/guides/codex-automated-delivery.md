# Draft-safe automated Codex delivery

## Contract

A background message is a distinct user submission. It never pastes into, clears, reads and restores, submits or otherwise changes the native editor. This holds with an empty editor, an existing draft, concurrent human typing and an active model turn.

Use Codex's existing `thread/queue/add` over its already-running local control socket. Connect only: never start, resume or interrupt a thread, start a daemon, change a model/permission, or fall back to tmux input. The exact current AoE owner and recorded native UUID must agree with the supplied delivery packet, and the owner must be live and unarchived. The selected native store is explicit. Codex's standard user-owned control-socket symlink is supported only when its resolved target is an existing user-owned socket; initialization must also confirm the selected native store. A missing socket, thread, supported method or valid identity is a visible failure; preserve the original work and retry state.

Every caller supplies its original stable delivery ID. Different instructions with identical text retain different IDs. A successful result means the native queue accepted the exact text, not that an agent acted on it or completed the work. Preserve the original source IDs, authority, holds and schedule outside this transport.

The native queue's `clientUserMessageId` is a correlation ID, not an idempotency guarantee in Codex 0.162.1. Its queue inserts a fresh row on each add. A durable local journal therefore records the exact packet before an attempt, holds a per-ID exclusive lock and records `sending` before the add. A repeated ID with changed text, owner, store or native thread is refused. Confirmed acknowledgments are reused without another add. After an ambiguous failure, reconcile the same ID and text against the native queue or paginated history. Positive evidence confirms delivery; absent or inaccessible evidence leaves an explicit uncertain hold and never re-adds blindly. Definite failures before the add remain safely retryable. A stale journal lock is a visible maintenance blocker, never automatically discarded.

## Operator transport

`contrib/codex-queue-send.cjs` is a standalone repair transport. It is not a replacement installed into the AoE binary. Keep automated `aoe send` callers paused until each is switched to this transport or a reviewed equivalent. The central action ID belongs in `deliveryId` and must survive retries. No script or daemon is installed automatically.

The operator supplies a private JSON packet with `sessionId`, `threadId`, `deliveryId` and `text`, a native store, a persistent journal directory, the current profile's sessions file and an existing local WebSocket module. `--check SESSION` performs only initialization, metadata and queue reads. Normal invocation requires `--packet FILE`; it never creates a packet or invents new execution authority.

The tool emits only receipt metadata and hashes. It never prints message bodies, login material or history. Journal files are private and durably written; journal capacity failure prevents an untracked submission. Test and scratch state belong in the explicitly provided test directory.

## Evidence and limits

A successful background message can be pasted into an unfinished human question, with further human typing appended before Enter. This is a composer race, independent of whether the background message is a duplicate. Synthetic editor tests reproduce that symptom with the old tmux primitive and verify the native queue leaves drafts and concurrent typing untouched.

Protocol evidence: the installed Codex 0.162.1 generated schema and upstream [thread queue processor](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/thread_queue_processor.rs), [queue service](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/ext/queue/src/service.rs) and [queue storage](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/state/src/runtime/queued_items.rs). Unloaded persisted root threads may accept queue items; existing native queue watchers discover external changes. That is not proof of when a particular message will execute, and no real model message is sent during verification.
