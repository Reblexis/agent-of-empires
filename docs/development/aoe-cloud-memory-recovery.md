# aoe-cloud memory recovery, 7 November 2026

Task #1185 and central request `a160433581e8` stay open until the four fixes
are deployed and a complete day of readings passes. Continuation owner:
AoE `3d108d3d1d9c436f`; keeper: `595425472be34943`. Earlier owners
`1332eb15670340b6` and `d4ad5673d6a54cc4` must not be resumed.

## Verified facts

- The 30 GiB host was using about 26 GiB RAM and 12 to 14 GiB swap at
  21:25 UTC. Session hibernation already worked; its live cap was reduced
  from 50 to 25 and the existing daemon picked it up without a restart.
- Measured at 23:26 UTC: 52 agent processes, median RSS 226 MiB, maximum
  672 MiB, total RSS 11.73 GiB. The cap covers idle sessions; busy sessions
  and scheduled work deliberately exceed it.
- Scheduled-work protection was pushed as `2df8fd89` on
  `fix/hibernate-keeps-scheduled-work` and `local-defaults`. Review found
  that recorded Claude account stores could differ from current config;
  `f86b9a9a` fixes this lookup. The new regression failed against the old
  lookup and passed after the fix; all six conversation-carry and both
  held-work tests passed with it.
- The shared heavy-job lock is deployed by telarchy-youtube `d424b335`
  and telarchy-creators `7050728b`. All nine heavy units use the same lock;
  a harmless contender against a live holder returned 75. Manual examples
  were corrected in youtube `9ddd8c35`; a bare CLI still bypasses the lock.
  The lightweight research hub was left running.
- Repo GC fix: viktor-cihal `144347df`. All 81 Git directories inspected
  have `gc.auto=0` and `maintenance.auto=false`. Sequential low-priority GC
  is scheduled for 03:30 Pacific, bounded to 1536 MiB and no swap. The
  focused GC script passed 11 checks; the first full nightly run is pending.
- Memory vital: io-agent `48835d5`; observation follow-ups `142262d` and
  `886fe67` (PRs 77 and 78), pinned by agents `aae105d`. The threshold uses exact 85% RAM
  occupancy. 130 relevant tests and 34 focused follow-up tests passed. The existing five-minute CSV is
  `~/.local/state/io-vitals/memory.csv`; page counters and boot IDs are in
  `memory-observation.csv` beside it. Both collectors are installed. The recorder preserves timer jitter and
  the review message uses the configured current keeper.
- Short zero-swap-write samples did not prove recovery. At 23:29 UTC,
  concurrent compilation and test suites produced fresh swap writes again.

## Deployment and observation

`local-defaults` source `2df6d397` was built with
`cargo build --release --features web -j 2` and installed on 8 November
at about 00:46 UTC. The release build passed in 24m 33s. Its SHA-256 is
`ce77ca3623b755921d193ec1adf75e6bfebe195190841afe9990ad350a8f6de5`.
All historically deployed branches in `local-build.md` were verified as
ancestors before building. No optional inbox-target proposal was included.

Validation passed: 4,304 unit tests, 190 integration tests, the two additional
single-test targets, formatting, and Clippy for all targets with and without
the web feature alias. The existing ignored tests were unchanged. The release
build retained an existing release-only unused import warning in
`src/server/runtime_ws.rs`.

A real isolated daemon and private tmux server reproduced the reported bug
with the old installed binary: it hibernated a session holding a future wake.
The new release kept that session alive while parking an unprotected session,
then parked the held session after its wake was cancelled. The transcript was
only in the recorded Claude account store, different from current defaults.
Both private test process trees were cleaned up.

The installed daemon was restarted with its existing `KillMode=process`.
All 35 tracked native agents survived with the same process identities.
The dashboard returned HTTP 200 and `aoe session verify-pointers` reported no
violations. The previous binary, deployment receipt and pointer output are in
`~/.local/state/aoe-oom-recovery/20261108/`. Smoke results are retained in
`/tmp/aoe-hold-smoke-tg0zd5zv/` (old binary) and
`/tmp/aoe-hold-smoke-3slfmf0q/` (new binary).

The observation interval is **8 November 2026 00:47:08 UTC through
9 November 2026 00:47:08 UTC**. The explicit initial sample records RAM 47.6%,
swap 9,152 MiB, `pswpin=282101866`, and `pswpout=381735264`.
`io-memory-observe.timer` records every five minutes with one-second timer
accuracy. The enabled persistent `io-memory-review.timer` wakes current owner
`3d108d3d1d9c436f` and keeper `595425472be34943` at the end. Its config is
`~/.local/state/io-vitals/oom-observation/config.json`; its durable result will
be `summary.json` beside that config. The keeper was hibernated, not replaced,
and received the deployment updates. Original owners stay stopped.

