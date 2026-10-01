import { randomBytes } from "node:crypto";
import {
  sql,
  rows,
  required,
  db,
  AppError,
  type Context,
} from "../db/index.js";
import { tokenHash } from "../auth.js";
import { config } from "../config.js";
export async function createAccess(
  ctx: Context,
  invoiceId: string,
  revokePrevious = true,
) {
  const i = await required(
    sql`SELECT client_id,issuance_state FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${invoiceId}`,
  );
  if (i.issuance_state !== "issued")
    throw new AppError("NOT_ISSUED", "Only issued invoices can be shared.");
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    if (revokePrevious)
      await tx.execute(
        sql`UPDATE client_access SET revoked_at=now() WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${invoiceId} AND revoked_at IS NULL`,
      );
    await tx.execute(
      sql`INSERT INTO client_access(workspace_id,client_id,invoice_id,token_hash,expires_at) VALUES(${ctx.workspaceId},${i.client_id},${invoiceId},${tokenHash(token)},now()+interval '7 days')`,
    );
  });
  return { url: `${config.APP_URL}/pay/${token}`, expiresInDays: 7 };
}
export async function access(token: string) {
  if (token.length < 32 || token.length > 100)
    throw new AppError("INVALID_LINK", "This payment link is invalid.", 404);
  return required(
    sql`SELECT a.workspace_id,a.client_id,a.invoice_id,w.owner_id FROM client_access a JOIN workspace w ON w.id=a.workspace_id WHERE a.token_hash=${tokenHash(token)} AND a.revoked_at IS NULL AND a.expires_at>now()`,
  );
}
export async function portal(token: string) {
  const a = await access(token);
  const invoice = await required(
    sql`SELECT id,number,currency,subtotal,discount,tax,total,paid_amount,collection_state,due_at,memo,po_reference,business_snapshot,client_snapshot,provider,provider_url,provider_pdf FROM invoice WHERE id=${a.invoice_id} AND workspace_id=${a.workspace_id} AND client_id=${a.client_id} AND issuance_state='issued'`,
  );
  const lines = await rows(
    sql`SELECT description,quantity_seconds,unit_rate,amount,source_kind,service_start,service_end FROM invoice_line WHERE invoice_id=${a.invoice_id} AND workspace_id=${a.workspace_id}`,
  );
  const payments = await rows(
    sql`SELECT id,amount,currency,received_at,provider FROM payment WHERE invoice_id=${a.invoice_id} AND workspace_id=${a.workspace_id}`,
  );
  const methods = await rows(
    sql`SELECT p.card_suffix, EXISTS(SELECT 1 FROM auto_charge_consent c WHERE c.profile_id=p.id AND c.workspace_id=${a.workspace_id} AND c.revoked_at IS NULL) authorized FROM client_payment_profile p WHERE p.workspace_id=${a.workspace_id} AND p.client_id=${a.client_id}`,
  );
  return { invoice, lines, payments, savedMethod: methods[0] ?? null };
}
export function portalContext(a: Record<string, any>): Context {
  return {
    workspaceId: a.workspace_id,
    userId: a.owner_id,
    verifiedAt: new Date(),
    scopes: [],
  };
}
