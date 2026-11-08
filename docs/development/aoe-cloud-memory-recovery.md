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

## Restart churn and overload follow-through, 8 November

Fix-central reported restoring the live cap from 25 to 50 at about 02:05 UTC:
36 restarts across 33 sessions in an hour, with context rebuilding accounting
for 34% of Codex usage. Its sample was about 190 MB per Codex process and
18.5 GB available. These are the reporter's observations. The box README
and provisioning now agree on the baseline cap of 50, via viktor-cihal PR350
(merge `1c6e0ecb`). Provisioning preserves unrelated TOML and uses the helper
staged with the setup script; three behavior tests pass, including quoted
keys, multiline strings, invalid input and an older existing clone.

The native pressure gate is being validated on `fix/pressure-hibernation`.
The documented contract opts the box into RAM occupancy of at least 85%,
parks at most one oldest eligible session per sweep, and leaves healthy or
unknown memory alone even above the count cap. It can relieve pressure even
below the count cap. A generic global protected-session list also excludes
central, lead and router identities from automatic hibernation and idle-stop;
the controller owns those role identities and their live successors. Manual
Stop remains effective. Installation remains pending until fresh checks,
real-daemon smoke and the process-preserving deployment receipt pass.

The old installed binary reproduced healthy-memory parking in an isolated
real-daemon fixture at `/tmp/aoe-pressure-smoke-acdvwtii/result.json`.
Its expected failure left the scheduled-work session live and parked the
ordinary idle session. Both private process trees were cleaned up. The new
fixture also checks a protected role and uses a lower configured threshold
to exercise pressure without allocating host RAM. Operational runners and
receipts are under `~/.local/state/aoe-oom-recovery/pressure-20261108/`.

The 02:20 self-heal brief additionally assigns central's overload runtime to
this owner. Its separate contract is `central-agent/docs/overload-recovery.md`:
a storm means more than ten restarts in an hour; cap increases require more
than 6 GiB available. Load above three times the core count or swap occupancy
above 80% must persist for five minutes before overload shedding. Admission
waits while overloaded; only vetted headless timer launchers may pause, one
at a time, leaving in-flight jobs intact. Central, leads, router and their
successors are protected. Central decision `89565790cc66`, resolved by
`419643af09a64d83`, rejects an overload or unknown-metrics bypass for their
restarts: shed eligible background work and retry unattended instead.
The overall self-heal owner keeps the inventory in `docs/strategy.md`;
this owner covers the separate overload contract and tests. Central source
`fix/overload-recovery` at `2cbe5aa` is pushed and independently reviewed:
20 focused tests and all 1,603 Python tests pass. Sampling has its own
15-second worker, independent of the health check and pulse; a regression
covers the observed 135-second health stall. The source also shares AoE's
`.config.lock`, rechecks admission before stopping a continuation owner and
fails closed on corrupt durable state. Central rollout owner
`48eb5b44c7484a07` has the integration handoff and owns the strategy inventory;
this session retains deployment verification and the agents pointer bump.

Activation order: central source may merge with overload recovery disabled;
stage the protected-role identities; install the verified native pressure and
protection binary; then enable central overload recovery with vetted timers.
The live config already has 78 protected IDs staged, but the old binary ignores
that unknown field. Its live cap is still 50 and the pressure threshold is not
yet installed. The controller opt-in is absent. The installed binary must not
be mistaken for the new release during this sequence. Vetted loaded independent
headless timers are `telarchy-youtube-research-day7.timer` (priority 0) and
`telarchy-creators-yt-baseline.timer` (priority 1). Do not pause GC, memory
recording/review or control-role wake timers. Research track and sweep files
exist but their user-unit adapters could not resolve a loaded timer, so skip
those entries until verified.

During validation, two dogfood full Jest suites overlapped with an additional
Vitest run. To serialize them, only the `diary-payment-amounts` Jest process
2894194 and its worker children were sent SIGTERM. The payback gate and all
native agents were left running, and neither branch was edited. The exact
interruption is recorded in `serialized-dogfood-suite.json` beside the
operational runners; the interrupted suite must be rerun serially. This
intervention is not a passing test result.

The initial native pressure gate passed formatting, Clippy with warnings denied,
4,308 unit tests and 190 integration tests, plus its smaller targets. This is
not the final protection build. Before adding exact-ID shielding, the private
intermediate-binary daemon reproduced the missing exemption: healthy memory
left all four sessions live; pressure parked the configured protected Role
while Free, Held and Warm remained live. Its receipt is
`/tmp/aoe-pressure-smoke-_88_gpgx/result.json`, with daemon and private tmux
cleanup confirmed. The small protection contract also failed on the old schema.
The remaining protection tests cover exact IDs, retired IDs, prefix/title
rejection, all automatic shedding paths and differing profile thresholds.

