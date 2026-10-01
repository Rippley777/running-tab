import {
  sql,
  db,
  required,
  one,
  pool,
  type Context,
} from "../server/db/index.js";
import {
  createWorkspace,
  createClient,
  createProject,
  updateProject,
} from "../server/domain/catalog.js";
import { manualEntry, patchEntry, timerAction } from "../server/domain/time.js";
import {
  createDraft,
  requestReview,
  approveInvoice,
  editInvoice,
  invoiceDetail,
} from "../server/domain/invoices.js";
import {
  runDemoOperation,
  demoCustomerPayment,
  demoConsent,
} from "../server/domain/payments.js";
import { createBucket } from "../server/domain/retainers.js";
import { createAgreement, runSchedules } from "../server/domain/agreements.js";
import { linkRepository, ingest } from "../server/domain/activity.js";
import { refreshReminders } from "../server/domain/dashboard.js";
if (
  process.env.DEMO_ENABLED !== "true" ||
  process.env.NODE_ENV === "production" ||
  process.env.BILLING_MODE !== "demo"
)
  throw new Error(
    "Seeding requires an isolated development environment and demo billing mode.",
  );
const exists = await one(
  sql`SELECT id FROM "user" WHERE email='alex@demo.runningtab.test'`,
);
if (exists) {
  console.log("Demo already exists. No records were changed.");
  await pool.end();
  process.exit(0);
}
const userId = "demo-alex";
await db.execute(
  sql`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${userId},'Alex Morgan','alex@demo.runningtab.test',true)`,
);
const w = await createWorkspace(
  { id: userId, email: "alex@demo.runningtab.test" },
  {
    name: "Alex Morgan Studio",
    businessEmail: "alex@demo.runningtab.test",
    businessAddress: "2400 Lakeview Avenue\nChicago, IL 60614",
    timezone: "America/Chicago",
    defaultRate: 15000,
    costRate: 5500,
    targetRate: 15000,
    capacitySeconds: 30 * 3600,
    paymentTerms: 14,
  },
);
await db.execute(sql`UPDATE workspace SET demo=true WHERE id=${w.id}`);
await db.execute(
  sql`INSERT INTO connected_payment_account(workspace_id,provider,account_id,ready) VALUES(${w.id},'demo','demo',true) ON CONFLICT(workspace_id) DO UPDATE SET account_id='demo'`,
);
const ctx: Context = {
  workspaceId: w.id,
  userId,
  verifiedAt: new Date(),
  scopes: ["read", "write", "financial"],
};
const clients = [];
for (const c of [
  {
    name: "Northstar",
    email: "billing@northstar.test",
    color: "#a7bda5",
    defaultRate: 17500,
  },
  {
    name: "Forma Studio",
    email: "hello@forma.test",
    color: "#c2a28d",
    defaultRate: 15000,
  },
  {
    name: "Meridian Health",
    email: "finance@meridian.test",
    color: "#91afb8",
    defaultRate: 16000,
  },
  {
    name: "Fieldwork",
    email: "accounts@fieldwork.test",
    color: "#b5a4c4",
    defaultRate: 15000,
  },
  {
    name: "Goodwell",
    email: "team@goodwell.test",
    color: "#c7b879",
    defaultRate: 12500,
  },
])
  clients.push(
    await createClient(ctx, {
      ...c,
      address: "100 Example Street\nChicago, IL 60601",
    }),
  );
const specs = [
  {
    name: "Platform & API",
    clientId: clients[0].id,
    model: "hourly" as const,
    color: clients[0].color,
    rate: 17500,
    description: "A dependable API for a growing product team.",
  },
  {
    name: "Design system",
    clientId: clients[1].id,
    model: "fixed" as const,
    color: clients[1].color,
    fee: 600000,
    estimateSeconds: 40 * 3600,
    description: "A shared interface language, from tokens to components.",
  },
  {
    name: "Patient portal",
    clientId: clients[2].id,
    model: "hourly" as const,
    color: clients[2].color,
    rate: 16000,
    description: "Thoughtful improvements to the patient experience.",
  },
  {
    name: "Engineering support",
    clientId: clients[3].id,
    model: "prepaid" as const,
    color: clients[3].color,
    rate: 15000,
    description: "A bank of focused engineering time, ready when needed.",
  },
  {
    name: "Website care",
    clientId: clients[4].id,
    model: "support" as const,
    color: clients[4].color,
    fee: 125000,
    description: "Ongoing maintenance and a little peace of mind.",
  },
  {
    name: "Developer experience",
    clientId: clients[0].id,
    model: "hourly" as const,
    color: clients[0].color,
    rate: 17500,
    description: "Better tools, faster feedback, happier developers.",
  },
  {
    name: "Spring launch",
    clientId: clients[1].id,
    model: "fixed" as const,
    color: clients[1].color,
    fee: 420000,
    estimateSeconds: 24 * 3600,
    description: "A focused launch experience for a new collection.",
  },
  {
    name: "Accessibility audit",
    clientId: clients[4].id,
    model: "hourly" as const,
    color: clients[4].color,
    rate: 12500,
    description: "Making the essentials work for everyone.",
  },
];
const projects: Record<string, any>[] = [];
for (const spec of specs) projects.push(await createProject(ctx, spec));
for (const [p, title] of [
  [0, "Account permissions"],
  [0, "API regression tests"],
  [2, "Appointment flow"],
  [3, "Release maintenance"],
  [5, "CI improvements"],
] as const)
  await db.execute(
    sql`INSERT INTO project_task(workspace_id,project_id,title) VALUES(${w.id},${projects[p].id},${title})`,
  );
