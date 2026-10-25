import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../helpers/liveTest";
import { appDirFor, resolveAoeBinary, seedSessionViaAoeAdd, waitForSessions } from "../helpers/aoeServe";
import { clickSidebarSession } from "../helpers/sidebar";

test("context keeps the session goal and carries it into the next recap", async ({ page, spawnServe }) => {
  const serve = await spawnServe({
    seedFn: async (env) => {
      const config = join(appDirFor(env.home, env.xdg, resolveAoeBinary()), "config.toml");
      writeFileSync(config, `${readFileSync(config, "utf8")}\n[session]\nsmart_rename_agent = "codex"\n`);
      writeFileSync(
        join(env.shimBin, "codex"),
        `#!/usr/bin/env python3
import json, os, pathlib, sys
prompt = next((a for a in sys.argv if a.startswith("You are given the terminal scrollback")), None)
if prompt is None:
    print("codex-cli 0.1.0")
    sys.exit(0)
path = pathlib.Path(os.environ["HOME"]) / "context-prompts.jsonl"
with path.open("a") as out:
    out.write(json.dumps(prompt) + "\\n")
print("Goal: Prepare the creator product for customers.\\n\\nVerified the invitation links. Deployment is pending.")
`,
        { mode: 0o755 },
      );
      await seedSessionViaAoeAdd({
        title: "Creator-launch-readiness",
        agentScript:
          "#!/bin/sh\nprintf 'User: Prepare the creator product for customers.\\nAgent: Fixed an invitation link.\\n'\nexec cat\n",
      })(env);
    },
  });
  const session = (await waitForSessions(serve.baseUrl)).find((s) => s.title === "Creator-launch-readiness")!;
  const endpoint = `${serve.baseUrl}/api/sessions/${session.id}`;
  const ensure = await fetch(`${endpoint}/ensure`, { method: "POST" });
  expect(ensure.status).toBe(200);
  await ensure.body?.cancel();

  const snapshot = async () => {
    const response = await fetch(`${endpoint}/terminal-context`);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ text: string | null; inflight: boolean; generated_at: string | null }>;
  };
  for (let generation = 0; generation < 2; generation++) {
    const previous = await snapshot();
    const response = await fetch(`${endpoint}/terminal-context`, { method: "POST" });
    expect(response.status).toBe(202);
    await response.body?.cancel();
    await expect
      .poll(async () => {
        const current = await snapshot();
        return !current.inflight && current.generated_at !== previous.generated_at && current.text?.startsWith("Goal:");
      })
      .toBe(true);
  }

  const prompts = readFileSync(join(serve.home, "context-prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string);
  expect(prompts).toHaveLength(2);
  for (const prompt of prompts) {
    expect(prompt).toContain("Session title (a hint):\nCreator-launch-readiness");
    expect(prompt).toContain("User: Prepare the creator product for customers.");
  }
  expect(prompts[1]).toContain("Previous recap (retain its overall goal");
  expect(prompts[1]).toContain("Goal: Prepare the creator product for customers.");

  await page.goto(serve.baseUrl);
  await clickSidebarSession(page, "Creator-launch-readiness");
  await expect(page.getByText("Goal", { exact: true })).toBeVisible();
  await expect(page.getByText("Prepare the creator product for customers.", { exact: true })).toBeVisible();
  await expect(page.getByText("Verified the invitation links. Deployment is pending.", { exact: true })).toBeVisible();
  await expect(page.getByText("Last ask", { exact: true })).toHaveCount(0);
});
