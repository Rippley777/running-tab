import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { sql, rows, db, pool } from "./db/index.js";
import { processDemoQueue } from "./domain/payments.js";
import {
  processStripeOperation,
  reconcileInvoice,
  refreshAccount,
  reconcileSavedMethod,
  reconcileAdjustments,
} from "./integrations/stripe.js";
import { runSchedules } from "./domain/agreements.js";
import { expireBuckets } from "./domain/retainers.js";
import { refreshReminders } from "./domain/dashboard.js";
import { deliverOutbox, queueDigest } from "./integrations/email.js";
export async function tick() {
  await processDemoQueue();
  await deliverOutbox();
  if (config.BILLING_MODE === "stripe_test") {
    await db.execute(
      sql`UPDATE payment_operation SET state='reconcile',error_code='WORKER_INTERRUPTED' WHERE state='processing' AND locked_at<now()-interval '2 minutes'`,
    );
    for (const j of await rows(
      sql`SELECT o.*,w.owner_id FROM payment_operation o JOIN workspace w ON w.id=o.workspace_id WHERE o.state IN ('queued','reconcile') ORDER BY o.created_at LIMIT 30`,
    )) {
      const ctx = {
        workspaceId: j.workspace_id,
        userId: j.owner_id,
        verifiedAt: new Date(),
        scopes: ["financial"],
      };
      if (j.state === "queued") await processStripeOperation(ctx, j.id);
      else if (j.provider_invoice) await reconcileInvoice(ctx, j.invoice_id);
    }
    for (const e of await rows(
      sql`SELECT e.*,w.owner_id FROM webhook_inbox e JOIN workspace w ON w.id=e.workspace_id WHERE e.state='pending' ORDER BY e.received_at LIMIT 100`,
    )) {
      try {
        const ctx = {
          workspaceId: e.workspace_id,
          userId: e.owner_id,
          verifiedAt: new Date(),
          scopes: ["financial"],
        };
        if (e.event_type === "account.updated") await refreshAccount(ctx);
        else if (e.event_type === "checkout.session.completed")
          await reconcileSavedMethod(ctx, e.object_id);
        else if (e.event_type.startsWith("invoice.")) {
          const inv = await rows(
            sql`SELECT id FROM invoice WHERE workspace_id=${e.workspace_id} AND provider_account=${e.account_id} AND provider_invoice=${e.object_id}`,
          );
          if (inv[0]) {
            await reconcileInvoice(ctx, inv[0].id);
            await reconcileAdjustments(ctx, inv[0].id);
          }
        } else {
          await db.execute(
            sql`UPDATE webhook_inbox SET state='needs_review',error_code='UNHANDLED_PROVIDER_EVENT' WHERE id=${e.id}`,
          );
          continue;
        }
        await db.execute(
          sql`UPDATE webhook_inbox SET state='processed',processed_at=now() WHERE id=${e.id}`,
        );
      } catch {
        await db.execute(
          sql`UPDATE webhook_inbox SET error_code='RECONCILIATION_FAILED' WHERE id=${e.id}`,
        );
      }
    }
  }
}
export async function housekeeping() {
  for (const w of await rows(sql`SELECT id,owner_id FROM workspace`)) {
    const ctx = {
      workspaceId: w.id,
      userId: w.owner_id,
      verifiedAt: new Date(),
      scopes: ["financial"],
    };
    await runSchedules(ctx);
    await expireBuckets(ctx);
    await refreshReminders(ctx);
    await queueDigest(ctx);
    if (config.BILLING_MODE === "stripe_test")
      for (const i of await rows(
        sql`SELECT id FROM invoice WHERE workspace_id=${w.id} AND provider='stripe_test' AND provider_invoice IS NOT NULL AND issuance_state='issued' AND collection_state<>'refunded'`,
      )) {
        try {
          await reconcileInvoice(ctx, i.id);
          await reconcileAdjustments(ctx, i.id);
        } catch {
          console.error(
            JSON.stringify({ event: "reconcile_failed", invoiceId: i.id }),
          );
        }
      }
  }
}
if (process.argv[1]?.endsWith("worker.ts")) {
  const boss = new PgBoss(config.DATABASE_URL);
  boss.on("error", () =>
    console.error(JSON.stringify({ event: "worker_error" })),
  );
  await boss.start();
  for (const q of ["operations", "housekeeping"])
    await boss.createQueue(q, {
      retryLimit: 3,
      retryDelay: 10,
      retryBackoff: true,
    });
  await boss.work("operations", async () => {
    await tick();
  });
  await boss.work("housekeeping", async () => {
    await housekeeping();
  });
  await boss.schedule("operations", "* * * * *");
  await boss.schedule("housekeeping", "*/5 * * * *");
  await boss.send("housekeeping");
  await boss.send("operations");
  const poll = setInterval(() => {
    void boss
      .send("operations", {}, { singletonKey: "drain", singletonSeconds: 3 })
      .catch(() =>
        console.error(JSON.stringify({ event: "queue_unavailable" })),
      );
  }, 3000);
  console.log("Running Tab worker ready (PostgreSQL durable jobs).");
  const stop = async () => {
    clearInterval(poll);
    await boss.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
