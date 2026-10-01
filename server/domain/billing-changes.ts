import {
  sql,
  required,
  one,
  audit,
  AppError,
  recent,
  type Context,
} from "../db/index.js";
import { mutate } from "./common.js";
import { nextDates } from "./agreements.js";
import { formatInTimeZone } from "date-fns-tz";
export async function splitMilestone(
  ctx: Context,
  id: string,
  input: { title: string; amount: number },
  key: string,
) {
  return mutate(
    ctx,
    "milestone.split",
    { id, ...input },
    async (tx) => {
      const old = await required(
        sql`SELECT * FROM fixed_milestone WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
        tx,
      );
      if (
        await one(
          sql`SELECT id FROM invoice_source_allocation WHERE workspace_id=${ctx.workspaceId} AND milestone_id=${id} AND released_at IS NULL`,
          tx,
        )
      )
        throw new AppError(
          "SOURCE_ALLOCATED",
          "This milestone is reserved by an invoice.",
          409,
        );
      if (input.amount <= 0 || input.amount >= old.amount)
        throw new AppError(
          "INVALID_SPLIT",
          "The new milestone must be smaller than the remaining original milestone.",
        );
      await tx.execute(
        sql`UPDATE fixed_milestone SET amount=amount-${input.amount},ready=false WHERE id=${id}`,
      );
      const created = await required(
        sql`INSERT INTO fixed_milestone(workspace_id,project_id,title,amount) VALUES(${ctx.workspaceId},${old.project_id},${input.title},${input.amount}) RETURNING *`,
        tx,
      );
      await audit(tx, ctx, "milestone.split", id, {
        newMilestone: created.id,
        amount: input.amount,
        agreedTotalUnchanged: true,
      });
      return created;
    },
    key,
  );
}
export async function adjustBucket(
  ctx: Context,
  id: string,
  input: { seconds: number; reason: string },
  key: string,
) {
  recent(ctx);
  return mutate(
    ctx,
    "retainer.adjust",
    { id, ...input },
    async (tx) => {
      const b = await required(
        sql`SELECT * FROM retainer_bucket WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
        tx,
      );
      if (!b.activated_at)
        throw new AppError(
          "UNFUNDED_BUCKET",
          "Confirm the purchase payment before adjusting funded coverage.",
        );
      if (
        input.seconds > 0 &&
        b.expires_at &&
        +new Date(b.expires_at) <= Date.now()
      )
        throw new AppError(
          "BUCKET_EXPIRED",
          "Expired coverage cannot be restored with an adjustment.",
        );
      const { balance } = await required(
        sql`SELECT COALESCE(sum(seconds),0)::int balance FROM retainer_ledger_entry WHERE bucket_id=${id}`,
        tx,
      );
      if (balance + input.seconds < 0)
        throw new AppError(
          "NEGATIVE_BALANCE",
          "An adjustment cannot remove more hours than remain.",
        );
      const entry = await required(
        sql`INSERT INTO retainer_ledger_entry(workspace_id,bucket_id,kind,seconds,source_key,reason) VALUES(${ctx.workspaceId},${id},'adjust',${input.seconds},${`adjust:${ctx.workspaceId}:${key}`},${input.reason}) RETURNING *`,
        tx,
      );
      await audit(tx, ctx, "retainer.adjusted", id, {
        ledgerId: entry.id,
        seconds: input.seconds,
        reason: input.reason,
      });
      return entry;
    },
    key,
  );
}
export async function changeAgreementTerms(
  ctx: Context,
  id: string,
  input: { fee: number; endDate?: string | null },
  now = new Date(),
) {
  return mutate(ctx, "agreement.terms", { id, ...input }, async (tx) => {
    const a = await required(
      sql`SELECT * FROM billing_agreement WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
      tx,
    );
    const today = formatInTimeZone(now, a.timezone, "yyyy-MM-dd");
    const effectiveOn = nextDates(String(a.anchor), a.frequency, today).find(
      (d) => d > today,
    );
    if (!effectiveOn)
      throw new AppError(
        "ANCHOR_RANGE",
        "The schedule anchor is outside the supported range.",
      );
    if (input.endDate && input.endDate < effectiveOn)
      throw new AppError(
        "INVALID_END_DATE",
        `End date must be on or after ${effectiveOn}.`,
      );
    await tx.execute(
      sql`INSERT INTO agreement_term_change(workspace_id,agreement_id,effective_on,fee) VALUES(${ctx.workspaceId},${id},${effectiveOn},${input.fee}) ON CONFLICT(agreement_id,effective_on) DO UPDATE SET fee=excluded.fee`,
    );
    if (input.endDate !== undefined)
      await tx.execute(
        sql`UPDATE billing_agreement SET end_date=${input.endDate} WHERE id=${id}`,
      );
    await audit(tx, ctx, "agreement.terms_scheduled", id, {
      fee: input.fee,
      effectiveOn,
      endDate: input.endDate,
    });
    return { effectiveOn };
  });
}
