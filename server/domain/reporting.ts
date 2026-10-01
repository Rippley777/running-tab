import { sql, rows, required, type Context } from "../db/index.js";
import { timeValue, ratio } from "./math.js";
import { entries } from "./time.js";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
export async function reports(ctx: Context, from: string, to: string) {
  const w = await required(
    sql`SELECT * FROM workspace WHERE id=${ctx.workspaceId}`,
  );
  const all = await entries(ctx);
  const start = +fromZonedTime(`${from}T00:00:00`, w.timezone),
    end = +fromZonedTime(`${to}T00:00:00`, w.timezone);
  const daily = new Map<
    string,
    { date: string; billable: number; nonbillable: number }
  >();
  let actual = 0,
    billable = 0;
  // Clip intervals to the requested period and split at local midnights (DST-safe).
  for (const e of all) {
    let a = Math.max(start, +new Date(e.started_at));
    const b = Math.min(end, +new Date(e.ended_at));
    if (a >= b) continue;
    const sec = Math.floor((b - a) / 1000);
    actual += sec;
    if (e.billable) billable += sec;
    while (a < b) {
      const day = formatInTimeZone(a, w.timezone, "yyyy-MM-dd");
      const nextDate = new Date(`${day}T12:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const midnight = +fromZonedTime(
        `${nextDate.toISOString().slice(0, 10)}T00:00:00`,
        w.timezone,
      );
      const stop = Math.min(b, midnight);
      const item = daily.get(day) ?? { date: day, billable: 0, nonbillable: 0 };
      item[e.billable ? "billable" : "nonbillable"] += Math.floor(
        (stop - a) / 1000,
      );
      daily.set(day, item);
      a = stop;
    }
  }
  const eligible = all
    .filter(
      (e) =>
        e.treatment === "hourly" &&
        !e.invoice_id &&
        +new Date(e.started_at) >= start &&
        +new Date(e.started_at) < end,
    )
    .reduce((n, e) => n + timeValue(e.billed_seconds, e.rate), 0);
  const invoices = await required<{
    issued_value: number;
    outstanding: number;
  }>(
    sql`SELECT COALESCE(sum(total) FILTER(WHERE issuance_state='issued' AND issued_at>=${new Date(start)} AND issued_at<${new Date(end)}),0)::integer issued_value, COALESCE(sum(GREATEST(total-paid_amount,0)) FILTER(WHERE issuance_state='issued' AND collection_state NOT IN ('refunded','disputed')),0)::integer outstanding FROM invoice WHERE workspace_id=${ctx.workspaceId}`,
  );
  const payments = await required<{ cash: number; fees: number }>(
    sql`SELECT COALESCE(sum(amount),0)::integer cash,COALESCE(sum(fee),0)::integer fees FROM payment WHERE workspace_id=${ctx.workspaceId} AND received_at>=${new Date(start)} AND received_at<${new Date(end)}`,
  );
  const refunds = await required<{ refunds: number }>(
    sql`SELECT COALESCE(sum(amount),0)::integer refunds FROM payment_adjustment WHERE workspace_id=${ctx.workspaceId} AND kind='refund' AND created_at>=${new Date(start)} AND created_at<${new Date(end)}`,
  );
  const days = Math.round(
    (+new Date(`${to}T00:00:00Z`) - +new Date(`${from}T00:00:00Z`)) / 86400000,
  );
  return {
    from,
    to,
    actual_seconds: actual,
    billable_seconds: billable,
    eligible_value: eligible,
    ...invoices,
    ...payments,
    ...refunds,
    utilization: actual ? billable / actual : null,
    capacity_utilization: w.capacity_seconds
      ? billable / ((w.capacity_seconds * days) / 7)
      : null,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
export async function projectReports(ctx: Context) {
  const projects = await rows(
    sql`SELECT p.*,c.name client_name,w.cost_rate workspace_cost,w.target_rate workspace_target FROM project p JOIN client c ON c.id=p.client_id JOIN workspace w ON w.id=p.workspace_id WHERE p.workspace_id=${ctx.workspaceId} ORDER BY p.created_at,p.id`,
  );
  for (const p of projects) {
    const work = await required(
      sql`SELECT COALESCE(sum(actual_seconds),0)::integer actual_seconds,COALESCE(sum(actual_seconds) FILTER(WHERE billable),0)::integer billable_seconds,COALESCE(sum(covered_seconds),0)::integer covered_seconds FROM time_entry WHERE workspace_id=${ctx.workspaceId} AND project_id=${p.id} AND deleted_at IS NULL`,
    );
    const e = await rows(
      sql`SELECT e.* FROM time_entry e WHERE e.workspace_id=${ctx.workspaceId} AND e.project_id=${p.id} AND e.deleted_at IS NULL AND e.treatment='hourly' AND NOT EXISTS(SELECT 1 FROM invoice_source_allocation a WHERE a.time_entry_id=e.id AND a.released_at IS NULL)`,
    );
    const attributed = await rows(
      sql`SELECT l.amount,l.source_kind,i.subtotal,i.discount,i.total,pa.amount payment_amount,pa.service_amount,pa.fee,COALESCE((SELECT sum(ad.amount) FROM payment_adjustment ad WHERE ad.payment_id=pa.id AND ad.kind IN ('refund','credit')),0)::integer refunds FROM invoice_line l JOIN invoice i ON i.id=l.invoice_id JOIN payment pa ON pa.invoice_id=i.id WHERE l.workspace_id=${ctx.workspaceId} AND l.project_id=${p.id}`,
    );
    let cash = 0,
      service = 0,
      fees = 0;
    for (const a of attributed) {
      if (a.subtotal <= 0) continue;
      cash += ratio(BigInt(a.payment_amount) * BigInt(a.amount), a.subtotal);
      const allocated = ratio(
        BigInt(a.service_amount) * BigInt(a.amount),
        a.subtotal,
      );
      const refunded = ratio(
        BigInt(Math.min(a.refunds, a.payment_amount)) * BigInt(allocated),
        a.payment_amount,
      );
      if (a.source_kind !== "bucket")
        service += Math.max(0, allocated - refunded);
      fees += ratio(BigInt(a.fee ?? 0) * BigInt(a.amount), a.subtotal);
    }
    // Prepaid service allocation recognizes consumed coverage analytically, never as new cash.
    const prepaid = await rows(
      sql`SELECT b.id,b.purchased_seconds,COALESCE(-sum(l.seconds) FILTER(WHERE l.kind IN ('consume','reverse')),0)::integer consumed FROM retainer_bucket b LEFT JOIN retainer_ledger_entry l ON l.bucket_id=b.id WHERE b.workspace_id=${ctx.workspaceId} AND b.project_id=${p.id} AND b.activated_at IS NOT NULL GROUP BY b.id`,
    );
    for (const b of prepaid) {
      const funding = await rows(
        sql`SELECT l.amount,i.subtotal,pa.service_amount,pa.amount payment_amount,COALESCE((SELECT sum(ad.amount) FROM payment_adjustment ad WHERE ad.payment_id=pa.id AND ad.kind IN ('refund','credit')),0)::integer refunds FROM invoice_source_allocation a JOIN invoice_line l ON l.id=a.line_id JOIN invoice i ON i.id=a.invoice_id JOIN payment pa ON pa.invoice_id=i.id WHERE a.bucket_id=${b.id} AND a.workspace_id=${ctx.workspaceId} AND a.released_at IS NULL`,
      );
      let funded = 0;
      for (const f of funding)
        if (f.subtotal > 0 && f.payment_amount > 0) {
          const net = ratio(
            BigInt(f.service_amount) * BigInt(f.amount),
            f.subtotal,
          );
          funded +=
            net -
            ratio(
              BigInt(Math.min(f.refunds, f.payment_amount)) * BigInt(net),
              f.payment_amount,
            );
        }
      service += ratio(
        BigInt(funded) *
          BigInt(Math.min(b.purchased_seconds, Math.max(0, b.consumed))),
        b.purchased_seconds,
      );
    }
    const cost = p.cost_rate ?? p.workspace_cost;
    const labor = cost == null ? null : timeValue(work.actual_seconds, cost);
    const target = p.target_rate ?? p.workspace_target;
    Object.assign(p, work, {
      cash,
      service_cash: service,
      eligible_value: e.reduce(
        (n, x) => n + timeValue(x.billed_seconds, x.rate),
        0,
      ),
      realized_rate: work.actual_seconds
        ? ratio(BigInt(service) * 3600n, work.actual_seconds)
        : null,
      projected_rate:
        p.model === "fixed" && p.estimate_seconds
          ? ratio(BigInt(p.fee) * 3600n, p.estimate_seconds)
          : null,
      underquote:
        p.model === "fixed" && target != null
          ? Math.max(0, timeValue(work.actual_seconds, target) - p.fee)
          : 0,
      contribution: labor == null ? null : service - labor - fees,
      contribution_margin:
        labor == null || !service ? null : (service - labor - fees) / service,
      cost_rate: cost,
      target_rate: target,
    });
  }
  return projects;
}
