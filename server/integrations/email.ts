import nodemailer from "nodemailer";
import { formatInTimeZone } from "date-fns-tz";
import {
  sql,
  rows,
  required,
  db,
  AppError,
  type Context,
} from "../db/index.js";
import { createAccess } from "../domain/portal.js";
import { config } from "../config.js";
const mail = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? "127.0.0.1",
  port: Number(process.env.SMTP_PORT ?? 1025),
  secure: process.env.SMTP_SECURE === "true",
  ...(process.env.SMTP_USER
    ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } }
    : {}),
});
export async function sendMail(
  to: string,
  subject: string,
  text: string,
  messageId?: string,
) {
  if (process.env.SMTP_ALLOW_EXTERNAL !== "true" && !to.endsWith(".test"))
    throw new AppError(
      "EMAIL_RECIPIENT_BLOCKED",
      "Local email delivery is limited to .test addresses.",
    );
  await mail.sendMail({
    from: process.env.SMTP_FROM ?? "Running Tab <hello@runningtab.test>",
    to,
    subject,
    text,
    messageId,
  });
}
export async function queueDigest(ctx: Context, now = new Date()) {
  const w = await required(
    sql`SELECT digest_enabled,timezone FROM workspace WHERE id=${ctx.workspaceId}`,
  );
  if (!w.digest_enabled || Number(formatInTimeZone(now, w.timezone, "H")) < 9)
    return;
  const day = formatInTimeZone(now, w.timezone, "yyyy-MM-dd");
  await db.execute(
    sql`INSERT INTO delivery_outbox(workspace_id,kind,dedup_key) SELECT ${ctx.workspaceId},'digest',${`digest:${ctx.workspaceId}:${day}`} WHERE EXISTS(SELECT 1 FROM notification WHERE workspace_id=${ctx.workspaceId} AND resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until<now())) ON CONFLICT(dedup_key) DO NOTHING`,
  );
}
export async function deliverOutbox(workspaceId?: string) {
  // Stable Message-ID reduces duplicates after a lost SMTP acknowledgement. Delivery is at-least-once.
  await db.execute(
    sql`UPDATE delivery_outbox SET state='queued',error_code='DELIVERY_INTERRUPTED' WHERE state='processing' AND locked_at<now()-interval '5 minutes' ${workspaceId ? sql`AND workspace_id=${workspaceId}` : sql``}`,
  );
  for (let n = 0; n < 30; n++) {
    const job = await db.transaction(async (tx) => {
      const result = await rows(
        sql`SELECT * FROM delivery_outbox WHERE state='queued' AND attempts<5 ${workspaceId ? sql`AND workspace_id=${workspaceId}` : sql``} ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        tx,
      );
      if (!result[0]) return null;
      await tx.execute(
        sql`UPDATE delivery_outbox SET state='processing',locked_at=now(),attempts=attempts+1 WHERE id=${result[0].id}`,
      );
      return result[0];
    });
    if (!job) break;
    try {
      const w = await required(
        sql`SELECT w.*,u.email owner_email FROM workspace w JOIN "user" u ON u.id=w.owner_id WHERE w.id=${job.workspace_id}`,
      );
      let recipient = w.owner_email,
        subject = "",
        body = "";
      if (job.kind === "digest") {
        const reminders = await rows(
          sql`SELECT title,detail FROM notification WHERE workspace_id=${w.id} AND resolved_at IS NULL AND (snoozed_until IS NULL OR snoozed_until<now()) ORDER BY created_at LIMIT 20`,
        );
        if (!w.digest_enabled || !reminders.length) {
          await db.execute(
            sql`UPDATE delivery_outbox SET state='sent',sent_at=now() WHERE id=${job.id}`,
          );
          continue;
        }
        subject = "Your Running Tab attention list";
        body =
          reminders.map((r) => `${r.title}\n${r.detail}`).join("\n\n") +
          `\n\nOpen your workspace: ${config.APP_URL}/today`;
      } else {
        const i = await required(
          sql`SELECT * FROM invoice WHERE workspace_id=${w.id} AND id=${job.invoice_id} AND issuance_state='issued'`,
        );
        if (job.kind === "receipt" && i.paid_amount < i.total)
          throw new AppError(
            "PAYMENT_UNCONFIRMED",
            "Receipt requires confirmed full payment.",
          );
        const access = await createAccess(
          {
            workspaceId: w.id,
            userId: w.owner_id,
            verifiedAt: new Date(),
            scopes: [],
          },
          i.id,
          false,
        );
        recipient = i.client_snapshot.email;
        subject = `${job.kind === "receipt" ? "Payment receipt" : "Invoice"} ${i.number} from ${i.business_snapshot.name}`;
        body = `${i.client_snapshot.name},\n\n${job.kind === "receipt" ? "Your payment is confirmed." : "Your approved invoice is ready."}\nInvoice ${i.number}: USD ${(i.total / 100).toFixed(2)}\n\nView the invoice${job.kind === "receipt" ? " and receipt" : ""}: ${access.url}\n\nThis private link expires in seven days.\n${i.business_snapshot.name}`;
      }
      await sendMail(recipient, subject, body, `<${job.id}@runningtab.local>`);
      await db.execute(
        sql`UPDATE delivery_outbox SET state='sent',sent_at=now(),error_code=NULL WHERE id=${job.id}`,
      );
    } catch (e) {
      await db.execute(
        sql`UPDATE delivery_outbox SET state='failed',error_code=${e instanceof AppError ? e.code : "SMTP_DELIVERY_FAILED"} WHERE id=${job.id}`,
      );
    }
  }
}
