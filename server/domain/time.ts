import { z } from "zod";
import {
  TimerAction,
  ManualEntry,
  EntryPatch,
} from "../../shared/contracts.js";
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
import { mutate, ownedProject, ensureTask } from "./common.js";
import { roundedSeconds } from "./math.js";
import { consumePrepaid, reverseConsumption } from "./retainers.js";
export async function getTimer(ctx: Context, tx?: Executor) {
  return (
    (await one(
      sql`SELECT t.*,p.name project_name,c.name client_name FROM timer_session t JOIN project p ON p.id=t.project_id JOIN client c ON c.id=p.client_id WHERE t.workspace_id=${ctx.workspaceId} AND t.user_id=${ctx.userId} AND t.state IN ('running','paused')`,
      tx,
    )) ?? null
  );
}
async function insertEntry(
  tx: Executor,
  ctx: Context,
  input: {
    projectId: string;
    taskId?: string | null;
    description: string;
    privateNote?: string;
    startedAt: Date;
    endedAt: Date;
    billable: boolean;
    rate: number;
    rounding: number;
    timerId?: string;
    model: string;
  },
) {
  const seconds = Math.floor(
    (input.endedAt.getTime() - input.startedAt.getTime()) / 1000,
  );
  if (seconds <= 0)
    throw new AppError(
      "INVALID_DURATION",
      "Time entries must be at least one second.",
    );
  const treatment = input.billable ? input.model : "nonbillable";
  const e = await required(
    sql`INSERT INTO time_entry(workspace_id,user_id,project_id,task_id,timer_id,description,private_note,started_at,ended_at,actual_seconds,billed_seconds,rate,billable,treatment,rounding_minutes) VALUES(${ctx.workspaceId},${ctx.userId},${input.projectId},${input.taskId ?? null},${input.timerId ?? null},${input.description},${input.privateNote ?? ""},${input.startedAt},${input.endedAt},${seconds},${treatment === "hourly" ? roundedSeconds(seconds, input.rounding) : 0},${input.rate},${input.billable},${treatment},${input.rounding}) RETURNING *`,
    tx,
  );
  if (treatment === "prepaid") await consumePrepaid(tx, ctx, e.id);
  return e;
}
export async function manualEntry(
  ctx: Context,
  data: z.input<typeof ManualEntry>,
  key?: string,
) {
  const v = ManualEntry.parse(data);
  if (v.rateOverride !== undefined && !ctx.scopes.includes("financial"))
    throw new AppError(
      "FORBIDDEN",
      "Rate overrides require owner financial permission.",
      403,
    );
  return mutate(
    ctx,
    "time.create",
    v,
    async (tx) => {
      const p = await ownedProject(tx, ctx, v.projectId);
      if (p.status !== "active" || p.client_archived)
        throw new AppError(
          "ARCHIVED",
          "Reopen this project before recording work.",
        );
      await ensureTask(tx, ctx, p.id, v.taskId);
      const start = new Date(v.startedAt),
        end = new Date(v.endedAt);
      const duration = (+end - +start) / 1000;
      if (duration < 1 || duration > 7 * 86400 || +end > Date.now() + 60_000)
        throw new AppError(
          "INVALID_DURATION",
          "Use a past interval between one second and seven days.",
        );
      const overlap = await one(
        sql`SELECT id FROM time_entry WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.userId} AND deleted_at IS NULL AND started_at<${end} AND ended_at>${start} LIMIT 1`,
        tx,
      );
      if (overlap && !v.acknowledgeOverlap)
        throw new AppError(
          "OVERLAP",
          "This overlaps existing work. Review the interval or explicitly keep the overlap.",
          409,
        );
      const result = await insertEntry(tx, ctx, {
        ...v,
        startedAt: start,
        endedAt: end,
        rate: v.rateOverride ?? p.rate ?? p.client_rate ?? p.workspace_rate,
        rounding: p.rounding_minutes,
        model: p.model,
      });
      await audit(tx, ctx, "time.created", result.id, {
        overlap: Boolean(overlap),
        rateOverride: v.rateOverride,
      });
      return result;
    },
    key,
  );
}
export async function timerAction(
  ctx: Context,
  data: z.input<typeof TimerAction>,
  key: string,
  now = new Date(),
) {
  const v = TimerAction.parse(data);
  return mutate(
    ctx,
    `timer.${v.action}`,
    v,
    async (tx) => {
      let active = await one(
        sql`SELECT * FROM timer_session WHERE user_id=${ctx.userId} AND state IN ('running','paused') FOR UPDATE`,
        tx,
      );
      if (active && active.workspace_id !== ctx.workspaceId)
        throw new AppError(
          "TIMER_OTHER_WORKSPACE",
          "Stop the timer in your other workspace first.",
          409,
        );
      if (v.action === "start" && active)
        throw new AppError(
          "TIMER_ACTIVE",
          "A timer is already running. Use Switch to change projects.",
          409,
        );
      if (v.action !== "start" && (!active || active.version !== v.version))
        throw new AppError(
          "CONFLICT",
          "The timer changed on another device. Refresh to see its current state.",
          409,
        );
      if (
        active &&
        ["pause", "stop", "switch"].includes(v.action) &&
        active.state === "running"
      ) {
        const seconds = Math.max(
          0,
          Math.floor((+now - +new Date(active.segment_started_at)) / 1000),
        );
        if (seconds > 7 * 86400)
          throw new AppError(
            "LONG_TIMER",
            "This timer is over seven days old. Correct it using the timer review action.",
          );
        if (seconds > 0) {
          const p = await ownedProject(tx, ctx, active.project_id);
          await insertEntry(tx, ctx, {
            projectId: p.id,
            taskId: active.task_id,
            description: active.description,
            startedAt: new Date(active.segment_started_at),
            endedAt: now,
            billable: active.billable,
            rate: active.rate,
            rounding: active.rounding_minutes,
            timerId: active.id,
            model: p.model,
          });
        }
        active.accumulated_seconds += seconds;
      }
      if (active && ["pause", "stop", "switch"].includes(v.action)) {
        if (v.action === "pause" && active.state !== "running")
          throw new AppError("CONFLICT", "This timer is already paused.", 409);
        await tx.execute(
          sql`UPDATE timer_session SET state=${v.action === "pause" ? "paused" : "stopped"},segment_started_at=NULL,stopped_at=${v.action === "pause" ? null : now},accumulated_seconds=${active.accumulated_seconds},version=version+1 WHERE id=${active.id}`,
        );
      }
      if (v.action === "resume") {
        if (active!.state !== "paused")
          throw new AppError("CONFLICT", "This timer is already running.", 409);
        await tx.execute(
          sql`UPDATE timer_session SET state='running',segment_started_at=${now},version=version+1 WHERE id=${active!.id}`,
        );
      }
      if (v.action === "start" || v.action === "switch") {
        const p = await ownedProject(tx, ctx, v.projectId);
        if (p.status !== "active" || p.client_archived)
          throw new AppError(
            "ARCHIVED",
            "This project is archived or completed.",
          );
        await ensureTask(tx, ctx, p.id, v.taskId);
        active = await required(
          sql`INSERT INTO timer_session(workspace_id,user_id,project_id,task_id,description,billable,state,started_at,segment_started_at,rate,rounding_minutes) VALUES(${ctx.workspaceId},${ctx.userId},${p.id},${v.taskId ?? null},${v.description},${v.billable},'running',${now},${now},${p.rate ?? p.client_rate ?? p.workspace_rate},${p.rounding_minutes}) RETURNING *`,
          tx,
        );
      }
      await audit(tx, ctx, `timer.${v.action}`, active!.id);
      return { timer: await getTimer(ctx, tx), serverTime: now.toISOString() };
    },
    key,
  );
}
export async function correctTimer(
  ctx: Context,
  id: string,
  endedAt: string,
  version: number,
) {
  return mutate(ctx, "timer.correct", { id, endedAt, version }, async (tx) => {
    const t = await required(
      sql`SELECT * FROM timer_session WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.userId} AND id=${id} AND state='running' FOR UPDATE`,
      tx,
    );
    if (t.version !== version)
      throw new AppError("CONFLICT", "Timer has changed.", 409);
    const end = new Date(endedAt);
    if (+end <= +new Date(t.segment_started_at) || +end > Date.now())
      throw new AppError(
        "INVALID_DURATION",
        "The corrected end must be after start and before now.",
      );
    const p = await ownedProject(tx, ctx, t.project_id);
    const e = await insertEntry(tx, ctx, {
      projectId: t.project_id,
      description: t.description,
      startedAt: new Date(t.segment_started_at),
      endedAt: end,
      billable: t.billable,
      rate: t.rate,
      rounding: t.rounding_minutes,
      timerId: t.id,
      model: p.model,
    });
    await tx.execute(
      sql`UPDATE timer_session SET state='stopped',stopped_at=${end},segment_started_at=NULL,version=version+1 WHERE id=${id}`,
    );
    await audit(tx, ctx, "timer.corrected", id, { endedAt });
    return e;
  });
}
export async function patchEntry(
  ctx: Context,
  id: string,
  data: z.input<typeof EntryPatch>,
) {
  const v = EntryPatch.parse(data);
  return mutate(ctx, "time.edit", { id, ...v }, async (tx) => {
    const e = await required(
      sql`SELECT * FROM time_entry WHERE id=${id} AND workspace_id=${ctx.workspaceId} AND deleted_at IS NULL FOR UPDATE`,
      tx,
    );
    if (e.version !== v.version)
      throw new AppError(
        "CONFLICT",
        "This entry changed. Reload before editing.",
        409,
      );
    if (
      await one(
        sql`SELECT id FROM invoice_source_allocation WHERE time_entry_id=${id} AND released_at IS NULL`,
        tx,
      )
    )
      throw new AppError(
        "ENTRY_LOCKED",
        "This entry is allocated to an invoice. Its financial history is locked.",
        409,
      );
    if (v.delete) {
      await reverseConsumption(tx, ctx, id);
      await tx.execute(
        sql`UPDATE time_entry SET deleted_at=now(),version=version+1 WHERE id=${id}`,
      );
    } else if (v.startedAt || v.endedAt || v.billable !== undefined) {
      if (v.overageDecision || v.splitSeconds)
        throw new AppError(
          "EDIT_CONFLICT",
          "Save the corrected interval before splitting or reviewing an overage.",
        );
      const start = new Date(v.startedAt ?? e.started_at),
        end = new Date(v.endedAt ?? e.ended_at);
      const seconds = Math.floor((+end - +start) / 1000);
      if (seconds < 1 || seconds > 7 * 86400 || +end > Date.now() + 60000)
        throw new AppError(
          "INVALID_DURATION",
          "Use a past interval between one second and seven days.",
        );
      if (
        !v.acknowledgeOverlap &&
        (await one(
          sql`SELECT id FROM time_entry WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.userId} AND id<>${id} AND deleted_at IS NULL AND started_at<${end} AND ended_at>${start}`,
          tx,
        ))
      )
        throw new AppError(
          "OVERLAP",
          "This interval overlaps other work. Review and acknowledge it explicitly.",
          409,
        );
      const project = await ownedProject(tx, ctx, e.project_id);
      const billable = v.billable ?? e.billable,
        treatment = billable ? project.model : "nonbillable";
      await reverseConsumption(tx, ctx, id);
      await tx.execute(
        sql`UPDATE time_entry SET started_at=${start},ended_at=${end},actual_seconds=${seconds},billed_seconds=${treatment === "hourly" ? roundedSeconds(seconds, e.rounding_minutes) : 0},billable=${billable},treatment=${treatment},covered_seconds=0,description=${v.description ?? e.description},reviewed=${v.reviewed ?? false},version=version+1 WHERE id=${id}`,
      );
      if (treatment === "prepaid") await consumePrepaid(tx, ctx, id);
    } else if (v.splitSeconds) {
      if (v.splitSeconds >= e.actual_seconds)
        throw new AppError(
          "INVALID_SPLIT",
          "Split duration must be shorter than the entry.",
        );
      if (e.covered_seconds > 0)
        throw new AppError(
          "PREPAID_SPLIT",
          "Split prepaid work before consumption; use a reviewed reversal for covered work.",
        );
      const mid = new Date(+new Date(e.started_at) + v.splitSeconds * 1000);
      await tx.execute(
        sql`UPDATE time_entry SET ended_at=${mid},actual_seconds=${v.splitSeconds},billed_seconds=${e.treatment === "hourly" ? roundedSeconds(v.splitSeconds, e.rounding_minutes) : 0},version=version+1 WHERE id=${id}`,
      );
      await insertEntry(tx, ctx, {
        projectId: e.project_id,
        taskId: e.task_id,
        description: e.description,
        privateNote: e.private_note,
        startedAt: mid,
        endedAt: new Date(e.ended_at),
        billable: e.billable,
        rate: e.rate,
        rounding: e.rounding_minutes,
        model: e.treatment,
      });
    } else {
      let treatment = e.treatment,
        billed = e.billed_seconds;
      if (v.overageDecision) {
        if (e.treatment !== "overage")
          throw new AppError(
            "NOT_OVERAGE",
            "Only uncovered prepaid work needs an overage decision.",
          );
        treatment = v.overageDecision === "invoice" ? "hourly" : "written_off";
        billed =
          v.overageDecision === "invoice"
            ? roundedSeconds(
                e.actual_seconds - e.covered_seconds,
                e.rounding_minutes,
              )
            : 0;
      }
      await tx.execute(
        sql`UPDATE time_entry SET description=${v.description ?? e.description},reviewed=${v.reviewed ?? (v.description !== undefined ? false : e.reviewed)},treatment=${treatment},billed_seconds=${billed},version=version+1 WHERE id=${id}`,
      );
    }
    await audit(tx, ctx, v.delete ? "time.deleted" : "time.edited", id, {
      splitSeconds: v.splitSeconds,
      overageDecision: v.overageDecision,
    });
    return { ok: true };
  });
}
export async function entries(ctx: Context) {
  return rows(
    sql`SELECT e.*,p.name project_name,p.color,c.name client_name,t.title task_title,a.invoice_id,EXISTS(SELECT 1 FROM time_entry x WHERE x.workspace_id=e.workspace_id AND x.user_id=e.user_id AND x.id<>e.id AND x.deleted_at IS NULL AND x.started_at<e.ended_at AND x.ended_at>e.started_at) overlap FROM time_entry e JOIN project p ON p.id=e.project_id JOIN client c ON c.id=p.client_id LEFT JOIN project_task t ON t.id=e.task_id LEFT JOIN invoice_source_allocation a ON a.time_entry_id=e.id AND a.released_at IS NULL WHERE e.workspace_id=${ctx.workspaceId} AND e.deleted_at IS NULL ORDER BY e.started_at DESC`,
  );
}
