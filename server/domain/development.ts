import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ManualEntry } from "../../shared/contracts.js";
import {
  RepositorySettings,
  SessionUpload,
  SessionApproval,
  resolveMapping,
  describeDevelopment,
  safeMetadata,
  supportedSeconds,
} from "../../shared/development.js";
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
import { createManualEntry } from "./time.js";

export async function configureRepository(
  ctx: Context,
  id: string,
  input: unknown,
) {
  const v = RepositorySettings.parse(input);
  return mutate(ctx, "repository.configure", { id, ...v }, async (tx) => {
    const r = await required(
      sql`SELECT * FROM repository_mapping WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      tx,
    );
    if (r.version !== v.version)
      throw new AppError(
        "CONFLICT",
        "Repository settings changed. Refresh first.",
        409,
      );
    for (const m of [v, ...v.rules]) {
      if (m.projectId) {
        await ownedProject(tx, ctx, m.projectId);
        await ensureTask(tx, ctx, m.projectId, m.taskId);
      } else if (m.taskId)
        throw new AppError(
          "PROJECT_REQUIRED",
          "Choose a project for this task.",
        );
    }
    return required(
      sql`UPDATE repository_mapping SET project_id=${v.projectId},task_id=${v.taskId ?? null},billable=${v.billable},tracking_enabled=${v.trackingEnabled},branch_rules=${JSON.stringify(v.rules)}::jsonb,version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id} RETURNING *`,
      tx,
    );
  });
}
export async function uploadSession(ctx: Context, input: unknown) {
  const v = SessionUpload.parse(input);
  const start = new Date(v.startedAt),
    end = new Date(v.endedAt);
  if (
    +end < +start ||
    +end > Date.now() + 60000 ||
    +end - +start > 604800000 ||
    v.inferredSeconds > (+end - +start) / 1000
  )
    throw new AppError(
      "INVALID_DURATION",
      "Session timestamps and inferred duration are inconsistent.",
    );
  if (
    v.evidence.some((e) => +new Date(e.at) < +start || +new Date(e.at) > +end)
  )
    throw new AppError(
      "INVALID_EVIDENCE",
      "Activity must fall within the session interval.",
    );
  return mutate(ctx, "development.upload", v, async (tx) => {
    // Stable source IDs are tombstones too: replay cannot restore deleted/discarded activity.
    const existing = await one(
      sql`SELECT id,status FROM development_session WHERE workspace_id=${ctx.workspaceId} AND id=${v.id} AND user_id=${ctx.userId}`,
      tx,
    );
    if (existing) return existing;
    const r = await required(
      sql`SELECT * FROM repository_mapping WHERE workspace_id=${ctx.workspaceId} AND id=${v.repositoryId}`,
      tx,
    );
    if (!r.tracking_enabled)
      throw new AppError(
        "TRACKING_DISABLED",
        "Enable tracking for this repository before sharing session summaries.",
      );
    const branch = safeMetadata(v.branch);
    const mapping = resolveMapping(
      branch,
      { projectId: r.project_id, taskId: r.task_id, billable: r.billable },
      RepositorySettings.shape.rules.parse(r.branch_rules),
    );
    const inferred = Math.min(
      v.inferredSeconds,
      supportedSeconds(v.evidence, v.mergeSeconds),
    );
    const uncertain =
      inferred === 0 ||
      v.evidence.filter((e) => e.kind === "file_activity").length < 2 ||
      v.evidence.some((e) => ["simultaneous", "interrupted"].includes(e.kind));
    const evidence = v.evidence.map((e) => ({
      ...e,
      detail: safeMetadata(e.detail),
    }));
    const reason =
      mapping.reason +
      " File metadata is indirect evidence; no human-active duration was measured. Confirm duration and description.";
    await tx.execute(
      sql`INSERT INTO development_session(id,workspace_id,user_id,repository_id,branch,project_id,task_id,billable,started_at,ended_at,inferred_seconds,confidence,reason,description,evidence) VALUES(${v.id},${ctx.workspaceId},${ctx.userId},${r.id},${branch},${mapping.projectId},${mapping.taskId ?? null},${mapping.billable},${start},${end},${inferred},${uncertain ? "low" : "medium"},${reason},${describeDevelopment(branch)},${JSON.stringify(evidence)}::jsonb)`,
    );
    await audit(tx, ctx, "development.suggested", v.id);
    return { id: v.id, status: "suggested" };
  });
}
export async function developmentSessions(ctx: Context) {
  return rows(
    sql`SELECT s.*,r.alias,r.identity,p.name project_name,p.client_id,c.name client_name FROM development_session s JOIN repository_mapping r ON r.id=s.repository_id AND r.workspace_id=s.workspace_id LEFT JOIN project p ON p.id=s.project_id AND p.workspace_id=s.workspace_id LEFT JOIN client c ON c.id=p.client_id AND c.workspace_id=s.workspace_id WHERE s.workspace_id=${ctx.workspaceId} AND s.user_id=${ctx.userId} AND s.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1000`,
  );
}
async function pending(
  tx: Executor,
  ctx: Context,
  id: string,
  version: number,
) {
  const s = await required(
    sql`SELECT * FROM development_session WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.userId} AND id=${id} AND deleted_at IS NULL`,
    tx,
  );
  if (s.status !== "suggested" || s.version !== version)
    throw new AppError(
      "CONFLICT",
      "This session was already reviewed or changed. Refresh before continuing.",
      409,
    );
  return s;
}
export async function approveSession(
  ctx: Context,
  id: string,
  input: unknown,
  key?: string,
) {
  const v = SessionApproval.parse(input);
  return mutate(
    ctx,
    "development.approve",
    { id, ...v },
    async (tx) => {
      await pending(tx, ctx, id, v.version);
      // Assisted approval never provides an overlap override. This includes a running timer.
      const end = new Date(v.endedAt);
      const active = await one(
        sql`SELECT id FROM timer_session WHERE user_id=${ctx.userId} AND state='running' AND segment_started_at<${end}`,
        tx,
      );
      if (active)
        throw new AppError(
          "OVERLAP",
          "Stop and review your running timer before approving this interval.",
          409,
        );
      const entry = await createManualEntry(
        tx,
        ctx,
        ManualEntry.parse({ ...v, acknowledgeOverlap: false }),
      );
      const approved = await required<
        {
          id: string;
          rate: number;
          actual_seconds: number;
          billed_seconds: number;
          approved_at: Date;
        } & Record<string, unknown>
      >(
        sql`UPDATE time_entry SET reviewed=true,source_session_id=${id},approved_at=now() WHERE workspace_id=${ctx.workspaceId} AND id=${entry.id} RETURNING *`,
        tx,
      );
      await tx.execute(
        sql`UPDATE development_session SET status='approved',project_id=${v.projectId},task_id=${v.taskId ?? null},billable=${v.billable},description=${v.description},adjusted_seconds=${entry.actual_seconds},time_entry_id=${entry.id},approved_at=now(),version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      );
      await audit(tx, ctx, "development.approved", id, {
        timeEntryId: entry.id,
      });
      return approved;
    },
    key,
  );
}
export const SessionEdit = z.object({
  version: z.number().int().positive(),
  action: z.enum(["edit", "discard", "delete", "split", "merge"]),
  projectId: z.uuid().nullable().optional(),
  taskId: z.uuid().nullable().optional(),
  billable: z.boolean().optional(),
  description: z.string().max(2000).optional(),
  splitAt: z.iso.datetime({ offset: true }).optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  durationSeconds: z.number().int().min(1).max(604800).optional(),
  otherId: z.uuid().optional(),
  otherVersion: z.number().int().positive().optional(),
});
export async function editSession(ctx: Context, id: string, input: unknown) {
  const v = SessionEdit.parse(input);
  return mutate(ctx, "development.edit", { id, ...v }, async (tx) => {
    const s = await required(
      sql`SELECT * FROM development_session WHERE workspace_id=${ctx.workspaceId} AND user_id=${ctx.userId} AND id=${id} AND deleted_at IS NULL`,
      tx,
    );
    if (s.version !== v.version)
      throw new AppError("CONFLICT", "Session changed; refresh first.", 409);
    if (v.action === "delete") {
      // Retain only deduplication/provenance, never delete the approved billing entry.
      await tx.execute(
        sql`UPDATE development_session SET deleted_at=now(),evidence='[]',branch='',description='',reason='',version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      );
      return { ok: true };
    }
    await pending(tx, ctx, id, v.version);
    if (v.action === "discard")
      await tx.execute(
        sql`UPDATE development_session SET status='discarded',version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      );
    if (v.action === "edit") {
      const proposedStart = v.startedAt
        ? new Date(v.startedAt)
        : s.proposed_started_at;
      const adjusted = v.durationSeconds ?? s.adjusted_seconds;
      if (
        proposedStart &&
        adjusted &&
        +new Date(proposedStart) + adjusted * 1000 > Date.now() + 60000
      )
        throw new AppError("INVALID_DURATION", "Use a past billing interval.");
      const project = v.projectId === undefined ? s.project_id : v.projectId;
      const task =
        v.taskId === undefined
          ? project === s.project_id
            ? s.task_id
            : null
          : v.taskId;
      if (project) {
        await ownedProject(tx, ctx, project);
        await ensureTask(tx, ctx, project, task);
      } else if (task)
        throw new AppError(
          "PROJECT_REQUIRED",
          "Choose a project for this task.",
        );
      await tx.execute(
        sql`UPDATE development_session SET proposed_started_at=${proposedStart},adjusted_seconds=${adjusted},project_id=${project},task_id=${task},billable=${v.billable ?? s.billable},description=${v.description ?? s.description},version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      );
    }
    if (v.action === "split") {
      const mid = new Date(v.splitAt ?? ""),
        start = new Date(s.started_at),
        end = new Date(s.ended_at);
      if (!Number.isFinite(+mid) || +mid <= +start || +mid >= +end)
        throw new AppError(
          "INVALID_SPLIT",
          "Choose a split time inside this session.",
        );
      const first = Math.floor(
        (s.inferred_seconds * (+mid - +start)) / (+end - +start),
      );
      const child = randomUUID();
      const evidence = s.evidence as { at: string }[];
      await tx.execute(
        sql`INSERT INTO development_session(id,workspace_id,user_id,repository_id,branch,project_id,task_id,billable,started_at,ended_at,inferred_seconds,confidence,reason,description,evidence) VALUES(${child},${ctx.workspaceId},${ctx.userId},${s.repository_id},${s.branch},${s.project_id},${s.task_id},${s.billable},${mid},${end},${s.inferred_seconds - first},'low',${"User split; duration apportioned. Review each interval."},${s.description},${JSON.stringify(evidence.filter((e) => +new Date(e.at) >= +mid))}::jsonb)`,
      );
      await tx.execute(
        sql`UPDATE development_session SET adjusted_seconds=NULL,proposed_started_at=NULL,ended_at=${mid},inferred_seconds=${first},confidence='low',reason='User split; duration apportioned. Review each interval.',evidence=${JSON.stringify(evidence.filter((e) => +new Date(e.at) < +mid))}::jsonb,version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      );
    }
    if (v.action === "merge") {
      if (!v.otherId || !v.otherVersion || v.otherId === id)
        throw new AppError("INVALID_MERGE", "Choose another pending session.");
      const o = await pending(tx, ctx, v.otherId, v.otherVersion);
      if (
        o.repository_id !== s.repository_id ||
        o.branch !== s.branch ||
        o.project_id !== s.project_id ||
        o.task_id !== s.task_id ||
        o.billable !== s.billable
      )
        throw new AppError(
          "INVALID_MERGE",
          "Only sessions with the same repository, branch, project, task and billing context can merge.",
        );
      const start = new Date(
          Math.min(+new Date(s.started_at), +new Date(o.started_at)),
        ),
        end = new Date(Math.max(+new Date(s.ended_at), +new Date(o.ended_at)));
      const overlap = Math.max(
        0,
        (Math.min(+new Date(s.ended_at), +new Date(o.ended_at)) -
          Math.max(+new Date(s.started_at), +new Date(o.started_at))) /
          1000,
      );
      if (+end - +start > 604800000)
        throw new AppError(
          "INVALID_MERGE",
          "Merged sessions cannot span more than seven days.",
        );
      await tx.execute(
        sql`UPDATE development_session SET adjusted_seconds=NULL,proposed_started_at=NULL,started_at=${start},ended_at=${end},inferred_seconds=${Math.max(0, s.inferred_seconds + o.inferred_seconds - overlap)},confidence='low',reason='Merged sessions; gaps excluded from estimated duration. Review the billing interval.',evidence=${JSON.stringify([...s.evidence, ...o.evidence].sort((a, b) => a.at.localeCompare(b.at)).slice(0, 500))}::jsonb,description=${[
          s.description,
          o.description,
        ]
          .filter((x, i, a) => a.indexOf(x) === i)
          .join("\n")
          .slice(
            0,
            2000,
          )},version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      );
      await tx.execute(
        sql`UPDATE development_session SET status='discarded',reason=${`Merged into ${id}`},version=version+1 WHERE workspace_id=${ctx.workspaceId} AND id=${o.id}`,
      );
    }
    await audit(tx, ctx, `development.${v.action}`, id);
    return { ok: true };
  });
}
