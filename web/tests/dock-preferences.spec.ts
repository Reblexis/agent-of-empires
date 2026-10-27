import { test, expect } from "./helpers/mockedTest";
import { mockTerminalApis } from "./helpers/terminal-mocks";

test("the selected dock tab follows session switches and reload without the old starter tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockTerminalApis(page, { extraSessions: [{ id: "other", title: "Other session" }] });
  await page.route("**/api/sessions/*/terminal-context", (route) =>
    route.fulfill({ json: { text: "Cached recap", generated_at: "2099-01-01T00:00:00Z" } }),
  );
  await page.addInitScript(() => {
    if (localStorage.getItem("dock-test-seeded")) return;
    const layout = {
      right: [{ tabs: ["diff", "terminal:0", "context", "timeline"], active: "context" }],
      bottom: [],
      nextTerminalIndex: 1,
      closedPlugins: [],
      collapsed: { right: false, bottom: false },
    };
    localStorage.setItem(
      "aoe-pane-layout-v2",
      JSON.stringify({ version: 2, template: layout, sessions: { "pinch-test": layout, other: layout } }),
    );
    localStorage.setItem("dock-test-seeded", "1");
  });
  await page.goto("/session/pinch-test");
  await expect(page.getByTestId("pane-tab-context")).toBeVisible();
  await expect(page.getByTestId("pane-tab-diff")).toHaveCount(0);
  await expect(page.getByTestId("pane-tab-terminal:0")).toHaveCount(0);
  await page.getByTestId("pane-tab-timeline").click();
  await expect(page.getByTestId("planner-timeline")).toBeVisible();
  await page.locator('a[href="/session/other"]').first().click();
  await expect(page).toHaveURL(/\/session\/other/);
  await expect(page.getByTestId("planner-timeline")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("planner-timeline")).toBeVisible();
  await page.getByTestId("pane-toggle-diff").click();
  await expect(page.getByTestId("pane-tab-diff")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("pane-tab-diff")).toBeVisible();
});

test("a remembered mobile plugin waits for its snapshot and falls back when unavailable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTerminalApis(page);
  await page.addInitScript(() => localStorage.setItem("aoe-mobile-panel", "plugin:acme.demo:demo"));
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/plugins/ui-state", async (route) => {
    await ready;
    await route.fulfill({
      json: {
        entries: [
          {
            plugin_id: "acme.demo",
            slot: "pane",
            id: "demo",
            session_id: "pinch-test",
            payload: { title: "Demo", blocks: [{ kind: "heading", text: "Demo content" }] },
          },
        ],
        notifications: [],
        pages: [],
      },
    });
  });
  await page.goto("/session/pinch-test");
  await expect(page.getByTestId("sidebar-session-row")).toBeAttached();
  release();
  await expect(page.getByTestId("mobile-plugin-layer")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("mobile-plugin-layer")).toBeVisible();
  await page.route("**/api/plugins/ui-state", (route) =>
    route.fulfill({ json: { entries: [], notifications: [], pages: [] } }),
  );
  await page.reload();
  await expect(page.locator("[data-live-terminal]").first()).toBeVisible();
  await expect(page.getByTestId("mobile-plugin-layer")).toHaveCount(0);
});

test("mobile keeps Timeline and Context across session switches and reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTerminalApis(page, { extraSessions: [{ id: "other", title: "Other session" }] });
  await page.route("**/api/sessions/*/terminal-context", (route) =>
    route.fulfill({ json: { text: "Cached recap", generated_at: "2099-01-01T00:00:00Z" } }),
  );
  await page.goto("/session/pinch-test");
  for (const panel of ["Timeline", "Context"]) {
    await page.getByRole("button", { name: "Toggle panels" }).click();
    await page.getByTestId("mobile-right-panel-picker").getByRole("button", { name: panel, exact: true }).click();
    const body =
      panel === "Timeline" ? page.getByTestId("planner-timeline") : page.getByText("Cached recap", { exact: true });
    await expect(body).toBeVisible();
    await page.getByRole("button", { name: /^Toggle sidebar/ }).click();
    const id = panel === "Timeline" ? "other" : "pinch-test";
    await page.locator(`a[href="/session/${id}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/session/${id}`));
    await expect(body).toBeVisible();
    await page.reload();
    await expect(body).toBeVisible();
  }
});
