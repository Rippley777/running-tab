import { z } from "zod";
import {
  ClientInput,
  ProjectInput,
  WorkspaceInput,
} from "../../shared/contracts.js";
import {
  sql,
  required,
  one,
  audit,
  db,
  AppError,
  type Context,
} from "../db/index.js";
import { config, demoEnabled } from "../config.js";
import { mutate, ownedProject } from "./common.js";
export async function createWorkspace(
  user: { id: string; email: string },
  data: z.input<typeof WorkspaceInput>,
) {
  const v = WorkspaceInput.parse(data);
  return db.transaction(async (tx) => {
    await required(
      sql`SELECT id FROM "user" WHERE id=${user.id} FOR UPDATE`,
      tx,
    );
    if (await one(sql`SELECT id FROM workspace WHERE owner_id=${user.id}`, tx))
      throw new AppError(
        "WORKSPACE_EXISTS",
        "This account already has a workspace.",
        409,
      );
    const w = await required(
      sql`INSERT INTO workspace(name,owner_id,business_email,business_address,timezone,default_rate,cost_rate,target_rate,capacity_seconds,payment_terms,week_start,rounding_minutes,ai_enabled) VALUES(${v.name},${user.id},${v.businessEmail},${v.businessAddress},${v.timezone},${v.defaultRate},${v.costRate ?? null},${v.targetRate ?? null},${v.capacitySeconds ?? null},${v.paymentTerms},${v.weekStart},${v.roundingMinutes},${v.aiEnabled}) RETURNING *`,
      tx,
    );
    await tx.execute(
      sql`INSERT INTO membership(workspace_id,user_id) VALUES(${w.id},${user.id})`,
    );
    if (config.BILLING_MODE === "demo" && demoEnabled) {
      await tx.execute(sql`UPDATE workspace SET demo=true WHERE id=${w.id}`);
      await tx.execute(
        sql`INSERT INTO connected_payment_account(workspace_id,provider,account_id,ready) VALUES(${w.id},'demo',${`demo-${w.id}`},true)`,
      );
    }
    return w;
  });
}
export async function updateWorkspace(
  ctx: Context,
  data: z.input<typeof WorkspaceInput>,
) {
  const v = WorkspaceInput.parse(data);
  return mutate(ctx, "workspace.update", v, async (tx) => {
    await tx.execute(
      sql`UPDATE workspace SET name=${v.name},business_email=${v.businessEmail},business_address=${v.businessAddress},timezone=${v.timezone},default_rate=${v.defaultRate},cost_rate=${v.costRate ?? null},target_rate=${v.targetRate ?? null},capacity_seconds=${v.capacitySeconds ?? null},payment_terms=${v.paymentTerms},week_start=${v.weekStart},rounding_minutes=${v.roundingMinutes},ai_enabled=${v.aiEnabled},digest_enabled=${v.digestEnabled} WHERE id=${ctx.workspaceId}`,
    );
    await audit(tx, ctx, "workspace.updated", ctx.workspaceId, {
      prospectiveRates: true,
    });
    return { ok: true };
  });
}
export async function createClient(
  ctx: Context,
  data: z.input<typeof ClientInput>,
) {
  const v = ClientInput.parse(data);
  return mutate(ctx, "client.create", v, async (tx) => {
    const c = await required(
      sql`INSERT INTO client(workspace_id,name,email,address,default_rate,payment_terms,color) VALUES(${ctx.workspaceId},${v.name},${v.email},${v.address},${v.defaultRate ?? null},${v.paymentTerms},${v.color}) RETURNING *`,
      tx,
    );
    await tx.execute(
      sql`INSERT INTO client_contact(workspace_id,client_id,name,email) VALUES(${ctx.workspaceId},${c.id},${v.name},${v.email})`,
    );
    await audit(tx, ctx, "client.created", c.id);
    return c;
  });
}
export async function createProject(
  ctx: Context,
  data: z.input<typeof ProjectInput>,
) {
  const v = ProjectInput.parse(data);
  return mutate(ctx, "project.create", v, async (tx) => {
    await required(
      sql`SELECT id FROM client WHERE id=${v.clientId} AND workspace_id=${ctx.workspaceId} AND archived_at IS NULL`,
      tx,
    );
    const p = await required(
      sql`INSERT INTO project(workspace_id,client_id,name,description,model,rate,fee,estimate_seconds,cost_rate,target_rate,color) VALUES(${ctx.workspaceId},${v.clientId},${v.name},${v.description},${v.model},${v.rate ?? null},${v.fee},${v.estimateSeconds ?? null},${v.costRate ?? null},${v.targetRate ?? null},${v.color}) RETURNING *`,
      tx,
    );
    await tx.execute(
      sql`INSERT INTO billing_terms(workspace_id,project_id,version,snapshot) VALUES(${ctx.workspaceId},${p.id},1,${JSON.stringify(v)}::jsonb)`,
    );
    if (v.model === "fixed" && v.fee > 0)
      await tx.execute(
        sql`INSERT INTO fixed_milestone(workspace_id,project_id,title,amount,ready) VALUES(${ctx.workspaceId},${p.id},${`${v.name} · project fee`},${v.fee},false)`,
      );
    await audit(tx, ctx, "project.created", p.id);
    return p;
  });
}
export async function updateClient(
  ctx: Context,
  id: string,
  data: z.input<typeof ClientInput>,
) {
  const v = ClientInput.parse(data);
  return mutate(ctx, "client.update", { id, ...v }, async (tx) => {
    const old = await required(
      sql`SELECT * FROM client WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      tx,
    );
    await tx.execute(
      sql`UPDATE client SET name=${v.name},email=${v.email},address=${v.address},default_rate=${v.defaultRate ?? null},payment_terms=${v.paymentTerms},color=${v.color} WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
    );
    await tx.execute(
      sql`UPDATE client_contact SET name=${v.name},email=${v.email} WHERE workspace_id=${ctx.workspaceId} AND client_id=${id} AND email=${old.email}`,
    );
    await audit(tx, ctx, "client.updated", id, { prospective: true });
    return { ok: true };
  });
}
export async function updateProject(
  ctx: Context,
  id: string,
  data: {
    status?: "active" | "completed" | "archived";
    rate?: number;
    targetRate?: number;
    costRate?: number;
    estimateSeconds?: number;
  },
) {
  return mutate(ctx, "project.update", { id, ...data }, async (tx) => {
    const p = await ownedProject(tx, ctx, id);
    if (data.status && data.status !== "active") {
      if (
        await one(
          sql`SELECT id FROM timer_session WHERE project_id=${id} AND workspace_id=${ctx.workspaceId} AND state IN ('running','paused')`,
          tx,
        )
      )
        throw new AppError(
          "TIMER_ACTIVE",
          "Stop this project’s timer before archiving or completing it.",
        );
      await tx.execute(
        sql`UPDATE billing_agreement SET status='paused' WHERE workspace_id=${ctx.workspaceId} AND project_id=${id} AND status='active'`,
      );
    }
    await tx.execute(
      sql`UPDATE project SET status=${data.status ?? p.status},rate=${data.rate ?? p.rate},target_rate=${data.targetRate ?? p.target_rate},cost_rate=${data.costRate ?? p.cost_rate},estimate_seconds=${data.estimateSeconds ?? p.estimate_seconds} WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
    );
    const term = await required(
      sql`SELECT COALESCE(max(version),0)::integer version FROM billing_terms WHERE project_id=${id}`,
      tx,
    );
    await tx.execute(
      sql`INSERT INTO billing_terms(workspace_id,project_id,version,snapshot) VALUES(${ctx.workspaceId},${id},${term.version + 1},${JSON.stringify({ ...p, ...data })}::jsonb)`,
    );
    await audit(tx, ctx, "project.updated", id, { ...data, prospective: true });
    return { ok: true };
  });
}
export async function archiveClient(ctx: Context, id: string) {
  return mutate(ctx, "client.archive", { id }, async (tx) => {
    await required(
      sql`SELECT id FROM client WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
      tx,
    );
    if (
      await one(
        sql`SELECT t.id FROM timer_session t JOIN project p ON p.id=t.project_id WHERE t.workspace_id=${ctx.workspaceId} AND p.client_id=${id} AND t.state IN ('running','paused')`,
        tx,
      )
    )
      throw new AppError(
        "TIMER_ACTIVE",
        "Stop the client’s active timer before archiving.",
      );
    await tx.execute(
      sql`UPDATE client SET archived_at=now() WHERE workspace_id=${ctx.workspaceId} AND id=${id}`,
    );
    await tx.execute(
      sql`UPDATE billing_agreement SET status='paused' WHERE workspace_id=${ctx.workspaceId} AND status='active' AND project_id IN (SELECT id FROM project WHERE client_id=${id} AND workspace_id=${ctx.workspaceId})`,
    );
    await audit(tx, ctx, "client.archived", id, { balancesPreserved: true });
    return { ok: true };
  });
}