## Validation load, central request 68b9ca0383cc

The owners stopped a duplicate two-worker Jest gate and three broad Python
suites. The remaining Telarchy gate was serialized. The AoE regression
compile was temporarily deprioritized while the local gates drained, then
returned to its ordinary priority once those jobs moved. Two fresh
one-second vmstat samples after that reduction had no swap writes, compared
with 60 to 70 MB/s before it; this is only a short observation.

All ten dedicated Telarchy runners were idle at 23:33 UTC. They are reserved
for telarchy-app, so its owner received the documented SSH path and a unique
runner-owned directory under `/home/runner/telarchy-validation/`, with a
per-job `RUNNER_TEMP` and cache. An initial `_work/_temp` recommendation
was withdrawn after Actions startup erased manual jobs there. Stable base
directories were prepared on A, B and C, owned by `runner` with mode 0750;
one manual gate per host shares `.gate.lock` and retains its two-worker cap. The thumbnail owner moved serial exact
YouTube and creators archives to the laptop with one host lock. An initial
infra-box suggestion was withdrawn when its backup-only role was confirmed;
the owner stopped its setup process and verified its temporary directory was
removed, with no tests, services or global packages changed there.

The final setup release owner reported 485 passing backend files and serial
frontend coverage of 317 files / 4,669 tests, plus passing typecheck, lint and
build. Its manual gates on A, B and C were released. Automatic Actions jobs
remain independent of the manual lock, so other owners retain the agreed
preflight (no `Runner.Worker` and at least 4 GiB available) and stop their own
manual workers below 1 GiB. No extra capacity or caps were added.

## Pending evidence

- Complete the observation interval above and inspect the first full nightly
  sequential GC run. Task #1185 and central request `a160433581e8` remain open.
- Accept only complete samples without a reboot or counter reset, no gaps
  longer than ten minutes, no new swap-out counter growth and no increase in
  end-of-day occupied swap. Cached swap reads are reported separately.
- If the day still shows swapping, obtain a current larger-box price and
  send a central `request decision`; do not change budgets or caps.

## Assistant assessment

The idle cap and serialized heavy jobs reserve useful headroom, but simultaneous
whole-project validations can still exhaust this host. One minute of lower
swap pressure is insufficient evidence that the original task is complete.

Test-shell detail: this host inherits umask 0002. Permission-sensitive tests
need ordinary private directory modes. Focused security tests passed with
umask 077, but one integration fixture deliberately expects a 0644 lock file.
The complete integration run therefore used umask 022 and passed all 190 tests.
An initial migration timing message also changed stderr in a parity check;
its focused rerun and the complete integration rerun passed without a source
change.

## Wake verification, 8 November 01:45 UTC

The repeated original request was checked against the installed deployment,
not treated as a second incident. The installed binary still has the recorded
SHA-256. Both observation timers are active with the original targets and
deadline; no duplicate build, monitor or recovery owner was started. The first
full nightly GC remains due at 03:30 Pacific on 8 November.

At 01:44 UTC the host had 13 GiB RAM used and 17 GiB available, with load
33.65 and memory PSI avg10 0.06%. A fresh `aoe ps --json` completed in
8.67 seconds. Process totals at that snapshot were roughly 8,028 MiB RSS
for 31 Codex processes, 1,487 MiB for 11 Claude processes, and 4,347 MiB
for 18 Python processes. The serialized creators baseline job held about
3 GiB RSS. These are transient observations, not workload caps.

The first 13 samples span 57.9 minutes, retain one boot ID and have no gap
over 300 seconds. RAM peaked at 71.7%; occupied swap fell from 9,152 to
7,758 MiB. However, `pswpout` increased by 3,777,095 pages, or 14.41 GiB
at the observed 4,096-byte page size. Thus the no-new-swap-writes acceptance
condition has already failed for this observation interval. Lower occupied
swap alone does not establish recovery. Do not reset the interval or report
request done. Preserve the 9 November 00:47:08 UTC review and evaluate the
complete evidence, then follow the documented larger-box price decision path
if swapping persists. The separate disk owner is `4bde1a9370f14ff0`.

This wake changed only the operational record. No new feature behavior or
code was changed; validation used live processes, timer state, binary hash,
the real CLI and persisted counter readings rather than a new feature test.
