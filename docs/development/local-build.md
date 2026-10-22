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

    for b in session-hibernation; do
      git merge-base --is-ancestor "$b" HEAD || echo "MISSING: $b"
    done

Add a branch to that list when you deploy it. Any `MISSING` line stops the
deploy.

## Tab tracking is a hard requirement

Viktor, 2026-09-23, after the second occurrence: "thsi already happened before
and i thought we fixed it - apparently not.. so add safeguards on top ensuring
trackability and correct trackingo ftabs is 100% guaranteed". The contract that
answers it is in [session-resume.md](../guides/session-resume.md), "How the
conversation ID stays correct". After any deploy, `aoe session verify-pointers`
must print no violations.
