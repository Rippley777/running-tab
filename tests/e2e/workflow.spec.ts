import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
async function signIn(page: Page, label: string) {
  const email = `e2e-${label}-${Date.now()}@runningtab.test`;
  await page.goto("/");
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Send me a sign-in link" }).click();
  await expect(page.getByText("Check your inbox.")).toBeVisible();
  let messageId = "";
  await expect
    .poll(async () => {
      const messages = await (
        await page.request.get("http://127.0.0.1:8025/api/v1/messages")
      ).json();
      messageId =
        messages.messages.find((m: any) =>
          m.To.some((t: any) => t.Address === email),
        )?.ID ?? "";
      return messageId;
    })
    .not.toBe("");
  const message = await (
    await page.request.get(`http://127.0.0.1:8025/api/v1/message/${messageId}`)
  ).json();
  const url = message.Text.match(
    /http:\/\/localhost:1420\/api\/auth\/magic-link\/verify\?\S+/,
  )[0];
  await page.goto(url);
  await page
    .getByLabel("Business / studio name")
    .fill(`Acceptance ${label} Studio`);
  await page.getByLabel("Invoice contact email").fill(email);
  await page.getByLabel("Time zone", { exact: true }).fill("America/Chicago");
  await page.getByRole("button", { name: "Create my workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "What are you working on?" }),
  ).toBeVisible();
}
async function project(page: Page, model = "hourly") {
  await page.goto("/clients");
  await page.getByRole("button", { name: "New client", exact: true }).click();
  await page
    .getByLabel("Client name", { exact: true })
    .fill("Acceptance Client");
  await page
    .getByLabel("Billing email")
    .fill(`accounts-${Date.now()}@client.test`);
  await page
    .getByRole("button", { name: "Create client", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: /Acceptance Client/ }).click();
  await page.getByRole("button", { name: "Edit client", exact: true }).click();
  await page.getByLabel("Billing address").fill("100 Test Avenue");
  await page.getByRole("button", { name: "Save client", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("100 Test Avenue", { exact: true }),
  ).toBeVisible();
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Permissions service");
  await page
    .getByLabel("Client", { exact: true })
    .selectOption({ label: "Acceptance Client" });
  await page.getByLabel("Billing model").selectOption(model);
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function track(page: Page) {
  await page.goto("/today");
  await page
    .getByLabel("Timer description")
    .fill("Implemented access-control regression tests");
  await page.getByRole("button", { name: "Start timer", exact: true }).click();
  await expect(page.getByText("ON THE CLOCK")).toBeVisible();
  await page.reload();
  await expect(page.locator(".timer-card .timer-digits")).not.toHaveText(
    "00:00:00",
  );
  await page
    .getByRole("region", { name: "Work timer" })
    .getByRole("button", { name: "Stop timer", exact: true })
    .click();
  await expect(page.getByLabel("Timer description")).toBeVisible();
  await page.goto("/time");
  await page.getByRole("button", { name: "Edit entry", exact: true }).click();
  await page.getByRole("button", { name: "Save & mark reviewed" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function invoice(page: Page) {
  await page.goto("/billing");
  await page.getByRole("button", { name: "Build draft" }).click();
  await page.getByLabel("Select eligible work").check();
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page).toHaveURL(/\/invoice\//);
  await page.getByRole("button", { name: "Review & approve" }).click();
  await page
    .getByRole("button", { name: "Approve & issue invoice", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Client link", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Client link", exact: true }).click();
  const url = await page.getByRole("dialog").locator("input").inputValue();
  await page.getByRole("button", { name: "Close dialog" }).click();
  return url;
}
test("magic-link → client/project → persistent timer → reviewed invoice → payment receipt and dashboard", async ({
  page,
}) => {
  await signIn(page, "hourly");
  await project(page);
  await track(page);
  await page.goto("/billing");
  await page.getByRole("button", { name: "Build draft" }).click();
  await page.getByLabel("Select eligible work").check();
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await page.getByRole("button", { name: "Edit draft", exact: true }).click();
  await page.getByText("Help describe this work", { exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Implemented access-control regression tests", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "Create template suggestions" })
    .click();
  await expect(
    page.getByText("Deterministic template · no AI used"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Use this description" })
    .first()
    .click();
  await page.getByRole("button", { name: "Save new revision" }).click();
  await page.getByRole("button", { name: "Review & approve" }).click();
  await page
    .getByRole("button", { name: "Approve & issue invoice", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Client link", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Client link", exact: true }).click();
  const url = await page.getByRole("dialog").locator("input").inputValue();
  const portal = await page.context().newPage();
  await portal.goto(url);
  await portal.getByRole("button", { name: /^Pay .*demo$/ }).click();
  await expect(portal.getByText("All paid. Thank you.")).toBeVisible();
  await expect(
    portal.getByRole("heading", { name: "Payment receipts" }),
  ).toBeVisible();
  const violations = (
    await new AxeBuilder({ page: portal })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze()
  ).violations;
  expect(
    violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
  await page.goto("/today");
  const data = await (
    await page.request.get(
      `/api/v1/snapshot?from=${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    )
  ).json();
  expect(data.metrics.cash).toBeGreaterThan(0);
  expect(data.metrics.outstanding).toBe(0);
  expect(data.invoices[0].collection_state).toBe("paid");
  await expect
    .poll(
      async () => {
        const operations = await (
          await page.request.get("/api/v1/operations")
        ).json();
        return operations.delivery
          .filter(
            (d: any) =>
              d.invoice_id === data.invoices[0].id && d.state === "sent",
          )
          .map((d: any) => d.kind)
          .sort();
      },
      { timeout: 30000 },
    )
    .toEqual(["invoice", "receipt"]);
  const operatorViolations = (
    await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()
  ).violations;
  expect(
    operatorViolations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  ).toEqual([]);
  await page.screenshot({
    path: "test-results/today-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/billing");
  await expect(
    page.getByRole("heading", { name: "Good work. Clear invoices." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/billing-mobile.png",
    fullPage: true,
  });
});
test("declined customer payment recovers without a second invoice or duplicate receipt", async ({
  page,
}) => {
  await signIn(page, "recovery");
  await project(page);
  await track(page);
  const url = await invoice(page);
  await page.goto(url);
  await page
    .getByRole("button", { name: "Simulate a declined payment" })
    .click();
  await expect(page.getByText(/Payment wasn’t completed/)).toBeVisible();
  await page.getByRole("button", { name: /^Pay .*demo$/ }).click();
  await expect(page.getByText("All paid. Thank you.")).toBeVisible();
  await page.reload();
  await expect(page.getByText(/received$/)).toHaveCount(1);
});
test("prepaid purchase funds a bucket only after payment; confirmed work consumes coverage", async ({
  page,
}) => {
  await signIn(page, "prepaid");
  await project(page, "prepaid");
  await page
    .getByRole("link", { name: "Permissions service", exact: true })
    .click();
  await page.getByRole("button", { name: "New hours bucket" }).click();
  await page.getByLabel("Purchased hours").fill("2");
  await page.getByLabel("Agreed price · USD").fill("300.00");
  await page
    .getByRole("button", { name: "Create bucket", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let snap = await (
    await page.request.get(
      `/api/v1/snapshot?from=${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    )
  ).json();
  expect(snap.buckets[0].activated_at).toBeNull();
  expect(snap.buckets[0].balance).toBe(0);
  const url = await invoice(page);
  const portal = await page.context().newPage();
  await portal.goto(url);
  await portal.getByRole("button", { name: /^Pay .*demo$/ }).click();
  await expect(portal.getByText("All paid. Thank you.")).toBeVisible();
  await track(page);
  snap = await (
    await page.request.get(
      `/api/v1/snapshot?from=${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    )
  ).json();
  expect(snap.buckets[0].balance).toBeLessThan(7200);
  expect(snap.entries[0].treatment).toBe("prepaid");
  expect(snap.entries[0].covered_seconds).toBe(snap.entries[0].actual_seconds);
  expect(snap.metrics.eligible_value).toBe(0);
  expect(snap.metrics.cash).toBe(30000);
  const before = snap.buckets[0].balance;
  await page.goto("/billing");
  await page
    .getByRole("button", { name: "Prepaid hours", exact: true })
    .click();
  await page.getByRole("button", { name: "View the ledger" }).click();
  await page.getByRole("button", { name: "Adjust funded hours" }).click();
  await page.getByLabel("Hours to add or remove").fill("-0.25");
  await page
    .getByLabel("Reason for this adjustment")
    .fill("Agreed coverage correction");
  await page.getByRole("button", { name: "Record adjustment" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  snap = await (
    await page.request.get(
      `/api/v1/snapshot?from=${new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`,
    )
  ).json();
  expect(snap.buckets[0].balance).toBe(before - 900);
  expect(snap.metrics.cash).toBe(30000);
});

test("fixed milestones and prospective recurring terms are editable through the UI", async ({
  page,
}) => {
  await signIn(page, "agreements");
  await page.goto("/clients");
  await page.getByRole("button", { name: "New client", exact: true }).click();
  await page
    .getByLabel("Client name", { exact: true })
    .fill("Agreement Client");
  await page.getByLabel("Billing email").fill("agreement@client.test");
  await page
    .getByRole("button", { name: "Create client", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  async function makeProject(name: string, model: string) {
    await page.goto("/projects");
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page.getByLabel("Project name").fill(name);
    await page
      .getByLabel("Client", { exact: true })
      .selectOption({ label: "Agreement Client" });
    await page.getByLabel("Billing model").selectOption(model);
    await page.getByLabel("Agreed fee · USD").fill("500.00");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name, exact: true }).click();
  }
  await makeProject("Fixed delivery", "fixed");
  await page.getByRole("button", { name: "Divide into milestones" }).click();
  await page.getByLabel("New milestone name").fill("Discovery");
  await page.getByLabel("New milestone amount · USD").fill("100.00");
  await page
    .getByRole("button", { name: "Create milestone", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Discovery · $100.00").click();
  await expect(page.getByLabel("Discovery · $100.00")).toBeChecked();
  const url = await invoice(page);
  const portal = await page.context().newPage();
  await portal.goto(url);
  await portal.getByRole("button", { name: "Pay $100.00 · demo" }).click();
  await expect(portal.getByText("All paid. Thank you.")).toBeVisible();
  await makeProject("Ongoing support", "support");
  await page.getByRole("button", { name: "New schedule" }).click();
  await page
    .getByRole("button", { name: "Create schedule", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goto("/billing");
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  await page.getByRole("button", { name: "Change future terms" }).click();
  await page.getByLabel("New period fee · USD").fill("750.00");
  await page.getByRole("button", { name: "Schedule these terms" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/From .*\$750 \/ period/)).toBeVisible();
  await page
    .getByRole("button", { name: "Cancel schedule", exact: true })
    .click();
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
});