const base = process.env.DEMO_REFERENCE_DATE
  ? new Date(`${process.env.DEMO_REFERENCE_DATE}T18:00:00Z`)
  : new Date();
base.setUTCHours(18, 0, 0, 0);
if (+base > Date.now()) base.setUTCDate(base.getUTCDate() - 1);
const at = (days: number, hour: number) =>
  new Date(
    Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() - days,
      hour,
    ),
  );
async function entry(
  p: number,
  days: number,
  hour: number,
  seconds: number,
  description: string,
  billable = true,
  reviewed = true,
) {
  const start = at(days, hour);
  const end = new Date(+start + seconds * 1000);
  const e = await manualEntry(ctx, {
    projectId: projects[p].id,
    description,
    startedAt: start.toISOString(),
    endedAt: end.toISOString(),
    billable,
    acknowledgeOverlap: true,
  });
  if (reviewed) await patchEntry(ctx, e.id, { version: 1, reviewed: true });
  return e;
}
async function issue(inv: Record<string, any>, pay = false) {
  await requestReview(ctx, inv.id);
  const approval = await approveInvoice(
    ctx,
    inv.id,
    { revision: inv.revision, action: "send", confirmedTotal: inv.total },
    `seed-approve-${inv.id}`,
  );
  await runDemoOperation(ctx, approval.operationId);
  if (pay) await demoCustomerPayment(ctx, inv.id);
}
const bucket = await createBucket(ctx, {
  projectId: projects[3].id,
  name: "September engineering hours",
  seconds: 20 * 3600,
  price: 300000,
  expiresAt: at(-14, 18).toISOString(),
});
const bucketInvoice = await createDraft(ctx, {
  clientId: clients[3].id,
  bucketIds: [bucket.id],
});
await issue(bucketInvoice, true);
await db.execute(
  sql`UPDATE retainer_bucket SET activated_at=${at(28, 9)} WHERE id=${bucket.id}`,
);
for (let n = 0; n < 10; n++)
  await entry(
    1,
    28 - n,
    13,
    6 * 3600,
    [
      "Built the component foundations",
      "Documented interaction patterns",
      "Implemented responsive components",
      "Refined keyboard navigation",
      "Tested and documented the component library",
    ][n % 5],
  );
const fixed = await required(
  sql`UPDATE fixed_milestone SET ready=true WHERE project_id=${projects[1].id} RETURNING id`,
);
const fixedInv = await createDraft(ctx, {
  clientId: clients[1].id,
  milestoneIds: [fixed.id],
});
await issue(fixedInv, true);
await updateProject(ctx, projects[1].id, { status: "completed" });
for (let n = 0; n < 8; n++)
  await entry(
    3,
    18 - n,
    20,
    (n === 7 ? 1 : 2.5) * 3600,
    [
      "Patched dependency compatibility",
      "Improved background job reliability",
      "Reviewed and shipped maintenance fixes",
      "Added regression coverage",
    ][n % 4],
  );
const old = [];
for (let n = 0; n < 5; n++)
  old.push(
    await entry(
      0,
      16 - n,
      13,
      3 * 3600,
      [
        "Implemented role-based access controls",
        "Added API regression tests",
        "Improved account provisioning",
        "Documented API error responses",
        "Reviewed and shipped authentication changes",
      ][n],
    ),
  );
