import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "../helpers/liveTest";
import { appDirFor, resolveAoeBinary, seedSessionViaAoeAdd } from "../helpers/aoeServe";
import { clickSidebarSession } from "../helpers/sidebar";

const token = "synthetic-read-credential";
test("planner is authenticated, read-only, redacted and fails closed", async ({ spawnServe, page }, info) => {
  const requests: string[] = [];
  let mode = "ok";
  const upstream = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    res.setHeader("Content-Type", "application/json");
    if (mode === "denied") {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: token }));
      return;
    }
    if (mode === "timeout") return;
    if (mode === "disconnect") {
      req.socket.destroy();
      return;
    }
    const query = new URL(req.url!, "http://localhost").searchParams;
    if (mode === "projection") {
      const row = { id: "shared", number: 4, title: "Shared instance", status: "open", startDate: null, dueDate: null };
      res.end(
        JSON.stringify(
          query.has("usage")
            ? { timeZone: "UTC" }
            : { tasks: [row, { ...row, id: "done", status: "done" }, { ...row, id: "template", isTemplate: true }] },
        ),
      );
      return;
    }
    if (mode.startsWith("truncated")) {
      const status = mode.split(":")[1];
      res.end(
        JSON.stringify(
          query.has("usage")
            ? { timeZone: "UTC" }
            : {
                tasks:
                  query.get("status") === status
                    ? Array.from({ length: 500 }, (_, i) => ({
                        id: `row-${i}`,
                        number: i + 1,
                        title: "Synthetic row",
                        status: "open",
                      }))
                    : [],
              },
        ),
      );
      return;
    }
    if (mode.startsWith("invalid:")) {
      const field = mode.split(":")[1];
      const invalid = { id: "", number: 0, title: "x".repeat(801), status: "unknown", priority: -1 };
      const row = {
        id: "a",
        number: 1,
        title: "Synthetic",
        status: "open",
        [field]: invalid[field as keyof typeof invalid],
      };
      res.end(
        JSON.stringify(
          query.has("usage") ? { timeZone: field === "timeZone" ? "x".repeat(101) : "UTC" } : { tasks: [row] },
        ),
      );
      return;
    }
    if (mode === "redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "/followed");
      res.end();
      return;
    }
    if (mode === "malformed") {
      res.end("invalid JSON");
      return;
    }
    if (mode === "schema") {
      res.end("{}");
      return;
    }
    if (mode === "oversized") {
      res.end(" ".repeat(2 * 1024 * 1024 + 1));
      return;
    }
    const q = new URL(req.url!, "http://localhost").searchParams;
    res.end(
      JSON.stringify(
        q.has("usage")
          ? { timeZone: "America/Los_Angeles", secret: token }
          : {
              count: q.get("status") === "open" ? 1 : 0,
              tasks:
                q.get("status") === "open"
                  ? [
                      {
                        id: "synthetic",
                        number: 42,
                        title: "Synthetic appointment",
                        startDate: "2026-10-26T14:00",
                        dueDate: "2026-10-26T15:00",
                        status: "open",
                        priority: 5,
                        description: token,
                        arbitrarySecret: token,
                      },
                    ]
                  : [],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  try {
    const serve = await spawnServe({
      authMode: "token",
      readOnly: true,
      seedFn: (seed) => {
        seedSessionViaAoeAdd({ title: "Planner-synthetic" })(seed);
        const { home, env } = seed;
        const file = join(home, "planner-read-token");
        writeFileSync(file, token, { mode: 0o600 });
        Object.assign(env, { AOE_PLANNER_URL: `http://127.0.0.1:${port}/tasks`, AOE_PLANNER_READ_TOKEN_FILE: file });
      },
    });
    const url = `${serve.baseUrl}/api/planner/timeline`;
    expect((await fetch(url)).status).toBe(401);
    const headers = { Authorization: `Bearer ${serve.authToken}` };
    const response = await fetch(`${url}?token=never-forward&url=http://evil.invalid`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(JSON.parse(body)).toMatchObject({
      timeZone: "America/Los_Angeles",
      truncated: false,
      tasks: [{ id: "synthetic", title: "Synthetic appointment" }],
    });
    for (const method of ["POST", "PATCH", "DELETE", "PUT"])
      expect((await fetch(url, { method, headers })).status).toBe(405);
    expect(requests.sort()).toEqual(
      ["GET /tasks?limit=500&status=missed", "GET /tasks?limit=500&status=open", "GET /tasks?usage=1"].sort(),
    );
    for (const failureMode of [
      "denied",
      "redirect",
      "malformed",
      "schema",
      "oversized",
      "disconnect",
      "timeout",
      "invalid:id",
      "invalid:number",
      "invalid:title",
      "invalid:status",
      "invalid:priority",
      "invalid:timeZone",
    ]) {
      mode = failureMode;
      const failure = await fetch(url, { headers });
      expect(failure.status, failureMode).toBe(502);
      expect(await failure.text()).not.toContain(token);
    }
    expect(requests.some((request) => request.includes("/followed"))).toBe(false);
    mode = "projection";
    expect((await (await fetch(url, { headers })).json()).tasks.map((task: { id: string }) => task.id)).toEqual([
      "shared",
    ]);
    for (const status of ["open", "missed"]) {
      mode = `truncated:${status}`;
      expect((await (await fetch(url, { headers })).json()).truncated).toBe(true);
    }
    mode = "ok";
    await page.clock.install({ time: new Date("2026-10-26T20:30:00Z") });
    await page.goto(`${serve.baseUrl}/?token=${serve.authToken}`);
    await clickSidebarSession(page, "Planner-synthetic");
    await page.getByTestId("pane-tab-timeline").click();
    await expect(page.getByTestId("planner-timeline").getByText(/Synthetic appointment/)).toBeVisible();
    await expect(page.getByTestId("timeline-now")).toContainText("13:30");
    await expect(page.getByText("America/Los_Angeles", { exact: true })).toBeVisible();
    await page.locator('[data-pane-dock="right"]').screenshot({ path: info.outputPath("timeline-desktop.png") });
    mode = "denied";
    await page.clock.fastForward(60_000);
    await expect(page.getByText(/Stale, updated/)).toBeVisible();
    await expect(page.getByTestId("planner-timeline").getByText(/Synthetic appointment/)).toBeVisible();
    mode = "ok";
    await page.clock.fastForward(60_000);
    await expect(page.getByText(/Stale, updated/)).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await page.clock.runFor(400);
    await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
    await page.clock.runFor(400);
    await page.getByTestId("mobile-right-panel-pick-timeline").click();
    await page.clock.runFor(400);
    await expect(page.getByTestId("mobile-right-panel-picker")).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByTestId("planner-timeline").getByText(/Synthetic appointment/)).toBeVisible();
    await page.screenshot({ path: info.outputPath("timeline-mobile.png") });
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("timeline tab survives navigation, reload and mobile with an honest unavailable state", async ({
  page,
  spawnServe,
}) => {
  const serve = await spawnServe({
    seedFn: async (env) => {
      await seedSessionViaAoeAdd({ title: "Timeline-one" })(env);
      await seedSessionViaAoeAdd({ title: "Timeline-two" })(env);
    },
  });
  await page.goto(serve.baseUrl);
  await clickSidebarSession(page, "Timeline-one");
  const tab = page.getByTestId("pane-tab-timeline");
  await tab.click();
  await expect(page.getByText("Timeline unavailable", { exact: true })).toBeVisible();
  await clickSidebarSession(page, "Timeline-two");
  await expect(tab).toBeVisible();
  await clickSidebarSession(page, "Timeline-one");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close timeline", exact: true }).click();
  await page.reload();
  await expect(tab).toHaveCount(0);
  await page.getByRole("button", { name: "Toggle timeline pane", exact: true }).click();
  await expect(tab).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  // The same registry supplies the mobile pane picker, without a second navigation system.
  await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
  await page.getByRole("button", { name: "Timeline", exact: true }).click();
  await expect(page.getByText("Timeline unavailable", { exact: true })).toBeVisible();
});

test("planner configuration and credentials fail closed before any outbound read", async ({ spawnServe }) => {
  let outbound = 0;
  const upstream = createServer((req, res) => {
    outbound++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url?.includes("usage") ? { timeZone: "UTC" } : { tasks: [] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/tasks`;
  try {
    const serve = await spawnServe({
      seedFn: ({ home, env }) => {
        const file = join(home, "planner-token");
        writeFileSync(file, "synthetic", { mode: 0o600 });
        Object.assign(env, { AOE_PLANNER_URL: "", AOE_PLANNER_READ_TOKEN_FILE: file });
      },
    });
    const response = await fetch(`${serve.baseUrl}/api/planner/timeline`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "planner_not_configured" });
    for (const endpoint of [
      "http://example.invalid/tasks",
      `http://user@127.0.0.1:${port}/tasks`,
      `${base}?token=synthetic`,
      `${base}#fragment`,
      "not-a-url",
    ]) {
      const fixture = await spawnServe({
        seedFn: ({ home, env }) => {
          const file = join(home, "planner-token");
          writeFileSync(file, "synthetic", { mode: 0o600 });
          Object.assign(env, { AOE_PLANNER_URL: endpoint, AOE_PLANNER_READ_TOKEN_FILE: file });
        },
      });
      const result = await fetch(`${fixture.baseUrl}/api/planner/timeline`);
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({ error: "planner_unavailable" });
      await fixture.stop();
    }
    for (const contents of [null, "", "synthetic\nsecond-line"]) {
      const fixture = await spawnServe({
        seedFn: ({ home, env }) => {
          const file = join(home, "planner-token");
          if (contents !== null) writeFileSync(file, contents, { mode: 0o600 });
          Object.assign(env, { AOE_PLANNER_URL: base, AOE_PLANNER_READ_TOKEN_FILE: file });
        },
      });
      const result = await fetch(`${fixture.baseUrl}/api/planner/timeline`);
      expect(result.status).toBe(502);
      expect(await result.json()).toEqual({ error: "planner_unavailable" });
      await fixture.stop();
    }
    expect(outbound).toBe(0);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("CityHall refuses the planner endpoint", async ({ spawnServe, page }) => {
  const serve = await spawnServe({
    extraArgs: ["--cityhall"],
    acp: true,
    seedFn: (env) => {
      seedSessionViaAoeAdd({ title: "CityHall-synthetic" })(env);
      const profiles = join(appDirFor(env.home, env.xdg, resolveAoeBinary()), "profiles");
      const file = readdirSync(profiles)
        .map((name) => join(profiles, name, "sessions.json"))
        .find(existsSync)!;
      const sessions = JSON.parse(readFileSync(file, "utf8"));
      sessions[0].view = "structured";
      writeFileSync(file, JSON.stringify(sessions));
    },
  });
  expect((await fetch(`${serve.baseUrl}/api/planner/timeline`)).status).toBe(403);
  await page.goto(serve.baseUrl);
  await clickSidebarSession(page, "CityHall-synthetic");
  await expect(page.getByTestId("pane-tab-timeline")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Toggle timeline pane", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Toggle panels", exact: true }).click();
  await expect(page.getByTestId("mobile-right-panel-picker")).toBeVisible();
  await expect(page.getByTestId("mobile-right-panel-pick-timeline")).toHaveCount(0);
});
