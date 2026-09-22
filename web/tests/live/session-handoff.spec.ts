import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDirFor, listSessions, resolveAoeBinary, seedSessionViaAoeAdd, spawnAoeServe } from "../helpers/aoeServe";

for (const [source, target, flag] of [
  ["claude", "codex", "--dangerously-bypass-approvals-and-sandbox"],
  ["codex", "claude", "--dangerously-skip-permissions"],
]) {
  test(`${source}-to-${target} handoff launches with full permission bypass`, async ({ page }, info) => {
    const parentSid = "11111111-2222-4333-8444-555555555555";
    let sessionsPath = "";
    let parentId = "";
    let transcript = "";
    const serve = await spawnAoeServe({
      authMode: "none",
      workerIndex: info.workerIndex,
      parallelIndex: info.parallelIndex,
      seedFn: (seed) => {
        seedSessionViaAoeAdd({ title: "Handoff source", tool: source })(seed);
        const profiles = join(appDirFor(seed.home, seed.xdg, resolveAoeBinary()), "profiles");
        sessionsPath = readdirSync(profiles)
          .map((p) => join(profiles, p, "sessions.json"))
          .find(existsSync)!;
        const sessions = JSON.parse(readFileSync(sessionsPath, "utf8"));
        const parent = sessions[0];
        parentId = parent.id;
        parent.agent_session_id = parentSid;
        parent.yolo_mode = false;
        parent.resume_intent = { kind: "Use", value: parentSid };
        writeFileSync(sessionsPath, JSON.stringify(sessions));
        const dir =
          source === "claude"
            ? join(seed.home, ".claude/projects", parent.project_path.replace(/[^a-zA-Z0-9]/g, "-"))
            : join(seed.home, ".codex/sessions/2026/09/22");
        mkdirSync(dir, { recursive: true });
        transcript = join(
          dir,
          source === "claude" ? `${parentSid}.jsonl` : `rollout-2026-09-22T12-00-00-${parentSid}.jsonl`,
        );
        writeFileSync(
          transcript,
          JSON.stringify({
            type: "user",
            sessionId: parentSid,
            message: { role: "user", content: "Fixture conversation" },
          }) + "\n",
        );
        writeFileSync(
          join(seed.shimBin, target),
          '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.100.0"; exit 0;; esac\nprintf "%s\\n" "$@" >> "$HOME/handoff-args"\nexec tail -f /dev/null\n',
          { mode: 0o755 },
        );
      },
    });
    try {
      await page.goto(`${serve.baseUrl}/`);
      await page.locator('[data-testid="sidebar-session-row"]').filter({ hasText: "Handoff source" }).click();
      const button = page.getByRole("button", { name: `Continue in ${target}`, exact: true });
      await expect(button).toBeVisible({ timeout: 10_000 });
      const response = page.waitForResponse(
        (r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST",
      );
      await button.click();
      const created = await response;
      expect(created.ok(), await created.text()).toBe(true);
      const child = await created.json();
      expect(child.tool).toBe(target);
      expect(child.id).not.toBe(parentId);
      await expect
        .poll(
          () => {
            const path = join(serve.home, "handoff-args");
            return existsSync(path) ? readFileSync(path, "utf8") : "";
          },
          { timeout: 20_000 },
        )
        .toContain(`continue-${source}-session`);
      const args = readFileSync(join(serve.home, "handoff-args"), "utf8");
      expect(args.split("\n")).toContain(flag);
      expect(args).toContain(transcript);
      expect(args).toContain(parentSid);
      const stored = JSON.parse(readFileSync(sessionsPath, "utf8"));
      expect(stored.find((s: { id: string }) => s.id === child.id).yolo_mode).toBe(true);
      expect(stored.find((s: { id: string }) => s.id === parentId).yolo_mode).toBe(false);
      expect(stored.find((s: { id: string }) => s.id === child.id).resume_intent?.kind ?? "Default").toBe("Default");
      expect(stored.find((s: { id: string }) => s.id === parentId).agent_session_id).toBe(parentSid);
      expect((await listSessions(serve.baseUrl)).map((s) => s.id)).toEqual(
        expect.arrayContaining([parentId, child.id]),
      );
    } finally {
      await serve.stop();
    }
  });
}
