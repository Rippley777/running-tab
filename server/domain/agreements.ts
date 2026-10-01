import {
  sql,
  rows,
  one,
  required,
  audit,
  AppError,
  type Context,
} from "../db/index.js";
import { mutate } from "./common.js";
import { createDraft } from "./invoices.js";
import { formatInTimeZone } from "date-fns-tz";
// Always compute from the original anchor. Jan 31 -> Feb 28 -> Mar 31, not Mar 28.
export function periodDate(anchor: string, frequency: string, index: number) {
  const [y, m, d] = anchor.slice(0, 10).split("-").map(Number);
  if (frequency === "weekly") {
    const result = new Date(Date.UTC(y, m - 1, d + index * 7));
    return result.toISOString().slice(0, 10);
  }
  const first = new Date(Date.UTC(y, m - 1 + index, 1));
  const last = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}
export function nextDates(anchor: string, frequency: string, today: string) {
  const result: string[] = [];
  for (let n = 0; n < 2400 && result.length < 3; n++) {
    const d = periodDate(anchor, frequency, n);
    if (d >= today) result.push(d);
  }
  return result;
}
export async function createAgreement(
  ctx: Context,
  input: {
    projectId: string;
    fee: number;
    frequency: "weekly" | "monthly";
    anchor: string;
    timezone: string;
  },
) {
  return mutate(ctx, "agreement.create", input, async (tx) => {
    const p = await required(
      sql`SELECT model FROM project WHERE id=${input.projectId} AND workspace_id=${ctx.workspaceId}`,
      tx,
    );
    if (p.model !== "support")
      throw new AppError(
        "WRONG_MODEL",
        "Recurring support agreements require a support project.",
      );
    const result = await required(
      sql`INSERT INTO billing_agreement(workspace_id,project_id,fee,frequency,anchor,timezone) VALUES(${ctx.workspaceId},${input.projectId},${input.fee},${input.frequency},${input.anchor},${input.timezone}) RETURNING *`,
      tx,
    );
    await audit(tx, ctx, "agreement.created", result.id);
    return result;
  });
}
export async function runSchedules(ctx: Context, now = new Date()) {
  const agreements = await rows(
    sql`SELECT a.*,p.client_id FROM billing_agreement a JOIN project p ON p.id=a.project_id JOIN client c ON c.id=p.client_id WHERE a.workspace_id=${ctx.workspaceId} AND a.status='active' AND p.status='active' AND c.archived_at IS NULL`,
  );
  let drafts = 0;
  for (const a of agreements) {
    const today = formatInTimeZone(now, a.timezone, "yyyy-MM-dd");
    const anchor = String(a.anchor).slice(0, 10);
    for (let n = 0; n < 2400; n++) {
      const start = periodDate(anchor, a.frequency, n),
        end = periodDate(anchor, a.frequency, n + 1);
      if (
        start > today ||
        (a.end_date && start >= String(a.end_date).slice(0, 10))
      )
        break;
      const period = await mutate(
        ctx,
        "agreement.period",
        { id: a.id, start },
        async (tx) => {
          const live = await required(
            sql`SELECT status,end_date FROM billing_agreement WHERE id=${a.id} AND workspace_id=${ctx.workspaceId} FOR UPDATE`,
            tx,
          );
          if (
            live.status !== "active" ||
            (live.end_date && start >= String(live.end_date))
          )
            return null;
          const terms = await one(
            sql`SELECT fee FROM agreement_term_change WHERE workspace_id=${ctx.workspaceId} AND agreement_id=${a.id} AND effective_on<=${start} ORDER BY effective_on DESC LIMIT 1`,
            tx,
          );
          await tx.execute(
            sql`INSERT INTO billing_period(workspace_id,agreement_id,starts_on,ends_on,fee) VALUES(${ctx.workspaceId},${a.id},${start},${end},${terms?.fee ?? a.fee}) ON CONFLICT(agreement_id,starts_on) DO NOTHING`,
          );
          return required(
            sql`SELECT * FROM billing_period WHERE agreement_id=${a.id} AND starts_on=${start}`,
            tx,
          );
        },
      );
      if (!period) break;
      if (
        !(await one(
          sql`SELECT id FROM invoice_source_allocation WHERE workspace_id=${ctx.workspaceId} AND period_id=${period.id} AND released_at IS NULL`,
        ))
      ) {
        try {
          await createDraft(
            ctx,
            { clientId: a.client_id, periodIds: [period.id] },
            `recurrence:${period.id}`,
          );
          drafts++;
        } catch (e) {
          if (!(e instanceof AppError && e.code === "SOURCE_ALLOCATED"))
            throw e;
        }
      }
    }
  }
  return { drafts };
}