Central integration is deployed with overload recovery disabled. Review of
`592bb5c` found a second-admission race: pressure rising between queued-send
admission and restart admission can turn a deferred restart into a terminal
message failure. The central rollout owner has this blocker and must preserve
the pending action, owner and retry budget before activation. Staged timer names
must use the full loaded IDs listed above, not the missing `research-day7.timer`
or `creators-yt-baseline.timer`. The release runner is prepared to use one Rust
compiler and the shared heavy-job lock. Root disk headroom fell to 5.5 GiB;
request `b16f443b3de9` returned disk recovery to its existing owner, preserving
the shared target cache and all branches. No new release build has started.

## Native pressure and role protection deployed, 8 November 04:52 UTC

The shipping release from `local-defaults` source `f6f36df8` contains feature
`be0de0e6`. Final checks passed formatting, all-target Clippy with warnings denied,
4,309 unit tests, 191 integration tests and both standalone tests. Existing
ignored tests were unchanged. The installed and running daemon SHA-256 is
`c5797cad5eccd10786e5d4477cff80d95b78ded27fd18666790db775226c06ea`.

The private shipping-binary fixture `/tmp/aoe-pressure-smoke-y8_c_qjt/result.json`
passed dashboard-root and entry-asset HTTP checks, healthy memory above the cap,
pressure below the cap with only the eligible idle victim parked, protection for
an older role and scheduled work, and no additional parking after recovery.
Its private daemon and tmux server were cleaned up. The list validator regression
also failed before the fix and passes in the final integration suite.

Installation completed at 2026-11-08 04:52:12 UTC. Dashboard HTTP 200 and
`aoe session verify-pointers` with no violations passed. All 61 native agent
PIDs retained their process start identities through the daemon-only restart.
Live cap is 50, RAM-pressure threshold 85 and protected list length 79. The
04:50:46 UTC role audit covers all 78 required current roles and successors,
retaining one existing non-role entry. The exact release, role-audit, install
and process-preservation receipts are in
`~/.local/state/aoe-oom-recovery/pressure-20261108/`.

The first shipping attempt embedded an empty dashboard because its cached asset
input equaled the build output. Dashboard 404 caused rollback to the previous
binary/config; HTTP 200 returned and all 60 agent identities from that attempt
survived. The stronger private check now rejects that exact bad artifact before
installation. An independent audit verified the replacement cache against the
unchanged tracked web tree, all 11 index references, 1,923 local asset targets
and restored production index/JS/CSS bytes. The corrected release took 21m30s,
with one compiler under the shared heavy-job lock and a 10 GiB memory ceiling.
Seven reviewed old incremental sessions were pruned by the disk owner, freeing
about 10 GiB while retaining newer sessions, lock files and release dependencies.

Central source `0132464` includes the admission-race and cooldown-restoration
regressions. The agents umbrella already pins it in `65aab34`, so no duplicate
pointer bump was made. The controller is `central.service`; the absent
`central-agent.service` must not be diagnosed as a controller outage. Native
installation success was handed to the rollout owner for overload opt-in
and a single restart of the correct controller unit. Activation and independent
live verification are complete as recorded below. No protected-role admission
bypass is authorized.

The original 9 November 00:47:08 UTC observation review and first nightly GC
review remain pending. This deployment does not reset that interval, erase its
already-failed no-new-swap-writes condition or close task #1185/request
`a160433581e8`.

## Overload activation and live verification, 8 November 05:09 UTC

Central PR 169 enabled the controller at `4a8a93aaa1c3a0c7b9cf9909c4764b5999860bdb`,
pinned by agents `7817b6b`. Activation invoked one restart of `central.service`;
PID 216151 remained active, and its health endpoint returned HTTP 200.
The native source and installed binary remain the verified release above.

A passive filesystem observer recorded 25 distinct worker samples across
360.80 seconds. The maximum gap was 15.06 seconds, with no read errors.
The independent check at 05:09:20 UTC found a fresh sample, valid metrics,
59 primary panes in the baseline and healthy admission. The cap remained 50,
RAM-pressure threshold 85 and protected list length 79. No production timer
was paused; both vetted headless timers remained active with their expected
service triggers. Dashboard HTTP 200, controller health and conversation
pointers passed. The snapshot had 18.90 GiB available and load1 4.02 on 16 cores.
This is a healthy-host observation, not an induced production overload.

