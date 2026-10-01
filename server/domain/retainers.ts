import {
  sql,
  rows,
  one,
  required,
  audit,
  AppError,
  type Context,
  type Executor,
} from "../db/index.js";
import { mutate } from "./common.js";
export async function consumePrepaid(
  tx: Executor,
  ctx: Context,
  entryId: string,
) {
  const e = await required(
    sql`SELECT * FROM time_entry WHERE id=${entryId} AND workspace_id=${ctx.workspaceId} FOR UPDATE`,
    tx,
  );
  if (!e.billable || e.treatment !== "prepaid") return;
  let remaining = e.actual_seconds;
  // Partition the interval while consuming. Two buckets cannot cover the same seconds.
  let uncovered: [number, number][] = [
    [+new Date(e.started_at), +new Date(e.ended_at)],
  ];
  const buckets = await rows(
    sql`SELECT b.* FROM retainer_bucket b WHERE b.workspace_id=${ctx.workspaceId} AND b.project_id=${e.project_id} AND b.activated_at IS NOT NULL AND b.activated_at<=${e.ended_at} AND (b.expires_at IS NULL OR b.expires_at>${e.started_at}) ORDER BY b.expires_at NULLS LAST,b.activated_at,b.id FOR UPDATE`,
    tx,
  );
  for (const b of buckets) {
    const { balance } = await required(
      sql`SELECT COALESCE(sum(seconds),0)::integer balance FROM retainer_ledger_entry WHERE bucket_id=${b.id} AND workspace_id=${ctx.workspaceId}`,
      tx,
    );
    let available = Math.max(0, balance),
      take = 0;
    const replacement: [number, number][] = [];
    for (const [start, end] of uncovered) {
      const a = Math.max(start, +new Date(b.activated_at));
      const stop = Math.min(end, b.expires_at ? +new Date(b.expires_at) : end);
      const used = Math.min(
        available,
        Math.max(0, Math.floor((stop - a) / 1000)),
      );
      if (!used) {
        replacement.push([start, end]);
        continue;
      }
      if (start < a) replacement.push([start, a]);
      if (a + used * 1000 < end) replacement.push([a + used * 1000, end]);
      take += used;
      available -= used;
    }
    uncovered = replacement;
    if (take > 0) {
      const inserted = await one(
        sql`INSERT INTO retainer_ledger_entry(workspace_id,bucket_id,time_entry_id,kind,seconds,source_key,reason) VALUES(${ctx.workspaceId},${b.id},${e.id},'consume',${-take},${`consume:${e.id}:${e.version}:${b.id}`},'Confirmed project work') ON CONFLICT(source_key) DO NOTHING RETURNING id`,
        tx,
      );
      if (!inserted)
        throw new AppError(
          "COVERAGE_CONFLICT",
          "Coverage was already recorded; refresh the entry.",
        );
      remaining -= take;
    }
    if (!remaining) break;
  }
  await tx.execute(
    sql`UPDATE time_entry SET covered_seconds=${e.actual_seconds - remaining},treatment=${remaining > 0 ? "overage" : "prepaid"},billed_seconds=0 WHERE id=${e.id} AND workspace_id=${ctx.workspaceId}`,
  );
}
export async function reverseConsumption(
  tx: Executor,
  ctx: Context,
  entryId: string,
) {
  for (const item of await rows(
    sql`SELECT l.* FROM retainer_ledger_entry l WHERE l.workspace_id=${ctx.workspaceId} AND l.time_entry_id=${entryId} AND l.kind='consume' AND NOT EXISTS(SELECT 1 FROM retainer_ledger_entry r WHERE r.reverses_id=l.id)`,
    tx,
  )) {
    await tx.execute(
      sql`INSERT INTO retainer_ledger_entry(workspace_id,bucket_id,time_entry_id,reverses_id,kind,seconds,source_key,reason) VALUES(${ctx.workspaceId},${item.bucket_id},${entryId},${item.id},'reverse',${-item.seconds},${`reverse:${item.id}`},'Owner corrected unbilled time')`,
    );
    const bucket = await required(
      sql`SELECT expires_at FROM retainer_bucket WHERE id=${item.bucket_id}`,
      tx,
    );
    if (bucket.expires_at && +new Date(bucket.expires_at) <= Date.now())
      await tx.execute(
        sql`INSERT INTO retainer_ledger_entry(workspace_id,bucket_id,kind,seconds,source_key,reason) VALUES(${ctx.workspaceId},${item.bucket_id},'expire',${item.seconds},${`expire-reversal:${item.id}`},'Returned coverage had already expired')`,
      );
  }
}
export async function grantPaidBuckets(
  tx: Executor,
  ctx: Context,
  invoiceId: string,
  paymentId: string,
) {
  const buckets = await rows(
    sql`SELECT b.* FROM retainer_bucket b JOIN invoice_source_allocation a ON a.bucket_id=b.id AND a.workspace_id=b.workspace_id WHERE a.invoice_id=${invoiceId} AND a.workspace_id=${ctx.workspaceId} AND a.released_at IS NULL FOR UPDATE OF b`,
    tx,
  );
  for (const b of buckets) {
    await tx.execute(
      sql`INSERT INTO retainer_ledger_entry(workspace_id,bucket_id,payment_id,kind,seconds,source_key,reason) VALUES(${ctx.workspaceId},${b.id},${paymentId},'grant',${b.purchased_seconds},${`grant:${b.id}`},'Purchase confirmed paid') ON CONFLICT DO NOTHING`,
    );
    await tx.execute(
      sql`UPDATE retainer_bucket SET activated_at=COALESCE(activated_at,now()) WHERE id=${b.id} AND workspace_id=${ctx.workspaceId}`,
    );
  }
}
export async function expireBuckets(ctx: Context, now = new Date()) {
  return mutate(ctx, "retainer.expire", {}, async (tx) => {
    for (const b of await rows(
      sql`SELECT * FROM retainer_bucket WHERE workspace_id=${ctx.workspaceId} AND activated_at IS NOT NULL AND expires_at<=${now} FOR UPDATE`,
      tx,
    )) {
      if (
        await one(
          sql`SELECT id FROM retainer_ledger_entry WHERE source_key=${`expire:${b.id}`}`,
          tx,
        )
      )
        continue;
      const { balance } = await required(
        sql`SELECT COALESCE(sum(seconds),0)::integer balance FROM retainer_ledger_entry WHERE bucket_id=${b.id}`,
        tx,
      );
      if (balance > 0) {
        await tx.execute(
          sql`INSERT INTO retainer_ledger_entry(workspace_id,bucket_id,kind,seconds,source_key,reason) VALUES(${ctx.workspaceId},${b.id},'expire',${-balance},${`expire:${b.id}`},'Bucket expiry reached')`,
        );
        await audit(tx, ctx, "retainer.expired", b.id, { seconds: balance });
      }
    }
    return { ok: true };
  });
}
export async function createBucket(
  ctx: Context,
  input: {
    projectId: string;
    name: string;
    seconds: number;
    price: number;
    expiresAt?: string | null;
  },
) {
  return mutate(ctx, "retainer.create", input, async (tx) => {
    const p = await required(
      sql`SELECT model FROM project WHERE workspace_id=${ctx.workspaceId} AND id=${input.projectId}`,
      tx,
    );
    if (p.model !== "prepaid")
      throw new AppError(
        "WRONG_MODEL",
        "Hours buckets require a prepaid project.",
      );
    const b = await required(
      sql`INSERT INTO retainer_bucket(workspace_id,project_id,name,purchased_seconds,price,expires_at) VALUES(${ctx.workspaceId},${input.projectId},${input.name},${input.seconds},${input.price},${input.expiresAt ?? null}) RETURNING *`,
      tx,
    );
    await audit(tx, ctx, "retainer.created", b.id);
    return b;
  });
}
