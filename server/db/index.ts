import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
export { sql };
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 16,
  connectionTimeoutMillis: 5000,
});
export const db = drizzle(pool);
export type Executor = Pick<typeof db, "execute">;
export async function rows<T = Record<string, any>>(
  query: SQL,
  tx: Executor = db,
): Promise<T[]> {
  return (await tx.execute(query)).rows as T[];
}
export async function one<T = Record<string, any>>(
  query: SQL,
  tx: Executor = db,
): Promise<T | undefined> {
  return (await rows<T>(query, tx))[0];
}
export async function required<T = Record<string, any>>(
  query: SQL,
  tx: Executor = db,
): Promise<T> {
  const row = await one<T>(query, tx);
  if (!row) throw new AppError("NOT_FOUND", "Record not found.", 404);
  return row;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export type Context = {
  workspaceId: string;
  userId: string;
  verifiedAt: Date;
  scopes: string[];
};
export async function audit(
  tx: Executor,
  ctx: Context,
  action: string,
  id: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.execute(
    sql`INSERT INTO audit_event(workspace_id,actor_id,action,record_id,metadata) VALUES(${ctx.workspaceId},${ctx.userId},${action},${id},${JSON.stringify(metadata)}::jsonb)`,
  );
}
export function recent(ctx: Context) {
  if (Date.now() - ctx.verifiedAt.getTime() > 15 * 60_000)
    throw new AppError(
      "REAUTH_REQUIRED",
      "Sign in again to approve this financial action. Verification lasts 15 minutes.",
      403,
    );
}
