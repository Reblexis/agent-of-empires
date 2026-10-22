// LOCAL PATCH: this deployment runs a locally patched build (branch
// local-defaults in ~/src/agent-of-empires), so the stock self-update would
// overwrite every local fix. The update banner's action is therefore "hand
// an AI agent the rebase job", not "install": clicking copies this prompt.
export function agentUpdatePrompt(latest: string): string {
  return (
    `aoe v${latest} is out. Update my locally patched aoe WITHOUT the built-in ` +
    `updater (it would overwrite the local fixes): run ` +
    `~/src/aoe-sessions/bin/aoe-update-local v${latest}. If the rebase of ` +
    `local-defaults in ~/src/agent-of-empires conflicts, resolve the conflicts ` +
    `preserving the local patches, run the web tests, then finish the script's ` +
    `remaining steps (cargo build --release --features serve, install to ` +
    `~/.local/bin/aoe, systemctl --user restart aoe-serve) and verify the ` +
    `daemon reports v${latest}. Details: ~/src/aoe-sessions/README.md.`
  );
}
