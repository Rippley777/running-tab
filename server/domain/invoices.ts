import { z } from "zod";
import {
  DraftInput,
  InvoiceEdit,
  ApprovalInput,
} from "../../shared/contracts.js";
import {
  sql,
  rows,
  one,
  required,
  audit,
  recent,
  AppError,
  type Context,
  type Executor,
} from "../db/index.js";
import { mutate, randomUUID } from "./common.js";
import { timeValue, invoiceTotals, snapshotHash } from "./math.js";
import { config } from "../config.js";
export async function invoiceSnapshot(tx: Executor, ctx: Context, id: string) {
  const inv = await required(
    sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
    tx,
  );
  const lines = await rows(
    sql`SELECT id,project_id,description,quantity_seconds,unit_rate,amount,source_kind,service_start,service_end FROM invoice_line WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id} ORDER BY id`,
    tx,
  );
  const sources = await rows(
    sql`SELECT time_entry_id,milestone_id,period_id,bucket_id,line_id FROM invoice_source_allocation WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id} AND released_at IS NULL ORDER BY id`,
    tx,
  );
  return {
    invoiceId: id,
    revision: inv.revision,
    clientId: inv.client_id,
    currency: inv.currency,
    total: inv.total,
    subtotal: inv.subtotal,
    discount: inv.discount,
    taxBps: inv.tax_bps,
    tax: inv.tax,
    memo: inv.memo,
    poReference: inv.po_reference,
    dueAt: inv.due_at,
    business: inv.business_snapshot,
    client: inv.client_snapshot,
    lines,
    sources,
  };
}
export async function saveRevision(tx: Executor, ctx: Context, id: string) {
  const snapshot = await invoiceSnapshot(tx, ctx, id);
  const hash = snapshotHash(snapshot);
  await tx.execute(
    sql`INSERT INTO invoice_revision(workspace_id,invoice_id,revision,snapshot,hash) VALUES(${ctx.workspaceId},${id},${snapshot.revision},${JSON.stringify(snapshot)}::jsonb,${hash})`,
  );
  return hash;
}
type Source = {
  id: string;
  kind: "time" | "milestone" | "bucket" | "period";
  projectId: string;
  projectName: string;
  description: string;
  seconds: number;
  rate: number;
  amount: number;
  start: Date | null;
  end: Date | null;
  group: string;
};
export async function createDraft(
  ctx: Context,
  data: z.input<typeof DraftInput>,
  key?: string,
) {
  const v = DraftInput.parse(data);
  return mutate(
    ctx,
    "invoice.draft",
    v,
    async (tx) => {
      const client = await required(
        sql`SELECT * FROM client WHERE workspace_id=${ctx.workspaceId} AND id=${v.clientId} AND archived_at IS NULL`,
        tx,
      );
      const w = await required(
        sql`SELECT * FROM workspace WHERE id=${ctx.workspaceId}`,
        tx,
      );
      const sources: Source[] = [];
      if (
        !v.timeEntryIds.length &&
        !v.milestoneIds.length &&
        !v.periodIds.length &&
        !v.bucketIds.length
      )
        throw new AppError("NO_SOURCES", "Select eligible work to invoice.");
      if (
        new Set([
          ...v.timeEntryIds,
          ...v.milestoneIds,
          ...v.periodIds,
          ...v.bucketIds,
        ]).size !==
        v.timeEntryIds.length +
          v.milestoneIds.length +
          v.periodIds.length +
          v.bucketIds.length
      )
        throw new AppError(
          "DUPLICATE_SOURCE",
          "A source may only be selected once.",
        );
      for (const id of v.timeEntryIds) {
        const e = await required(
          sql`SELECT e.*,p.name project_name,p.client_id,t.title task_title FROM time_entry e JOIN project p ON p.id=e.project_id LEFT JOIN project_task t ON t.id=e.task_id WHERE e.id=${id} AND e.workspace_id=${ctx.workspaceId} AND e.deleted_at IS NULL FOR UPDATE OF e`,
          tx,
        );
        if (
          e.client_id !== client.id ||
          e.treatment !== "hourly" ||
          !e.billable ||
          e.billed_seconds <= 0
        )
          throw new AppError(
            "INELIGIBLE_SOURCE",
            "This time is not eligible hourly work for this client.",
          );
        if (!e.reviewed || !e.description.trim())
          throw new AppError(
            "REVIEW_REQUIRED",
            "Review work and add descriptions before creating a draft.",
          );
        sources.push({
          id,
          kind: "time",
          projectId: e.project_id,
          projectName: e.project_name,
          description: e.description,
          seconds: e.billed_seconds,
          rate: e.rate,
          amount: timeValue(e.billed_seconds, e.rate),
          start: e.started_at,
          end: e.ended_at,
          group:
            v.groupBy === "task"
              ? (e.task_title ?? "General work")
              : v.groupBy === "date"
                ? new Intl.DateTimeFormat("en-CA", {
                    timeZone: w.timezone,
                  }).format(e.started_at)
                : "",
        });
      }
      for (const [ids, kind] of [
        [v.milestoneIds, "milestone"],
        [v.periodIds, "period"],
        [v.bucketIds, "bucket"],
      ] as const) {
        for (const id of ids) {
          let item: Record<string, any>;
          if (kind === "milestone")
            item = await required(
              sql`SELECT m.*,p.name project_name,p.client_id FROM fixed_milestone m JOIN project p ON p.id=m.project_id WHERE m.id=${id} AND m.workspace_id=${ctx.workspaceId} AND m.ready=true FOR UPDATE OF m`,
              tx,
            );
          else if (kind === "bucket")
            item = await required(
              sql`SELECT b.*,p.name project_name,p.client_id FROM retainer_bucket b JOIN project p ON p.id=b.project_id WHERE b.id=${id} AND b.workspace_id=${ctx.workspaceId} AND b.activated_at IS NULL FOR UPDATE OF b`,
              tx,
            );
          else
            item = await required(
              sql`SELECT b.*,a.project_id,p.name project_name,p.client_id FROM billing_period b JOIN billing_agreement a ON a.id=b.agreement_id JOIN project p ON p.id=a.project_id WHERE b.id=${id} AND b.workspace_id=${ctx.workspaceId} FOR UPDATE OF b`,
              tx,
            );
          if (item.client_id !== client.id)
            throw new AppError(
              "CLIENT_MISMATCH",
              "An invoice can only contain work for one client.",
            );
          sources.push({
            id,
            kind,
            projectId: item.project_id,
            projectName: item.project_name,
            description:
              kind === "milestone"
                ? item.title
                : kind === "bucket"
                  ? `${item.name} · ${item.purchased_seconds / 3600} prepaid hours`
                  : `${item.project_name} · support ${String(item.starts_on).slice(0, 10)} – ${String(item.ends_on).slice(0, 10)}`,
            seconds: kind === "bucket" ? item.purchased_seconds : 0,
            rate: 0,
            amount: item.amount ?? item.price ?? item.fee,
            start: null,
            end: null,
            group: id,
          });
        }
      }
      for (const s of sources) {
        const col = {
          time: "time_entry_id",
          milestone: "milestone_id",
          bucket: "bucket_id",
          period: "period_id",
        }[s.kind];
        if (
          await one(
            sql`SELECT id FROM invoice_source_allocation WHERE workspace_id=${ctx.workspaceId} AND ${sql.identifier(col)}=${s.id} AND released_at IS NULL`,
            tx,
          )
        )
          throw new AppError(
            "SOURCE_ALLOCATED",
            "Some selected work is already allocated to an invoice.",
            409,
          );
      }
      const { count } = await required(
        sql`SELECT count(*)::integer count FROM invoice WHERE workspace_id=${ctx.workspaceId}`,
        tx,
      );
      const number = `RT-${String(count + 1).padStart(4, "0")}`;
      const total = invoiceTotals(sources.map((s) => s.amount));
      const inv = await required(
        sql`INSERT INTO invoice(workspace_id,client_id,number,subtotal,total,business_snapshot,client_snapshot,due_at,provider) VALUES(${ctx.workspaceId},${client.id},${number},${total.subtotal},${total.total},${JSON.stringify({ name: w.name, email: w.business_email, address: w.business_address })}::jsonb,${JSON.stringify({ name: client.name, email: client.email, address: client.address })}::jsonb,${new Date(Date.now() + (client.payment_terms ?? w.payment_terms) * 86400000)},${config.BILLING_MODE}) RETURNING *`,
        tx,
      );
      const groups = new Map<string, Source[]>();
      for (const s of sources) {
        const k = `${s.projectId}:${s.kind}:${s.rate}:${s.group}`;
        groups.set(k, [...(groups.get(k) ?? []), s]);
      }
      for (const items of groups.values()) {
        const first = items[0];
        const description =
          first.kind === "time"
            ? `${first.projectName}${first.group ? ` · ${first.group}` : ""} — ${[...new Set(items.map((s) => s.description))].join("; ").slice(0, 1500)}`
            : first.description;
        const line = await required(
          sql`INSERT INTO invoice_line(workspace_id,invoice_id,project_id,description,quantity_seconds,unit_rate,amount,source_kind,service_start,service_end) VALUES(${ctx.workspaceId},${inv.id},${first.projectId},${description},${items.reduce((n, s) => n + s.seconds, 0)},${first.rate},${items.reduce((n, s) => n + s.amount, 0)},${first.kind},${first.start},${items.at(-1)!.end}) RETURNING id`,
          tx,
        );
        for (const s of items) {
          await tx.execute(
            sql`INSERT INTO invoice_source_allocation(workspace_id,invoice_id,line_id,time_entry_id,milestone_id,period_id,bucket_id) VALUES(${ctx.workspaceId},${inv.id},${line.id},${s.kind === "time" ? s.id : null},${s.kind === "milestone" ? s.id : null},${s.kind === "period" ? s.id : null},${s.kind === "bucket" ? s.id : null})`,
          );
        }
      }
      await saveRevision(tx, ctx, inv.id);
      await audit(tx, ctx, "invoice.drafted", inv.id, {
        total: total.total,
        sourceCount: sources.length,
      });
      return inv;
    },
    key,
  );
}
export async function editInvoice(
  ctx: Context,
  id: string,
  data: z.input<typeof InvoiceEdit>,
) {
  const v = InvoiceEdit.parse(data);
  return mutate(ctx, "invoice.edit", { id, ...v }, async (tx) => {
    const inv = await required(
      sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
      tx,
    );
    if (inv.issuance_state !== "local")
      throw new AppError(
        "INVOICE_LOCKED",
        "Issued or queued invoices cannot be edited.",
      );
    if (inv.revision !== v.revision)
      throw new AppError(
        "CONFLICT",
        "The invoice was edited elsewhere. Reload before saving.",
        409,
      );
    const lines = await rows(
      sql`SELECT * FROM invoice_line WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id}`,
      tx,
    );
    if (
      lines.length !== v.lines.length ||
      new Set(v.lines.map((l) => l.id)).size !== lines.length ||
      v.lines.some((l) => !lines.find((x) => x.id === l.id))
    )
      throw new AppError(
        "LINE_MISMATCH",
        "Line content must match this invoice.",
      );
    const totals = invoiceTotals(
      lines.map((l) => l.amount),
      v.discount,
      v.taxBps,
    );
    for (const l of v.lines)
      await tx.execute(
        sql`UPDATE invoice_line SET description=${l.description} WHERE id=${l.id} AND workspace_id=${ctx.workspaceId}`,
      );
    await tx.execute(
      sql`UPDATE invoice SET memo=${v.memo},po_reference=${v.poReference},due_at=${v.dueAt ? new Date(v.dueAt) : inv.due_at},discount=${v.discount},tax_bps=${v.taxBps},tax=${totals.tax},total=${totals.total},revision=revision+1,approval_state='draft' WHERE id=${id} AND workspace_id=${ctx.workspaceId}`,
    );
    await tx.execute(
      sql`UPDATE invoice_approval SET invalidated_at=now() WHERE invoice_id=${id} AND workspace_id=${ctx.workspaceId} AND invalidated_at IS NULL`,
    );
    await saveRevision(tx, ctx, id);
    await audit(tx, ctx, "invoice.revised", id, { revision: v.revision + 1 });
    return { ok: true };
  });
}
export async function requestReview(ctx: Context, id: string) {
  return mutate(ctx, "invoice.review", { id }, async (tx) => {
    const inv = await required(
      sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
      tx,
    );
    if (inv.issuance_state !== "local")
      throw new AppError(
        "INVOICE_LOCKED",
        "This invoice is already queued or issued.",
      );
    await tx.execute(
      sql`UPDATE invoice SET approval_state='review' WHERE id=${id}`,
    );
    await audit(tx, ctx, "invoice.review_requested", id);
    return { ok: true };
  });
}
export async function approveInvoice(
  ctx: Context,
  id: string,
  data: z.input<typeof ApprovalInput>,
  key: string,
) {
  recent(ctx);
  const v = ApprovalInput.parse(data);
  return mutate(
    ctx,
    "invoice.approve",
    { id, ...v },
    async (tx) => {
      const inv = await required(
        sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
        tx,
      );
      if (inv.revision !== v.revision || inv.total !== v.confirmedTotal)
        throw new AppError(
          "APPROVAL_MISMATCH",
          "Invoice content or total changed. Review the current revision.",
          409,
        );
      if (inv.total <= 0)
        throw new AppError(
          "NO_BALANCE",
          "This draft has no payable balance. Review its sources or discard it.",
        );
      if (
        inv.issuance_state === "void" ||
        inv.collection_state === "paid" ||
        inv.paid_amount > 0 ||
        ["partial", "refunded", "disputed"].includes(inv.collection_state)
      )
        throw new AppError(
          "NOT_COLLECTIBLE",
          "This invoice cannot be collected. Reconcile its payment state.",
        );
      if (
        await one(
          sql`SELECT id FROM payment_operation WHERE invoice_id=${id} AND state IN ('queued','processing','reconcile')`,
          tx,
        )
      )
        throw new AppError(
          "OPERATION_PENDING",
          "An operation is already queued. It will not be duplicated.",
          409,
        );
      if (inv.issuance_state === "issued" && v.action === "send")
        throw new AppError(
          "ALREADY_ISSUED",
          "This invoice is already available to the client.",
        );
      const account = await required(
        sql`SELECT * FROM connected_payment_account WHERE workspace_id=${ctx.workspaceId} AND provider=${inv.provider}`,
        tx,
      );
      if (!account.ready || account.disconnected_at)
        throw new AppError(
          "ACCOUNT_NOT_READY",
          "Complete or reconnect payment setup before approval.",
        );
      let consent: any = null,
        profile: any = null;
      if (v.action === "charge") {
        profile = await one(
          sql`SELECT * FROM client_payment_profile WHERE workspace_id=${ctx.workspaceId} AND client_id=${inv.client_id} AND provider=${inv.provider} AND account_id=${account.account_id}`,
          tx,
        );
        if (!profile?.payment_method_id)
          throw new AppError(
            "PAYMENT_METHOD_REQUIRED",
            "No authorized saved payment method is available.",
          );
        consent = await one(
          sql`SELECT * FROM auto_charge_consent WHERE workspace_id=${ctx.workspaceId} AND client_id=${inv.client_id} AND profile_id=${profile.id} AND revoked_at IS NULL ORDER BY accepted_at DESC LIMIT 1`,
          tx,
        );
        if (!consent)
          throw new AppError(
            "CONSENT_REQUIRED",
            "The client has not consented to saved-method charging.",
          );
      }
      const snapshot = await invoiceSnapshot(tx, ctx, id);
      const hash = snapshotHash(snapshot);
      const revision = await required(
        sql`SELECT hash FROM invoice_revision WHERE invoice_id=${id} AND revision=${inv.revision}`,
        tx,
      );
      if (hash !== revision.hash)
        throw new AppError(
          "SNAPSHOT_MISMATCH",
          "Invoice sources changed. Reconcile before approval.",
        );
      await tx.execute(
        sql`UPDATE invoice_approval SET invalidated_at=now() WHERE invoice_id=${id} AND invalidated_at IS NULL`,
      );
      const approval = await required(
        sql`INSERT INTO invoice_approval(workspace_id,invoice_id,revision,snapshot_hash,action,payment_method_id,consent_id,actor_id) VALUES(${ctx.workspaceId},${id},${inv.revision},${hash},${v.action},${profile?.payment_method_id ?? null},${consent?.id ?? null},${ctx.userId}) RETURNING id`,
        tx,
      );
      const operationId = randomUUID();
      await tx.execute(
        sql`INSERT INTO payment_operation(id,workspace_id,invoice_id,approval_id,action,idempotency_key) VALUES(${operationId},${ctx.workspaceId},${id},${approval.id},${v.action},${`rt-v1-${operationId}`})`,
      );
      await tx.execute(
        sql`UPDATE invoice SET approval_state='approved',issuance_state=CASE WHEN issuance_state='local' THEN 'queued' ELSE issuance_state END,collection_state=CASE WHEN ${v.action}='charge' THEN 'processing' ELSE collection_state END WHERE id=${id}`,
      );
      await audit(tx, ctx, `invoice.approved_${v.action}`, id, {
        approvalId: approval.id,
        revision: inv.revision,
        total: inv.total,
      });
      return { operationId, approvalId: approval.id };
    },
    key,
  );
}
export async function voidDraft(ctx: Context, id: string) {
  return mutate(ctx, "invoice.void", { id }, async (tx) => {
    const inv = await required(
      sql`SELECT * FROM invoice WHERE id=${id} AND workspace_id=${ctx.workspaceId} FOR UPDATE`,
      tx,
    );
    if (inv.issuance_state !== "local")
      throw new AppError(
        "INVOICE_LOCKED",
        "Only an unissued local draft can be discarded.",
      );
    await tx.execute(
      sql`UPDATE invoice SET issuance_state='void' WHERE id=${id}`,
    );
    await tx.execute(
      sql`UPDATE invoice_source_allocation SET released_at=now() WHERE invoice_id=${id}`,
    );
    await tx.execute(
      sql`UPDATE invoice_approval SET invalidated_at=now() WHERE invoice_id=${id}`,
    );
    await audit(tx, ctx, "invoice.draft_voided", id);
    return { ok: true };
  });
}
export async function invoiceDetail(ctx: Context, id: string) {
  const invoice = await required(
    sql`SELECT i.*,c.name client_name FROM invoice i JOIN client c ON c.id=i.client_id WHERE i.workspace_id=${ctx.workspaceId} AND i.id=${id}`,
  );
  return {
    invoice,
    lines: await rows(
      sql`SELECT * FROM invoice_line WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id} ORDER BY id`,
    ),
    sources: await rows(
      sql`SELECT a.*,e.description,e.actual_seconds,e.billed_seconds,e.rate FROM invoice_source_allocation a LEFT JOIN time_entry e ON e.id=a.time_entry_id WHERE a.workspace_id=${ctx.workspaceId} AND a.invoice_id=${id} AND a.released_at IS NULL`,
    ),
    approvals: await rows(
      sql`SELECT * FROM invoice_approval WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id} ORDER BY approved_at`,
    ),
    operations: await rows(
      sql`SELECT * FROM payment_operation WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id} ORDER BY created_at`,
    ),
    payments: await rows(
      sql`SELECT * FROM payment WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id}`,
    ),
    timeline: await rows(
      sql`SELECT action,metadata,created_at FROM audit_event WHERE workspace_id=${ctx.workspaceId} AND record_id=${id} ORDER BY created_at`,
    ),
    profile:
      (await one(
        sql`SELECT p.card_suffix,p.id,EXISTS(SELECT 1 FROM auto_charge_consent a WHERE a.profile_id=p.id AND a.revoked_at IS NULL) consent FROM client_payment_profile p WHERE p.workspace_id=${ctx.workspaceId} AND p.client_id=${invoice.client_id} AND p.provider=${invoice.provider}`,
      )) ?? null,
  };
}
