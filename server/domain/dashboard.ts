import { sql, rows, one, required, db, type Context } from "../db/index.js";
import { entries, getTimer } from "./time.js";
import { reports, projectReports } from "./reporting.js";
import { nextDates } from "./agreements.js";
import { config } from "../config.js";
export async function snapshot(ctx: Context, from: string, to: string) {
  const [
    workspace,
    user,
    timer,
    clients,
    projects,
    work,
    invoices,
    buckets,
    payments,
    notifications,
    suggestions,
    milestones,
    periods,
    agreements,
    tasks,
    repositories,
    account,
    operations,
    closes,
    metrics,
  ] = await Promise.all([
    required(sql`SELECT * FROM workspace WHERE id=${ctx.workspaceId}`),
    required(sql`SELECT name,email FROM "user" WHERE id=${ctx.userId}`),
    getTimer(ctx),
    rows(
      sql`SELECT c.*,(SELECT count(*)::integer FROM project p WHERE p.client_id=c.id) project_count,(SELECT COALESCE(sum(GREATEST(total-paid_amount,0)),0)::integer FROM invoice i WHERE i.client_id=c.id AND issuance_state='issued') outstanding FROM client c WHERE c.workspace_id=${ctx.workspaceId} ORDER BY c.name`,
    ),
    projectReports(ctx),
    entries(ctx),
    rows(
      sql`SELECT i.*,c.name client_name FROM invoice i JOIN client c ON c.id=i.client_id WHERE i.workspace_id=${ctx.workspaceId} ORDER BY i.created_at DESC`,
    ),
    rows(
      sql`SELECT b.*,p.name project_name,c.name client_name,COALESCE((SELECT sum(l.seconds)::integer FROM retainer_ledger_entry l WHERE l.bucket_id=b.id),0) balance,COALESCE((SELECT -sum(l.seconds)::integer FROM retainer_ledger_entry l WHERE l.bucket_id=b.id AND kind IN ('consume','reverse')),0) consumed,a.invoice_id FROM retainer_bucket b JOIN project p ON p.id=b.project_id JOIN client c ON c.id=p.client_id LEFT JOIN invoice_source_allocation a ON a.bucket_id=b.id AND a.released_at IS NULL WHERE b.workspace_id=${ctx.workspaceId} ORDER BY b.created_at`,
    ),
    rows(
      sql`SELECT p.*,i.number,c.name client_name FROM payment p JOIN invoice i ON i.id=p.invoice_id JOIN client c ON c.id=i.client_id WHERE p.workspace_id=${ctx.workspaceId} ORDER BY p.received_at DESC`,
    ),
    rows(
      sql`SELECT * FROM notification WHERE workspace_id=${ctx.workspaceId} AND resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until<now()) ORDER BY created_at DESC`,
    ),
    rows(
      sql`SELECT s.*,e.subject,e.commit_ref,p.name project_name FROM activity_suggestion s JOIN activity_evidence e ON e.id=s.evidence_id JOIN project p ON p.id=s.project_id WHERE s.workspace_id=${ctx.workspaceId} ORDER BY e.occurred_at DESC`,
    ),
    rows(
      sql`SELECT m.*,p.client_id,a.invoice_id FROM fixed_milestone m JOIN project p ON p.id=m.project_id LEFT JOIN invoice_source_allocation a ON a.milestone_id=m.id AND a.released_at IS NULL WHERE m.workspace_id=${ctx.workspaceId}`,
    ),
    rows(
      sql`SELECT b.*,ag.project_id,p.client_id,p.name project_name,a.invoice_id FROM billing_period b JOIN billing_agreement ag ON ag.id=b.agreement_id JOIN project p ON p.id=ag.project_id LEFT JOIN invoice_source_allocation a ON a.period_id=b.id AND a.released_at IS NULL WHERE b.workspace_id=${ctx.workspaceId}`,
    ),
    rows(
      sql`SELECT a.*,COALESCE((SELECT fee FROM agreement_term_change t WHERE t.agreement_id=a.id AND t.effective_on<=(now() AT TIME ZONE a.timezone)::date ORDER BY t.effective_on DESC LIMIT 1),a.fee) fee,(SELECT jsonb_build_object('fee',t.fee,'effective_on',t.effective_on) FROM agreement_term_change t WHERE t.agreement_id=a.id AND t.effective_on>(now() AT TIME ZONE a.timezone)::date ORDER BY t.effective_on LIMIT 1) next_terms,p.name project_name FROM billing_agreement a JOIN project p ON p.id=a.project_id WHERE a.workspace_id=${ctx.workspaceId}`,
    ),
    rows(
      sql`SELECT * FROM project_task WHERE workspace_id=${ctx.workspaceId} ORDER BY title`,
    ),
    rows(
      sql`SELECT * FROM repository_mapping WHERE workspace_id=${ctx.workspaceId}`,
    ),
    one(
      sql`SELECT provider,account_id,ready,disconnected_at FROM connected_payment_account WHERE workspace_id=${ctx.workspaceId}`,
    ),
    rows(
      sql`SELECT id,invoice_id,state,action,error_code,created_at FROM payment_operation WHERE workspace_id=${ctx.workspaceId} ORDER BY created_at DESC LIMIT 100`,
    ),
    rows(
      sql`SELECT * FROM close_review WHERE workspace_id=${ctx.workspaceId} ORDER BY starts_on DESC LIMIT 10`,
    ),
    reports(ctx, from, to),
  ]);
  return {
    workspace,
    user,
    timer,
    serverTime: new Date().toISOString(),
    clients,
    projects,
    entries: work,
    invoices,
    buckets,
    payments,
    notifications,
    suggestions,
    milestones,
    periods,
    agreements: agreements.map((a) => ({
      ...a,
      next_dates: nextDates(
        String(a.anchor),
        a.frequency,
        new Date().toISOString().slice(0, 10),
      ),
    })),
    tasks,
    repositories,
    account: account ?? null,
    operations,
    closes,
    metrics,
    mode: config.BILLING_MODE,
  };
}
export async function refreshReminders(ctx: Context) {
  const items: {
    key: string;
    title: string;
    detail: string;
    target: string;
    kind: string;
  }[] = [];
  const timer = await getTimer(ctx);
  if (
    timer &&
    timer.state === "running" &&
    Date.now() - +new Date(timer.segment_started_at) > 12 * 3600000
  )
    items.push({
      key: `timer:${timer.id}`,
      title: "A timer may have been left running",
      detail: `${timer.project_name} has been running for over 12 hours. Review its end time.`,
      target: "time",
      kind: "warning",
    });
  const work = await entries(ctx);
  const review = work.filter((e) => !e.reviewed && !e.invoice_id);
  if (review.length)
    items.push({
      key: "unreviewed",
      title: `${review.length} entries need a second look`,
      detail: "Add missing descriptions and review overlaps before billing.",
      target: "time",
      kind: "review",
    });
  const eligible = work.filter(
    (e) => e.treatment === "hourly" && !e.invoice_id && e.reviewed,
  );
  if (eligible.length)
    items.push({
      key: "unbilled",
      title: `${eligible.length} entries are ready to bill`,
      detail: "Turn reviewed work into an invoice draft in Friday Close.",
      target: "billing",
      kind: "billing",
    });
  for (const i of await rows(
    sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND issuance_state<>'void'`,
  )) {
    if (i.collection_state === "failed")
      items.push({
        key: `failed:${i.id}`,
        title: `${i.number} needs payment follow-up`,
        detail: "Collection failed. Review before authorizing another attempt.",
        target: `invoice/${i.id}`,
        kind: "warning",
      });
    else if (
      i.issuance_state === "issued" &&
      i.paid_amount < i.total &&
      +new Date(i.due_at) < Date.now()
    )
      items.push({
        key: `overdue:${i.id}`,
        title: `${i.number} is overdue`,
        detail:
          "Check the outstanding balance and contact your client when appropriate.",
        target: `invoice/${i.id}`,
        kind: "warning",
      });
    else if (i.issuance_state === "local" && i.approval_state === "review")
      items.push({
        key: `approval:${i.id}`,
        title: `${i.number} is ready for your review`,
        detail: "Nothing will be sent or charged until you explicitly approve.",
        target: `invoice/${i.id}`,
        kind: "review",
      });
  }
  for (const b of await rows(
    sql`SELECT b.*,COALESCE(sum(l.seconds),0)::integer balance FROM retainer_bucket b LEFT JOIN retainer_ledger_entry l ON l.bucket_id=b.id WHERE b.workspace_id=${ctx.workspaceId} AND b.activated_at IS NOT NULL GROUP BY b.id`,
  )) {
    if (
      b.balance > 0 &&
      b.expires_at &&
      +new Date(b.expires_at) > Date.now() &&
      +new Date(b.expires_at) < Date.now() + 7 * 86400000
    )
      items.push({
        key: `expiry:${b.id}`,
        title: `${b.name} expires soon`,
        detail: `Unused coverage expires ${new Date(b.expires_at).toISOString().slice(0, 10)}. Review upcoming work.`,
        target: "billing",
        kind: "warning",
      });
    if (b.balance <= b.purchased_seconds / 5)
      items.push({
        key: `low:${b.id}`,
        title: `${b.name} is running low`,
        detail: `${Math.max(0, b.balance / 3600).toFixed(1)} hours remain. Top-ups always need approval.`,
        target: "billing",
        kind: "warning",
      });
  }
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE notification SET resolved_at=now() WHERE workspace_id=${ctx.workspaceId} AND NOT (dedup_key=ANY(${sql.param(items.map((i) => i.key))}::text[]))`,
    );
    for (const i of items)
      await tx.execute(
        sql`INSERT INTO notification(workspace_id,dedup_key,title,detail,target,kind) VALUES(${ctx.workspaceId},${i.key},${i.title},${i.detail},${i.target},${i.kind}) ON CONFLICT(workspace_id,dedup_key) DO UPDATE SET title=excluded.title,detail=excluded.detail,resolved_at=NULL`,
      );
  });
}
