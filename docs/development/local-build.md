# The locally deployed build

The daemon on Viktor's machine (`aoe-serve.service`, running `~/.local/bin/aoe`)
is built from exactly one branch: **`local-defaults`**. Nothing else is ever
installed there.

## Rule: a fix is not deployed until it is on `local-defaults`

Every fix or feature branch that should run on the machine is merged into
`local-defaults` first, and the binary is built from `local-defaults`. Building
and installing from a side branch is forbidden, because the next deploy from
`local-defaults` silently removes whatever that side branch carried.

This happened on 2026-09-22: the one-shot isolation fix (`c9c41b27`, branch
`session-hibernation`) and the paste fix (`b9030c2f`) had been installed from
`session-hibernation`, then a handoff deploy from `local-defaults` replaced the
binary without them. After the next reboot the context-recap one-shots wrote
their transcripts into project directories again and about 60 tabs resumed the
wrong conversation. Both branches were merged into `local-defaults` on
2026-09-23.

## Before installing a new binary

Check that every branch that was ever deployed is contained in what you build:

    git fetch origin
    for b in port-context port-session port-handoff port-forecast-priority port-misc port-terminal port-terminal-input; do
      git merge-base --is-ancestor "origin/$b" HEAD || echo "MISSING: $b"
    done

Add a branch to that list when you deploy it, and push it first: the check reads
`origin/`, because a merged branch's local copy may already be deleted. Any
`MISSING` line stops the deploy.

## Upstream base and how to move it

`local-defaults` is upstream `v1.21.0` plus the local features, re-applied on
2026-10-22 (the v1.15.0 build stays on branch `local-defaults-v1.15`). Branches
merged before that move (`session-hibernation`, `session-priority`,
`fix-terminal-jump-up`, `fix-terminal-jump-up-2`, `fix-terminal-jump-up-3`) were
ported as new commits, so they are not ancestors and left the list above; their
`port-*` successors replace them.

To move to a newer upstream release: port each local feature onto the release in
its own `port-*` branch (cherry-pick, or re-implement where upstream rewrote the
code, keeping the feature's docs and tests), merge them into one branch, run the
full test suites against a clean build of the release so failures that are not
ours are known, then make that branch `local-defaults`. Prefer upstream wherever
it now does what a local commit did, and record which commit was dropped for
which upstream one.

Config that the v1.21.0 build needs on this machine:
`acp.default_new_session_view = "terminal"` (replaces the local commit that
defaulted new web sessions to the terminal view) and
`session.claude_inline_tui = true`.

## Tab tracking is a hard requirement

Viktor, 2026-09-23, after the second occurrence: "thsi already happened before
and i thought we fixed it - apparently not.. so add safeguards on top ensuring
trackability and correct trackingo ftabs is 100% guaranteed". The contract that
answers it is in [session-resume.md](../guides/session-resume.md), "How the
conversation ID stays correct". After any deploy, `aoe session verify-pointers`
must print no violations.
