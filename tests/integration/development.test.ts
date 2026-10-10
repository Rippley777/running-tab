import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  db,
  sql,
  required,
  rows,
  pool,
  type Context,
} from "../../server/db/index.js";
import {
  createWorkspace,
  createClient,
  createProject,
} from "../../server/domain/catalog.js";
import {
  linkRepository,
  reviewSuggestion,
  ingest,
} from "../../server/domain/activity.js";
import {
  configureRepository,
  uploadSession,
  developmentSessions,
  approveSession,
  editSession,
} from "../../server/domain/development.js";
import {
  manualEntry,
  patchEntry,
  timerAction,
} from "../../server/domain/time.js";
import { createDraft } from "../../server/domain/invoices.js";
import { draftDescriptions } from "../../server/integrations/descriptions.js";
import {
  resolveMapping,
  describeDevelopment,
  safeMetadata,
  supportedSeconds,
} from "../../shared/development.js";

async function fixture() {
  const userId = `tracking-${randomUUID()}`;
  await db.execute(
    sql`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${userId},'Developer',${`${userId}@example.test`},true)`,
  );
  const w = await createWorkspace(
    { id: userId, email: `${userId}@example.test` },
    {
      name: "Studio",
      businessEmail: "studio@example.test",
      timezone: "America/Chicago",
      defaultRate: 9000,
    },
  );
  const ctx: Context = {
    userId,
    workspaceId: w.id,
    verifiedAt: new Date(),
    scopes: ["read", "write", "financial", "context:write"],
  };
  const client = await createClient(ctx, {
    name: "Acme",
    email: "acme@example.test",
    defaultRate: 8000,
  });
  const project = await createProject(ctx, {
    clientId: client.id,
    name: "Dashboard",
    model: "hourly",
    rate: 7500,
  });
  const r = await linkRepository(ctx, {
    projectId: project.id,
    identity: `local/${randomUUID()}`,
    alias: "Dashboard repo",
  });
  const repository = await configureRepository(ctx, r.id, {
    version: 1,
    projectId: project.id,
    taskId: null,
    trackingEnabled: true,
    billable: true,
    rules: [],
  });
  return { ctx, w, client, project, repository };
}
function upload(repositoryId: string, extra: Record<string, unknown> = {}) {
  const start = Date.now() - 3 * 86400000;
  return {
    id: randomUUID(),
    repositoryId,
    branch: "feature/analytics-charts",
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 5100000).toISOString(),
    inferredSeconds: 5100,
    evidence: Array.from({ length: 171 }, (_, i) => ({
      at: new Date(start + i * 30000).toISOString(),
      kind: "file_activity",
      detail: "File metadata changed",
    })),
    ...extra,
  };
}
function approval(
  f: Awaited<ReturnType<typeof fixture>>,
  s: ReturnType<typeof upload>,
  extra: Record<string, unknown> = {},
) {
  return {
    version: 1,
    projectId: f.project.id,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    description: "Developed analytics charts; reviewed chart validation",
    billable: true,
    ...extra,
  };
}
afterAll(() => pool.end());
describe("branch resolution and cautious descriptions", () => {
  it("exact overrides wildcards; ambiguous patterns cannot bill", () => {
    const defaults = { projectId: "default", billable: true };
    const rules = [
      { pattern: "feature/*", projectId: "a", billable: true },
      { pattern: "feature/client-*", projectId: "b", billable: true },
      { pattern: "feature/client-one", projectId: "exact", billable: true },
      { pattern: "internal/*", projectId: "internal", billable: false },
    ];
    expect(
      resolveMapping("feature/client-one", defaults, rules).projectId,
    ).toBe("exact");
    expect(resolveMapping("feature/client-two", defaults, rules)).toMatchObject(
      { projectId: null, billable: false },
    );
    expect(resolveMapping("internal/docs", defaults, rules).billable).toBe(
      false,
    );
    expect(resolveMapping("main", defaults, rules).projectId).toBe("default");
    expect(
      resolveMapping("release/v1.2", defaults, [
        { pattern: "release/v1.2", projectId: "release", billable: false },
      ]).projectId,
    ).toBe("release");
    expect(
      resolveMapping("release/v1x2", defaults, [
        { pattern: "release/v1.2", projectId: "release", billable: false },
      ]).projectId,
    ).toBe("default");
  });
  it("styles preserve uncertainty and redact sensitive metadata", () => {
    for (const style of [
      "concise",
      "professional",
      "detailed",
      "technical",
    ] as const) {
      const result = describeDevelopment(
        "fix/inventory-duplicate-detection",
        style,
      );
      expect(result).not.toMatch(/Implemented|Improved|completed/);
      expect(result).toContain("inventory");
    }
    expect(describeDevelopment("main")).toContain("add a note");
    expect(
      safeMetadata("ghp_secret token=secret\nhttps://x:password@example.com"),
    ).not.toMatch(/ghp_secret|token=secret|password@example/);
  });
});
describe("session to invoice", () => {
  it("refuses to infer continuous hours from sparse or duplicate events", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    s.evidence = [s.evidence[0], s.evidence[s.evidence.length - 1]];
    await uploadSession(f.ctx, s);
    expect((await developmentSessions(f.ctx))[0]).toMatchObject({
      inferred_seconds: 0,
      confidence: "low",
    });
    const at = new Date().toISOString();
    expect(
      supportedSeconds(
        [
          { at, kind: "file_activity", detail: "" },
          { at, kind: "file_activity", detail: "" },
        ],
        300,
      ),
    ).toBe(0);
  });

  it("approves edited 85 minutes at project rate into a reviewed $106.25 billing source, once", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    const key = randomUUID(),
      input = approval(f, s);
    const e = await approveSession(f.ctx, s.id, input, key);
    expect(e).toMatchObject({
      actual_seconds: 5100,
      billed_seconds: 5100,
      rate: 7500,
      reviewed: true,
      project_id: f.project.id,
      source_session_id: s.id,
    });
    expect((await approveSession(f.ctx, s.id, input, key)).id).toBe(e.id);
    await expect(
      approveSession(f.ctx, s.id, input, randomUUID()),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await uploadSession(f.ctx, { ...s, branch: "changed-remote-data" });
    const session = (await developmentSessions(f.ctx))[0];
    expect(session.description).toBe(input.description);
    expect(session.status).toBe("approved");
    const invoice = await createDraft(f.ctx, {
      clientId: f.client.id,
      timeEntryIds: [e.id],
    });
    expect(invoice.total).toBe(10625);
    await expect(
      patchEntry(f.ctx, e.id, { version: 1, description: "Attempt overwrite" }),
    ).rejects.toMatchObject({ code: "ENTRY_LOCKED" });
    await expect(
      createDraft(f.ctx, { clientId: f.client.id, timeEntryIds: [e.id] }),
    ).rejects.toBeTruthy();
    await editSession(f.ctx, s.id, { action: "delete", version: 2 });
    await uploadSession(f.ctx, s);
    expect(await developmentSessions(f.ctx)).toHaveLength(0);
    expect(
      (await required(sql`SELECT * FROM time_entry WHERE id=${e.id}`))
        .description,
    ).toBe(input.description);
  });
  it("serializes concurrent approvals and overlapping sessions", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    const results = await Promise.allSettled([
      approveSession(f.ctx, s.id, approval(f, s)),
      approveSession(f.ctx, s.id, approval(f, s)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const next = { ...s, id: randomUUID() };
    await uploadSession(f.ctx, next);
    await expect(
      approveSession(
        f.ctx,
        next.id,
        approval(f, next, { acknowledgeOverlap: true }),
      ),
    ).rejects.toMatchObject({ code: "OVERLAP" });
    expect(
      await rows(
        sql`SELECT id FROM time_entry WHERE workspace_id=${f.ctx.workspaceId}`,
      ),
    ).toHaveLength(1);
  });
  it("preserves draft edits on replay, reassigns client and task without changing repository defaults", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    const c = await createClient(f.ctx, {
      name: "Other client",
      email: "other@example.test",
      defaultRate: 6000,
    });
    const p = await createProject(f.ctx, {
      clientId: c.id,
      name: "Internal",
      model: "hourly",
    });
    const t = await required(
      sql`INSERT INTO project_task(workspace_id,project_id,title) VALUES(${f.ctx.workspaceId},${p.id},'Review') RETURNING *`,
    );
    await editSession(f.ctx, s.id, {
      version: 1,
      action: "edit",
      projectId: p.id,
      taskId: t.id,
      description: "User's final wording",
      startedAt: s.startedAt,
      durationSeconds: 4800,
      billable: false,
    });
    await uploadSession(f.ctx, s);
    expect((await developmentSessions(f.ctx))[0]).toMatchObject({
      project_id: p.id,
      task_id: t.id,
      description: "User's final wording",
      adjusted_seconds: 4800,
      billable: false,
    });
    const e = await approveSession(
      f.ctx,
      s.id,
      approval(f, s, {
        version: 2,
        projectId: p.id,
        taskId: t.id,
        description: "User's final wording",
        billable: false,
      }),
    );
    expect(e).toMatchObject({
      rate: 6000,
      billed_seconds: 0,
      treatment: "nonbillable",
      task_id: t.id,
    });
    expect(
      (
        await required(
          sql`SELECT project_id FROM repository_mapping WHERE id=${f.repository.id}`,
        )
      ).project_id,
    ).toBe(f.project.id);
  });
  it("uses entry, project, client, then workspace rate and current rounding rules", async () => {
    const f = await fixture();
    await db.execute(
      sql`UPDATE workspace SET rounding_minutes=6 WHERE id=${f.w.id}`,
    );
    for (const [i, rate] of [7000, 7500, 8000, 9000].entries()) {
      if (i >= 2)
        await db.execute(
          sql`UPDATE project SET rate=NULL WHERE id=${f.project.id}`,
        );
      if (i >= 3)
        await db.execute(
          sql`UPDATE client SET default_rate=NULL WHERE id=${f.client.id}`,
        );
      const start = Date.now() - (i + 4) * 86400000;
      const s = upload(f.repository.id, {
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(start + 60000).toISOString(),
        inferredSeconds: 60,
        evidence: [],
      });
      await uploadSession(f.ctx, s);
      const e = await approveSession(
        f.ctx,
        s.id,
        approval(f, s, i === 0 ? { rateOverride: 7000 } : {}),
      );
      expect(e.rate).toBe(rate);
      expect(e.billed_seconds).toBe(360);
    }
  });
  it("ambiguous mapping needs explicit project; foreign tenant/task and disabled uploads fail", async () => {
    const f = await fixture(),
      other = await fixture();
    await configureRepository(f.ctx, f.repository.id, {
      version: 2,
      projectId: f.project.id,
      trackingEnabled: true,
      billable: true,
      rules: [
        { pattern: "feature/*", projectId: f.project.id, billable: true },
        { pattern: "*/analytics-*", projectId: f.project.id, billable: true },
      ],
    });
    const s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    expect((await developmentSessions(f.ctx))[0]).toMatchObject({
      project_id: null,
      billable: false,
    });
    await expect(
      approveSession(f.ctx, s.id, approval(f, s, { projectId: null })),
    ).rejects.toBeTruthy();
    await expect(
      approveSession(
        f.ctx,
        s.id,
        approval(f, s, { projectId: other.project.id }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      editSession(other.ctx, s.id, { action: "discard", version: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const t = await required(
      sql`INSERT INTO project_task(workspace_id,project_id,title) VALUES(${other.ctx.workspaceId},${other.project.id},'Foreign') RETURNING *`,
    );
    await expect(
      approveSession(f.ctx, s.id, approval(f, s, { taskId: t.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await configureRepository(f.ctx, f.repository.id, {
      version: 3,
      projectId: null,
      trackingEnabled: false,
      billable: false,
      rules: [],
    });
    await expect(
      uploadSession(f.ctx, upload(f.repository.id)),
    ).rejects.toMatchObject({ code: "TRACKING_DISABLED" });
  });
  it("splits/merges with conserved duration, no duplicate resurfacing and retained descriptions", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    await editSession(f.ctx, s.id, {
      version: 1,
      action: "split",
      splitAt: new Date(+new Date(s.startedAt) + 1800000).toISOString(),
    });
    let list = await developmentSessions(f.ctx);
    expect(list).toHaveLength(2);
    expect(list.reduce((n, x) => n + x.inferred_seconds, 0)).toBe(5100);
    const child = list.find((x) => x.id !== s.id)!;
    await editSession(f.ctx, s.id, {
      version: 2,
      action: "merge",
      otherId: child.id,
      otherVersion: 1,
    });
    await uploadSession(f.ctx, s);
    list = await developmentSessions(f.ctx);
    expect(list.find((x) => x.id === s.id)).toMatchObject({
      inferred_seconds: 5100,
      version: 3,
      status: "suggested",
    });
    expect(list.find((x) => x.id === child.id)?.status).toBe("discarded");
    await editSession(f.ctx, s.id, { version: 3, action: "discard" });
    await uploadSession(f.ctx, s);
    expect(
      (await developmentSessions(f.ctx)).every((x) => x.status === "discarded"),
    ).toBe(true);
  });
  it("rejects invalid dates, impossible inferred duration and evidence outside the interval", async () => {
    const f = await fixture();
    for (const extra of [
      { startedAt: "" },
      { inferredSeconds: 999999 },
      { endedAt: new Date(0).toISOString() },
      {
        evidence: [{ at: new Date(0).toISOString(), kind: "commit_detected" }],
      },
    ])
      await expect(
        uploadSession(f.ctx, upload(f.repository.id, extra)),
      ).rejects.toBeTruthy();
  });
  it("commit-only sessions require a user-supplied duration and never start billing", async () => {
    const f = await fixture(),
      start = new Date(Date.now() - 86400000).toISOString();
    const s = upload(f.repository.id, {
      startedAt: start,
      endedAt: start,
      inferredSeconds: 0,
      evidence: [{ at: start, kind: "commit_detected", detail: "abc123" }],
    });
    await uploadSession(f.ctx, s);
    expect((await developmentSessions(f.ctx))[0]).toMatchObject({
      confidence: "low",
      inferred_seconds: 0,
    });
    await expect(
      approveSession(f.ctx, s.id, approval(f, s)),
    ).rejects.toMatchObject({ code: "INVALID_DURATION" });
    const e = await approveSession(
      f.ctx,
      s.id,
      approval(f, s, {
        endedAt: new Date(+new Date(start) + 600000).toISOString(),
      }),
    );
    expect(e.actual_seconds).toBe(600);
  });
  it("manual entries and running timers block overlapping approval", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    await manualEntry(f.ctx, approval(f, s));
    await expect(
      approveSession(f.ctx, s.id, approval(f, s)),
    ).rejects.toMatchObject({ code: "OVERLAP" });
    const end = new Date(Date.now() - 60000),
      start = new Date(+end - 600000),
      n = upload(f.repository.id, {
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        evidence: [],
        inferredSeconds: 600,
      });
    await uploadSession(f.ctx, n);
    await timerAction(
      f.ctx,
      { action: "start", projectId: f.project.id },
      randomUUID(),
      start,
    );
    await expect(
      approveSession(f.ctx, n.id, approval(f, n)),
    ).rejects.toMatchObject({ code: "OVERLAP" });
  });
  it("optional AI honors consent, uses selected saved descriptions, and falls back without credentials", async () => {
    const f = await fixture(),
      s = upload(f.repository.id);
    await uploadSession(f.ctx, s);
    await editSession(f.ctx, s.id, {
      action: "edit",
      version: 1,
      description: "Confirmed dashboard validation work",
    });
    await expect(
      draftDescriptions(f.ctx, {
        entryIds: [],
        sessionIds: [s.id],
        useAI: true,
        confirmedSharing: true,
      }),
    ).rejects.toMatchObject({ code: "AI_CONSENT_REQUIRED" });
    await db.execute(
      sql`UPDATE workspace SET ai_enabled=true WHERE id=${f.w.id}`,
    );
    const result = await draftDescriptions(f.ctx, {
      entryIds: [],
      sessionIds: [s.id],
      useAI: true,
      confirmedSharing: true,
    });
    expect(result.provider).toBe("template");
    expect(result.suggestions[0].description).toBe(
      "Confirmed dashboard validation work",
    );
    expect((await developmentSessions(f.ctx))[0].status).toBe("suggested");
  });
  it("legacy evidence reassignment no longer silently changes repository defaults", async () => {
    const f = await fixture(),
      c = await createClient(f.ctx, { name: "B", email: "b@example.test" }),
      p = await createProject(f.ctx, {
        clientId: c.id,
        name: "B project",
        model: "hourly",
      });
    await ingest(f.ctx, {
      identity: f.repository.identity,
      commits: [{ ref: "a".repeat(40), occurredAt: new Date().toISOString() }],
    });
    const s = await required(
      sql`SELECT * FROM activity_suggestion WHERE workspace_id=${f.w.id}`,
    );
    await reviewSuggestion(f.ctx, s.id, {
      status: "accepted",
      projectId: p.id,
    });
    expect(
      (
        await required(
          sql`SELECT project_id FROM repository_mapping WHERE id=${f.repository.id}`,
        )
      ).project_id,
    ).toBe(f.project.id);
    await expect(
      reviewSuggestion(f.ctx, s.id, { status: "accepted" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
