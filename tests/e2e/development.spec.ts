import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";

test("Git session → edited reviewed entry → existing invoice draft, with mobile and accessibility checks", async ({
  page,
}) => {
  const { token } = JSON.parse(
    await readFile(".local/development-e2e.json", "utf8"),
  );
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
  // Clients and projects are real owned records; upload simulates the native boundary.
  const request = async (path: string, data: unknown, method = "POST") => {
    const r = await page.request.fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID(),
      },
      data,
    });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const client = await request("/api/v1/clients", {
    name: "Acme acceptance",
    email: "acme@example.test",
  });
  const project = await request("/api/v1/projects", {
    clientId: client.id,
    name: "Customer dashboard",
    model: "hourly",
    rate: 7500,
  });
  const repository = await request("/api/v1/repositories", {
    projectId: project.id,
    identity: `local/${randomUUID()}`,
    alias: "acme-dashboard",
  });
  await request(
    `/api/v1/repositories/${repository.id}`,
    {
      version: 1,
      projectId: project.id,
      trackingEnabled: true,
      billable: true,
      rules: [],
    },
    "PATCH",
  );
  const start = Date.now() - 86400000;
  const session = {
    id: randomUUID(),
    repositoryId: repository.id,
    branch: "feature/analytics-charts",
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 5100000).toISOString(),
    inferredSeconds: 5100,
    evidence: Array.from({ length: 171 }, (_, i) => ({
      at: new Date(start + i * 30000).toISOString(),
      kind: "file_activity",
      detail: "File metadata changed",
    })),
  };
  await request("/api/v1/development-sessions", session);
  await page.goto("/development");
  const card = page.getByRole("article", {
    name: "Session acme-dashboard feature/analytics-charts",
  });
  await expect(card.getByLabel("Duration in minutes")).toHaveValue("85");
  await expect(card).toContainText("$106.25");
  await card
    .getByLabel("Invoice-ready description")
    .fill("Developed and reviewed analytics dashboard charts.");
  await card.getByLabel("Duration in minutes").fill("80");
  await card.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(card.getByLabel("Duration in minutes")).toHaveValue("80");
  await expect(card.getByLabel("Invoice-ready description")).toHaveValue(
    "Developed and reviewed analytics dashboard charts.",
  );
  await request("/api/v1/development-sessions", session);
  await page.reload();
  await expect(card.getByLabel("Duration in minutes")).toHaveValue("80");
  await card.getByLabel("Duration in minutes").fill("85");
  await page.screenshot({
    path: "test-results/development-desktop.png",
    fullPage: true,
  });
  const axe = await new AxeBuilder({ page }).include("#main").analyze();
  expect(axe.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card.getByLabel("Invoice-ready description")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/development-mobile.png",
    fullPage: true,
  });
  await card
    .getByRole("button", { name: "Approve time entry", exact: true })
    .click();
  await expect(card).toHaveCount(0);
  await page.getByLabel("Approval status").selectOption("approved");
  await expect(page.getByRole("article")).toContainText(
    "Developed and reviewed analytics dashboard charts.",
  );
  const list = await (
    await page.request.get("/api/v1/development-sessions", {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  const entry = list.find(
    (s: { id: string }) => s.id === session.id,
  ).time_entry_id;
  expect(entry).toBeTruthy();
  const invoice = await request("/api/v1/invoices", {
    clientId: client.id,
    timeEntryIds: [entry],
  });
  expect(invoice.total).toBe(10625);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/invoice/${invoice.id}`);
  await expect(
    page.getByText("$106.25", { exact: true }).first(),
  ).toBeVisible();
  // Approval is time only: invoice issuance and payment still require separate review.
  expect(invoice.issuance_state).toBe("local");
  expect(invoice.collection_state).toBe("unpaid");
});

test("native bridge synchronizes a stable session and local pause works offline", async ({
  page,
}) => {
  const { token } = JSON.parse(
    await readFile(".local/development-e2e.json", "utf8"),
  );
  await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });
  const request = async (path: string, data: unknown, method = "POST") => {
    const response = await page.request.fetch(path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID(),
      },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const client = await request("/api/v1/clients", {
    name: "Native client",
    email: "native@example.test",
  });
  const project = await request("/api/v1/projects", {
    clientId: client.id,
    name: "Native project",
    model: "hourly",
    rate: 7500,
  });
  const repo = await request("/api/v1/repositories", {
    identity: `local/${randomUUID()}`,
    alias: "native-repo",
    projectId: project.id,
  });
  await request(
    `/api/v1/repositories/${repo.id}`,
    {
      projectId: project.id,
      billable: true,
      trackingEnabled: true,
      rules: [],
      version: 1,
    },
    "PATCH",
  );
  const localId = randomUUID(),
    id = randomUUID(),
    start = Math.floor(Date.now() / 1000) - 2 * 86400;
  const local = {
    repositories: [
      {
        id: localId,
        serverId: repo.id,
        identity: repo.identity,
        name: "native-repo",
        path: "/approved/test/repo",
        branch: "fix/native-bridge",
        defaultBranch: "main",
        remote: null,
        mode: "assisted",
        lastActivity: start + 300,
        error: null,
      },
    ],
    sessions: [
      {
        id,
        repositoryId: localId,
        branch: "fix/native-bridge",
        startedAt: start,
        endedAt: start + 300,
        inferredSeconds: 300,
        state: "completed",
        evidence: Array.from({ length: 11 }, (_, n) => ({
          at: start + n * 30,
          kind: "file_activity",
          detail: "File metadata changed",
        })),
      },
    ],
    settings: { idleSeconds: 600, mergeSeconds: 300, minimumSeconds: 300 },
  };
  await page.addInitScript(
    ({ initial, token }) => {
      const browser = window as typeof window & {
        isTauri: boolean;
        trackingOffline: boolean;
        localTracking: typeof initial;
        __TAURI_INTERNALS__: {
          invoke: (cmd: string, args: any) => Promise<any>;
        };
      };
      browser.isTauri = true;
      browser.trackingOffline = false;
      browser.localTracking = initial;
      browser.__TAURI_INTERNALS__ = {
        invoke: async (cmd, args) => {
          if (cmd === "api_request") {
            if (browser.trackingOffline)
              throw "Offline test: server unavailable";
            const response = await fetch(args.path, {
              method: args.method,
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                ...(args.key ? { "Idempotency-Key": args.key } : {}),
              },
              ...(args.body ? { body: JSON.stringify(args.body) } : {}),
            });
            const body = await response.json();
            if (!response.ok) throw JSON.stringify(body);
            return body;
          }
          if (cmd === "tracking_state")
            return structuredClone(browser.localTracking);
          if (cmd === "tracking_remove_session") {
            browser.localTracking.sessions =
              browser.localTracking.sessions.filter((s) => s.id !== args.id);
            return;
          }
          if (cmd === "tracking_configure") {
            const r = browser.localTracking.repositories.find(
              (r) => r.id === args.repositoryId,
            )!;
            r.mode = args.mode;
            r.serverId = args.serverId;
            return;
          }
          throw new Error(`Unexpected native command: ${cmd}`);
        },
      };
    },
    { initial: local, token },
  );
  await page.goto("/development");
  await expect(
    page.getByRole("article", {
      name: "Session native-repo fix/native-bridge",
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).localTracking.sessions.length),
    )
    .toBe(0);
  await page
    .getByText("Repositories & tracking setup", { exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause tracking on this device" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).trackingOffline = true;
  });
  await page
    .getByRole("button", { name: "Pause tracking on this device" })
    .click();
  await expect(
    page.locator(".tracking-local").filter({ hasText: "native-repo" }),
  ).toContainText("manual");
  await expect(
    page.getByRole("button", { name: "Pause tracking on this device" }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Offline test");
});
