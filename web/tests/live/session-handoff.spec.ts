import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDirFor, listSessions, resolveAoeBinary, seedSessionViaAoeAdd, spawnAoeServe } from "../helpers/aoeServe";

test("missing Claude-to-Codex button hands the conversation over with one click", async ({ page }, info) => {
  const parentSid = "11111111-2222-4333-8444-555555555555";
  let sessionsPath = "";
  let parentId = "";
  let transcript = "";
  const serve = await spawnAoeServe({
    authMode: "none",
    workerIndex: info.workerIndex,
    parallelIndex: info.parallelIndex,
    seedFn: (seed) => {
      seedSessionViaAoeAdd({ title: "Handoff source" })(seed);
      const profiles = join(appDirFor(seed.home, seed.xdg, resolveAoeBinary()), "profiles");
      sessionsPath = readdirSync(profiles)
        .map((p) => join(profiles, p, "sessions.json"))
        .find(existsSync)!;
      const sessions = JSON.parse(readFileSync(sessionsPath, "utf8"));
      const parent = sessions[0];
      parentId = parent.id;
      parent.agent_session_id = parentSid;
      parent.resume_intent = { kind: "Use", value: parentSid };
      writeFileSync(sessionsPath, JSON.stringify(sessions));
      const dir = join(seed.home, ".claude/projects", parent.project_path.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      transcript = join(dir, `${parentSid}.jsonl`);
      writeFileSync(
        transcript,
        JSON.stringify({
          type: "user",
          sessionId: parentSid,
          message: { role: "user", content: "Fixture conversation" },
        }) + "\n",
      );
      writeFileSync(
        join(seed.shimBin, "codex"),
        '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.100.0"; exit 0;; esac\nprintf "%s\\n" "$@" >> "$HOME/handoff-args"\nexec tail -f /dev/null\n',
        { mode: 0o755 },
      );
    },
  });
  try {
    await page.goto(`${serve.baseUrl}/`);
    await page.locator('[data-testid="sidebar-session-row"]').filter({ hasText: "Handoff source" }).click();
    const button = page.getByRole("button", { name: "Continue in codex", exact: true });
    await expect(button).toBeVisible({ timeout: 10_000 });
    const response = page.waitForResponse((r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST");
    await button.click();
    const created = await response;
    expect(created.ok(), await created.text()).toBe(true);
    const child = await created.json();
    expect(child.tool).toBe("codex");
    expect(child.id).not.toBe(parentId);
    await expect
      .poll(
        () => {
          const path = join(serve.home, "handoff-args");
          return existsSync(path) ? readFileSync(path, "utf8") : "";
        },
        { timeout: 20_000 },
      )
      .toContain("continue-claude-session");
    const args = readFileSync(join(serve.home, "handoff-args"), "utf8");
    expect(args).toContain(transcript);
    expect(args).toContain(parentSid);
    const stored = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(stored.find((s: { id: string }) => s.id === child.id).resume_intent?.kind ?? "Default").toBe("Default");
    expect(stored.find((s: { id: string }) => s.id === parentId).agent_session_id).toBe(parentSid);
    expect((await listSessions(serve.baseUrl)).map((s) => s.id)).toEqual(expect.arrayContaining([parentId, child.id]));
  } finally {
    await serve.stop();
  }
});