const paid = await createDraft(ctx, {
  clientId: clients[0].id,
  timeEntryIds: old.map((e) => e.id),
});
await issue(paid, true);
const overdueEntries = [
  await entry(2, 10, 13, 3 * 3600, "Improved the appointment booking flow"),
  await entry(2, 9, 13, 2 * 3600, "Added accessible form validation"),
];
const overdue = await createDraft(ctx, {
  clientId: clients[2].id,
  timeEntryIds: overdueEntries.map((e) => e.id),
});
const overdueDetail = await invoiceDetail(ctx, overdue.id);
await editInvoice(ctx, overdue.id, {
  revision: 1,
  memo: "",
  dueAt: at(3, 18).toISOString(),
  lines: overdueDetail.lines.map((l) => ({
    id: l.id,
    description: l.description,
  })),
});
await issue((await invoiceDetail(ctx, overdue.id)).invoice);
for (let n = 0; n < 8; n++)
  await entry(
    6,
    12 - n,
    8,
    3 * 3600,
    "Built and refined the launch experience",
  );
const tasks = [
  "Refactored the permissions middleware",
  "Added regression tests for account roles",
  "Improved API response validation",
  "Documented the authentication flow",
  "Reviewed the deployment checklist",
  "Optimized query performance",
];
const draftEntries = [];
for (let n = 6; n >= 1; n--) {
  const e = await entry(
    n % 2 === 0 ? 0 : 5,
    n,
    14,
    ((n % 3) + 1) * 2700,
    tasks[6 - n],
    true,
    n > 2,
  );
  if (n >= 5) draftEntries.push(e);
  await entry(
    2,
    n,
    18,
    3600 + (n % 2) * 1800,
    ["Refined appointment confirmations", "Improved keyboard navigation"][
      n % 2
    ],
  );
  await entry(
    4,
    n,
    20,
    n % 2 === 0 ? 3600 : 1800,
    "Reviewed updates and applied maintenance patches",
  );
  if (n % 2 === 0)
    await entry(0, n, 22, 1800, "Project coordination and planning", false);
}
const draft = await createDraft(ctx, {
  clientId: clients[0].id,
  timeEntryIds: draftEntries.map((e) => e.id),
});
await requestReview(ctx, draft.id);
await entry(7, 1, 11, 2700, "", true, false);
const failedEntry = await entry(
  7,
  7,
  10,
  7200,
  "Audited screen-reader navigation",
);
const failed = await createDraft(ctx, {
  clientId: clients[4].id,
  timeEntryIds: [failedEntry.id],
});
await demoConsent(ctx, clients[4].id, "demo_declined");
await requestReview(ctx, failed.id);
const failure = await approveInvoice(
  ctx,
  failed.id,
  { revision: 1, action: "charge", confirmedTotal: failed.total },
  `seed-failed-${failed.id}`,
);
await runDemoOperation(ctx, failure.operationId);
await demoConsent(ctx, clients[0].id);
await createAgreement(ctx, {
  projectId: projects[4].id,
  fee: 125000,
  frequency: "monthly",
  anchor: at(0, 0).toISOString().slice(0, 8) + "01",
  timezone: w.timezone,
});
await runSchedules(ctx);
const mapping = await linkRepository(ctx, {
  projectId: projects[0].id,
  identity: "github.com/northstar/platform",
  alias: "platform",
});
await ingest(ctx, {
  identity: mapping.identity,
  commits: [
    {
      ref: "f3a92bc7e1389123112312321312312312312312abc",
      occurredAt: at(1, 16).toISOString(),
      subject: "Add role-based access checks",
      branch: "feature/account-roles",
    },
    {
      ref: "bc82e12131892123112312321312312312312312ab",
      occurredAt: at(1, 17).toISOString(),
      subject: "Cover permission edge cases",
    },
  ],
});
await timerAction(
  ctx,
  {
    action: "start",
    projectId: projects[0].id,
    description: "Account permissions · final review",
  },
  "seed-forgotten-timer",
  new Date(Date.now() - 26 * 3600000),
);
// Reference dates reflect seeded business events. Payment amounts still originate in the payment services.
await db.execute(
  sql`UPDATE payment SET received_at=${at(8, 18)} WHERE invoice_id=${fixedInv.id}`,
);
await db.execute(
  sql`UPDATE payment SET received_at=${at(3, 18)} WHERE invoice_id=${paid.id}`,
);
await db.execute(
  sql`UPDATE payment SET received_at=${at(28, 9)} WHERE invoice_id=${bucketInvoice.id}`,
);
await refreshReminders(ctx);
console.log(
  `Seeded ${clients.length} clients, ${projects.length} projects, coherent work and billing history. Demo email: alex@demo.runningtab.test`,
);
await pool.end();