A separate real user-systemd fixture exercised the controller against synthetic
metrics and a manual clock, without changing production units or host load.
Load 49 on 16 cores denied admission immediately. At 299 seconds no timer
paused; at 300 seconds only the lowest-priority eligible timer paused, while
protected-role and higher-priority timers stayed active. Recovery waited its
60-second action cooldown and resumed only the timer it owned. A manually
inactive unowned timer stayed inactive. The in-flight sleep service retained
its PID and InvocationID through pause/resume, with no restart. Unknown metrics
denied admission. An in-memory disabled load detector produced the expected
failure before the restored controller passed. All nine private fixture units
were cleaned up, the sleep process exited and temporary state/config were
removed; canonical source was unchanged.

Receipts are `activation-20261108T045953Z.json`, `worker-cadence.json`,
`live-verification-receipt.json` and `overload-real-backend-proof.json` in the
pressure recovery state directory. The original memory observation timers
remain active with their unchanged deadline. This completes the native cap,
pressure, role-protection and overload-runtime changes, while the original
24-hour acceptance review, first nightly GC review and task #1185 remain open.

## Central follow-up, 8 November 09:12 UTC

The original work remains a dated wait, not a dependency on another session.
The runtime changes and independent verification above are complete. At this
wake the host had 18,613 MiB available, occupied swap 10,835 MiB and load1 6.31
on 16 cores. These are transient readings, not acceptance of the full day.

The persisted observation has 102 samples spanning 8.38 hours, one boot ID and
a maximum 300-second gap. RAM occupancy peaked at 82.1%. Occupied swap rose
from 9,152 to 10,854 MiB in those samples, and cumulative swap-out increased
by 14,759,785 pages, or 56.30 GiB at the host page size. The existing acceptance
failure therefore remains; these readings include validation and release builds
and must not be reset or described as a clean observation day. Receipt:
`pressure-20261108/interim-20261108T0912Z.json` under the recovery state directory.

Both memory observation/review timers remain active. The original review is
still 2026-11-09 00:47:08 UTC. The first full bounded nightly GC has not run;
`repo-gc.timer` is active and due at 2026-11-08 11:30 UTC. Request
`a160433581e8` is marked waiting until the original review, with task #1185
still open. At that review inspect the complete readings and GC result; if
pressure remains, follow the documented larger-box price decision path.

## Bounded capacity recovery, 8 November 19:43 UTC

Central request `fad7785f86e1` was routed directly to current owner
`3d108d3d1d9c436f`, with historical aliases retained only as history. Root reached
zero user-available bytes and blocked release owner `13814b013c3d40fb` while
adding four small status files. Central durable recovery, answer and plan writes
also reported ENOSPC. No new validation, purchase or provider budget was granted.

A fresh protection review found five older finalized AoE incremental sessions
with newer valid siblings, no cargo/rustc processes and no open incremental
files. Under the shared heavy-job lock, this owner rechecked those conditions
and removed only the five approved session directories. Newer sessions, parent
and lock files, debug/release dependencies, source work, archives, release
fixtures and the 8141 attempts were preserved. No filesystem reserve, provider
limit, spawn hold or service configuration changed.

At 2026-11-08 19:43:05 UTC the bounded cleanup increased user-available capacity
by 5,443,088,384 bytes, to 5,453,668,352 bytes. A 1 MiB file write and fsync
passed as the ordinary user. The exact paths, preserved sibling paths and dated
capacity receipt are `pressure-20261108/capacity-fad7785f86e1-20261108.json` under
the recovery state directory. Proof was sent directly to release owner 13814b
and io delivery owner `313f2dcdaf754006`, explicitly without new validation
approval. Separate io-state cleanup reported 15,376,384 bytes from completed
fixtures; that smaller concurrent reclamation was not this owner's cleanup.

Same-session router restoration was authorized for `267fc6f3517e46bf`, but
process inspection found it already alive: pane shell 2368957, wrapper 2369027
and native Codex 2369116, with exact `AOE_INSTANCE_ID=267fc6f3517e46bf` and
non-zombie state. Stored AoE status was idle. No restart, successor, duplicate,
queue clearing or manual vital clearing was performed. The dated process tree
is in `pressure-20261108/router-267-live-process-20261108.json`. Binding and
retained delivery remain with io owner 313. This capacity request is complete;
the original OOM observation request and its existing review remain separate.
