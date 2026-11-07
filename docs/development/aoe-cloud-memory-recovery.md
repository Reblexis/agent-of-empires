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

## Pending evidence

- Finish the full suite and release build; deploy only
  the complete `local-defaults` branch and verify conversation pointers.
- Start a complete day after deployment and validation finish. The persistent
  review timer must wake the continuation owner and current keeper above,
  never the stopped original sessions.
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
created group-writable temporary directories and failed their security checks.
The same login and UDS tests passed with umask 077, without a source change.
