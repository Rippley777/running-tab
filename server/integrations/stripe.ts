import Stripe from "stripe";
import { config } from "../config.js";
import {
  sql,
  rows,
  one,
  required,
  db,
  audit,
  AppError,
  type Context,
} from "../db/index.js";
import { mutate } from "../domain/common.js";
import { validateOperation, confirmPayment } from "../domain/payments.js";
export function stripe() {
  if (
    config.BILLING_MODE !== "stripe_test" ||
    !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
  )
    throw new AppError(
      "SANDBOX_DISABLED",
      "Configure Stripe sandbox credentials. Demo mode cannot call Stripe.",
    );
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 0,
    timeout: 20_000,
  });
}
export async function connectAccount(ctx: Context) {
  const api = stripe();
  let local = await one(
    sql`SELECT * FROM connected_payment_account WHERE workspace_id=${ctx.workspaceId}`,
  );
  if (local && local.provider !== "stripe_test")
    throw new AppError(
      "MODE_MISMATCH",
      "Use a fresh workspace for Stripe sandbox testing.",
    );
  if (!local) {
    const account = await api.accounts.create(
      {
        type: "express",
        country: "US",
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: { workspace_id: ctx.workspaceId },
      },
      { idempotencyKey: `connect-${ctx.workspaceId}` },
    );
    local = await required(
      sql`INSERT INTO connected_payment_account(workspace_id,provider,account_id,ready) VALUES(${ctx.workspaceId},'stripe_test',${account.id},false) ON CONFLICT(workspace_id) DO UPDATE SET account_id=excluded.account_id RETURNING *`,
    );
  }
  const link = await api.accountLinks.create({
    account: local!.account_id,
    type: "account_onboarding",
    refresh_url: `${config.APP_URL}/settings?connect=refresh`,
    return_url: `${config.APP_URL}/settings?connect=return`,
  });
  return { url: link.url };
}
export async function refreshAccount(ctx: Context) {
  const api = stripe();
  const local = await required(
    sql`SELECT * FROM connected_payment_account WHERE workspace_id=${ctx.workspaceId} AND provider='stripe_test'`,
  );
  const a = await api.accounts.retrieve(local.account_id);
  const ready = Boolean(
    a.charges_enabled &&
    a.details_submitted &&
    a.capabilities?.card_payments === "active",
  );
  await db.execute(
    sql`UPDATE connected_payment_account SET ready=${ready},details=${JSON.stringify({ charges_enabled: a.charges_enabled, payouts_enabled: a.payouts_enabled, currently_due: a.requirements?.currently_due ?? [] })}::jsonb WHERE workspace_id=${ctx.workspaceId}`,
  );
  return { ready };
}
async function providerCustomer(
  ctx: Context,
  inv: Record<string, any>,
  account: string,
) {
  let p = await one(
    sql`SELECT * FROM client_payment_profile WHERE workspace_id=${ctx.workspaceId} AND client_id=${inv.client_id} AND provider='stripe_test' AND account_id=${account}`,
  );
  if (!p) {
    const c = await stripe().customers.create(
      {
        name: inv.client_snapshot.name,
        email: inv.client_snapshot.email,
        metadata: { client_id: inv.client_id, workspace_id: ctx.workspaceId },
      },
      {
        stripeAccount: account,
        idempotencyKey: `customer-${ctx.workspaceId}-${inv.client_id}`,
      },
    );
    p = await required(
      sql`INSERT INTO client_payment_profile(workspace_id,client_id,provider,account_id,customer_id) VALUES(${ctx.workspaceId},${inv.client_id},'stripe_test',${account},${c.id}) ON CONFLICT(workspace_id,client_id,provider,account_id) DO UPDATE SET customer_id=excluded.customer_id RETURNING *`,
    );
  }
  return p;
}
async function expectedLines(ctx: Context, inv: Record<string, any>) {
  const lines = await rows(
    sql`SELECT id,description,amount FROM invoice_line WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${inv.id} ORDER BY id`,
  );
  if (inv.discount)
    lines.push({
      id: "discount",
      description: "Agreed invoice discount",
      amount: -inv.discount,
    });
  if (inv.tax)
    lines.push({
      id: "manual-tax",
      description: `Manually configured exclusive tax (${inv.tax_bps / 100}%)`,
      amount: inv.tax,
    });
  return lines;
}
async function verifyProvider(
  ctx: Context,
  inv: Record<string, any>,
  remote: Stripe.Invoice,
  hash: string,
  account: string,
) {
  if (
    remote.livemode ||
    remote.currency !== "usd" ||
    remote.total !== inv.total ||
    remote.metadata?.running_tab_hash !== hash
  )
    throw new AppError(
      "PROVIDER_MISMATCH",
      "Stripe content or total differs from the approved revision.",
    );
  const lines = await stripe().invoices.listLineItems(
    remote.id,
    { limit: 100 },
    { stripeAccount: account },
  );
  const expected = await expectedLines(ctx, inv);
  if (
    lines.has_more ||
    lines.data.length !== expected.length ||
    expected.some(
      (e) =>
        !lines.data.some(
          (l) =>
            l.metadata?.running_tab_line === e.id &&
            l.amount === e.amount &&
            l.description === e.description,
        ),
    )
  )
    throw new AppError(
      "PROVIDER_MISMATCH",
      "Stripe line items differ from the approved snapshot.",
    );
}
export async function processStripeOperation(ctx: Context, id: string) {
  const api = stripe();
  const claim = await mutate(ctx, "payment.claim", { id }, async (tx) => {
    const o = await required(
      sql`SELECT * FROM payment_operation WHERE workspace_id=${ctx.workspaceId} AND id=${id} FOR UPDATE`,
      tx,
    );
    if (o.state !== "queued") return null;
    let validated;
    try {
      validated = await validateOperation(tx, ctx, id);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      await tx.execute(
        sql`UPDATE payment_operation SET state='blocked',error_code=${e.code},finished_at=now() WHERE id=${id}`,
      );
      await tx.execute(
        sql`UPDATE invoice SET issuance_state=CASE WHEN issuance_state='queued' THEN 'local' ELSE issuance_state END,approval_state='review',collection_state=CASE WHEN collection_state='processing' THEN 'unpaid' ELSE collection_state END WHERE id=${o.invoice_id}`,
      );
      await audit(tx, ctx, "payment.blocked", o.invoice_id, {
        code: e.code,
        operationId: id,
      });
      return null;
    }
    await tx.execute(
      sql`UPDATE payment_operation SET state='processing',locked_at=now(),attempts=attempts+1 WHERE id=${id}`,
    );
    return validated;
  });
  if (!claim) return;
  const { op, inv, approval, account } = claim;
  try {
    await refreshAccount(ctx);
    const profile = await providerCustomer(ctx, inv, account.account_id);
    let providerId = inv.provider_invoice ?? op.provider_invoice;
    // The provider object is durably recorded before any finalization or collection.
    if (!providerId) {
      const created = await api.invoices.create(
        {
          customer: profile!.customer_id,
          currency: "usd",
          auto_advance: false,
          collection_method: "send_invoice",
          days_until_due: Math.max(
            1,
            Math.ceil((+new Date(inv.due_at) - Date.now()) / 86400000),
          ),
          pending_invoice_items_behavior: "exclude",
          metadata: {
            running_tab_id: inv.id,
            running_tab_hash: approval.snapshot_hash,
          },
          description: inv.memo || undefined,
        },
        {
          stripeAccount: account.account_id,
          idempotencyKey: `${op.idempotency_key}-create`,
        },
      );
      providerId = created.id;
      await db.execute(
        sql`UPDATE payment_operation SET provider_invoice=${providerId} WHERE id=${id}`,
      );
      await db.execute(
        sql`UPDATE invoice SET provider_invoice=${providerId},provider_account=${account.account_id} WHERE id=${inv.id}`,
      );
    }
    let remote = await api.invoices.retrieve(
      providerId,
      {},
      { stripeAccount: account.account_id },
    );
    if (remote.status === "draft") {
      for (const line of await expectedLines(ctx, inv)) {
        await api.invoiceItems.create(
          {
            customer: profile!.customer_id,
            invoice: providerId,
            currency: "usd",
            amount: line.amount,
            description: line.description,
            metadata: { running_tab_line: line.id },
          },
          {
            stripeAccount: account.account_id,
            idempotencyKey: `${op.idempotency_key}-line-${line.id}`,
          },
        );
      }
      remote = await api.invoices.retrieve(
        providerId,
        {},
        { stripeAccount: account.account_id },
      );
    }
    await verifyProvider(
      ctx,
      inv,
      remote,
      approval.snapshot_hash,
      account.account_id,
    );
    // Recheck local approval, balance, method and consent immediately before provider operations.
    await mutate(ctx, "payment.recheck", { id }, (tx) =>
      validateOperation(tx, ctx, id),
    );
    if (remote.status === "paid") {
      await reconcileInvoice(ctx, inv.id);
      await db.execute(
        sql`UPDATE payment_operation SET state='succeeded',finished_at=now() WHERE id=${id}`,
      );
      return;
    }
    if (remote.status === "draft")
      remote = await api.invoices.finalizeInvoice(
        providerId,
        { auto_advance: false },
        {
          stripeAccount: account.account_id,
          idempotencyKey: `${op.idempotency_key}-finalize`,
        },
      );
    await db.execute(
      sql`UPDATE invoice SET issuance_state='issued',issued_at=COALESCE(issued_at,now()),number=${remote.number ?? inv.number},provider_url=${remote.hosted_invoice_url ?? null},provider_pdf=${remote.invoice_pdf ?? null} WHERE id=${inv.id}`,
    );
    if (op.action === "charge") {
      remote = await api.invoices.retrieve(
        providerId,
        {},
        { stripeAccount: account.account_id },
      );
      await verifyProvider(
        ctx,
        inv,
        remote,
        approval.snapshot_hash,
        account.account_id,
      );
      if (remote.amount_remaining !== inv.total && remote.status !== "paid")
        throw new AppError(
          "BALANCE_CHANGED",
          "The provider outstanding balance changed.",
        );
      await mutate(ctx, "payment.recheck", { id }, (tx) =>
        validateOperation(tx, ctx, id),
      );
      if (remote.status !== "paid")
        await api.invoices.pay(
          providerId,
          { payment_method: approval.payment_method_id, off_session: true },
          {
            stripeAccount: account.account_id,
            idempotencyKey: `${op.idempotency_key}-pay`,
          },
        );
    }
    if (op.action === "send")
      await db.execute(
        sql`INSERT INTO delivery_outbox(workspace_id,invoice_id,kind,dedup_key) VALUES(${ctx.workspaceId},${inv.id},'invoice',${`invoice:${id}`}) ON CONFLICT(dedup_key) DO NOTHING`,
      );
    await reconcileInvoice(ctx, inv.id);
    await db.execute(
      sql`UPDATE payment_operation SET state='succeeded',finished_at=now() WHERE id=${id}`,
    );
  } catch (e) {
    const definitive =
      e instanceof AppError || e instanceof Stripe.errors.StripeCardError;
    const code =
      e instanceof AppError
        ? e.code
        : e instanceof Stripe.errors.StripeCardError
          ? (e.code ?? "CARD_DECLINED")
          : "AMBIGUOUS_PROVIDER_RESPONSE";
    await db.execute(
      sql`UPDATE payment_operation SET state=${definitive ? "failed" : "reconcile"},error_code=${code},finished_at=${definitive ? new Date() : null} WHERE id=${id}`,
    );
    if (definitive)
      await db.execute(
        sql`UPDATE invoice SET collection_state=${code === "authentication_required" ? "authentication_required" : "failed"} WHERE id=${inv.id} AND collection_state<>'paid'`,
      );
    await audit(db, ctx, "payment.provider_attention", inv.id, {
      operationId: id,
      code,
    });
  }
}
export async function reconcileInvoice(
  ctx: Context,
  id: string,
  api: Stripe = stripe(),
) {
  const inv = await required(
    sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${id} AND provider='stripe_test'`,
  );
  if (!inv.provider_invoice || !inv.provider_account)
    return { state: "unissued" };
  const remote = await api.invoices.retrieve(
    inv.provider_invoice,
    {},
    { stripeAccount: inv.provider_account },
  );
  if (remote.livemode || remote.metadata?.running_tab_id !== inv.id)
    throw new AppError(
      "PROVIDER_MISMATCH",
      "The provider invoice does not belong to this record.",
    );
  return mutate(ctx, "payment.reconcile", { id }, async (tx) => {
    const local = await required(
      sql`SELECT * FROM invoice WHERE id=${id} AND workspace_id=${ctx.workspaceId} FOR UPDATE`,
      tx,
    );
    if (remote.total !== local.total || remote.currency !== "usd") {
      await tx.execute(
        sql`UPDATE invoice SET collection_state='disputed' WHERE id=${id}`,
      );
      return { state: "mismatch" };
    }
    if (
      remote.amount_paid > local.paid_amount &&
      remote.amount_paid <= local.total
    ) {
      await confirmPayment(tx, ctx, id, {
        provider: "stripe_test",
        account: inv.provider_account,
        reference: `${remote.id}:paid:${remote.amount_paid}`,
        amount: remote.amount_paid - local.paid_amount,
        receivedAt: remote.status_transitions.paid_at
          ? new Date(remote.status_transitions.paid_at * 1000)
          : new Date(),
      });
      if (remote.status === "paid" && remote.amount_paid === local.total)
        await tx.execute(
          sql`UPDATE payment_operation SET state='succeeded',finished_at=now() WHERE invoice_id=${id} AND state IN ('processing','reconcile')`,
        );
    } else if (remote.status === "void" && local.paid_amount === 0) {
      await tx.execute(
        sql`UPDATE invoice SET issuance_state='void' WHERE id=${id}`,
      );
    }
    await tx.execute(
      sql`UPDATE invoice SET provider_verified_at=now(),provider_url=${remote.hosted_invoice_url ?? null},provider_pdf=${remote.invoice_pdf ?? null} WHERE id=${id}`,
    );
    return { state: remote.status };
  });
}
export async function acceptWebhook(raw: Buffer, signature: string) {
  const api = stripe();
  if (!process.env.STRIPE_WEBHOOK_SECRET)
    throw new AppError(
      "WEBHOOK_UNCONFIGURED",
      "Webhook secret is missing.",
      503,
    );
  let event: Stripe.Event;
  try {
    event = api.webhooks.constructEvent(
      raw,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    throw new AppError("INVALID_SIGNATURE", "Invalid webhook signature.", 400);
  }
  if (event.livemode || !event.account)
    throw new AppError(
      "WRONG_ACCOUNT_CONTEXT",
      "Only connected-account test events are accepted.",
    );
  const owner = await one(
    sql`SELECT workspace_id FROM connected_payment_account WHERE provider='stripe_test' AND account_id=${event.account} AND disconnected_at IS NULL`,
  );
  if (!owner)
    throw new AppError(
      "UNKNOWN_ACCOUNT",
      "Unrecognized connected account.",
      403,
    );
  const object = event.data.object as { id?: string };
  await db.execute(
    sql`INSERT INTO webhook_inbox(workspace_id,provider,account_id,event_id,event_type,object_id) VALUES(${owner.workspace_id},'stripe_test',${event.account},${event.id},${event.type},${object.id ?? ""}) ON CONFLICT DO NOTHING`,
  );
  return { received: true };
}
export async function createSavedMethodSetup(
  ctx: Context,
  invoiceId: string,
  returnUrl: string,
) {
  const api = stripe();
  const inv = await required(
    sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${invoiceId} AND provider='stripe_test' AND issuance_state='issued'`,
  );
  const account = await required(
    sql`SELECT * FROM connected_payment_account WHERE workspace_id=${ctx.workspaceId} AND ready=true AND disconnected_at IS NULL AND provider='stripe_test'`,
  );
  const profile = await providerCustomer(ctx, inv, account.account_id);
  const setupId = crypto.randomUUID();
  const session = await api.checkout.sessions.create(
    {
      mode: "setup",
      customer: profile!.customer_id,
      currency: "usd",
      payment_method_types: ["card"],
      success_url: `${returnUrl}?setup=complete`,
      cancel_url: returnUrl,
      setup_intent_data: {
        metadata: { running_tab_setup: setupId, workspace_id: ctx.workspaceId },
      },
      metadata: { running_tab_setup: setupId, workspace_id: ctx.workspaceId },
    },
    { stripeAccount: account.account_id, idempotencyKey: `setup-${setupId}` },
  );
  await db.execute(
    sql`INSERT INTO payment_setup(id,workspace_id,client_id,profile_id,provider,account_id,session_id,terms_version,frequency,amount_policy,expires_at) VALUES(${setupId},${ctx.workspaceId},${inv.client_id},${profile!.id},'stripe_test',${account.account_id},${session.id},'saved-method-v1','Per explicitly approved invoice','Exact owner-approved invoice total in USD; authorization can be revoked at any time',${new Date(session.expires_at * 1000)})`,
  );
  return { url: session.url };
}
export async function reconcileSavedMethod(ctx: Context, sessionId: string) {
  const local = await one(
    sql`SELECT * FROM payment_setup WHERE workspace_id=${ctx.workspaceId} AND session_id=${sessionId} AND completed_at IS NULL`,
  );
  if (!local) return;
  const api = stripe();
  const session = await api.checkout.sessions.retrieve(
    sessionId,
    {},
    { stripeAccount: local.account_id },
  );
  if (
    session.livemode ||
    session.status !== "complete" ||
    session.metadata?.running_tab_setup !== local.id ||
    !session.setup_intent
  )
    return;
  const setup = await api.setupIntents.retrieve(
    typeof session.setup_intent === "string"
      ? session.setup_intent
      : session.setup_intent.id,
    {},
    { stripeAccount: local.account_id },
  );
  const profile = await required(
    sql`SELECT * FROM client_payment_profile WHERE workspace_id=${ctx.workspaceId} AND id=${local.profile_id}`,
  );
  if (
    setup.status !== "succeeded" ||
    setup.usage !== "off_session" ||
    setup.customer !== profile.customer_id ||
    !setup.payment_method
  )
    throw new AppError(
      "SETUP_MISMATCH",
      "Payment setup does not match the customer.",
    );
  const methodId =
    typeof setup.payment_method === "string"
      ? setup.payment_method
      : setup.payment_method.id;
  const method = await api.paymentMethods.retrieve(
    methodId,
    {},
    { stripeAccount: local.account_id },
  );
  await mutate(ctx, "payment_method.confirm", { sessionId }, async (tx) => {
    const s = await required(
      sql`SELECT * FROM payment_setup WHERE id=${local.id} FOR UPDATE`,
      tx,
    );
    if (s.completed_at) return;
    await tx.execute(
      sql`UPDATE client_payment_profile SET payment_method_id=${method.id},card_suffix=${method.card?.last4 ?? null} WHERE id=${profile.id} AND workspace_id=${ctx.workspaceId}`,
    );
    await tx.execute(
      sql`INSERT INTO auto_charge_consent(workspace_id,client_id,profile_id,terms_version,frequency,amount_policy,accepted_at,setup_session_id) VALUES(${ctx.workspaceId},${local.client_id},${profile.id},${local.terms_version},${local.frequency},${local.amount_policy},${local.accepted_at},${sessionId}) ON CONFLICT DO NOTHING`,
    );
    await tx.execute(
      sql`UPDATE payment_setup SET completed_at=now() WHERE id=${local.id}`,
    );
    await audit(tx, ctx, "consent.provider_verified", local.client_id, {
      setupId: local.id,
    });
  });
}
export async function reconcileAdjustments(ctx: Context, invoiceId: string) {
  const inv = await required(
    sql`SELECT * FROM invoice WHERE workspace_id=${ctx.workspaceId} AND id=${invoiceId} AND provider='stripe_test'`,
  );
  if (!inv.provider_invoice) return;
  const api = stripe();
  const payments = await api.invoicePayments.list(
    { invoice: inv.provider_invoice, limit: 100 },
    { stripeAccount: inv.provider_account },
  );
  for (const p of payments.data) {
    let chargeId: string | null = null;
    if (p.payment.charge)
      chargeId =
        typeof p.payment.charge === "string"
          ? p.payment.charge
          : p.payment.charge.id;
    else if (p.payment.payment_intent) {
      const pi = await api.paymentIntents.retrieve(
        typeof p.payment.payment_intent === "string"
          ? p.payment.payment_intent
          : p.payment.payment_intent.id,
        {},
        { stripeAccount: inv.provider_account },
      );
      chargeId =
        typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge?.id ?? null);
    }
    if (!chargeId) continue;
    const charge = await api.charges.retrieve(
      chargeId,
      { expand: ["balance_transaction"] },
      { stripeAccount: inv.provider_account },
    );
    const localPayment = await one(
      sql`SELECT * FROM payment WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${invoiceId} AND provider='stripe_test'`,
    );
    if (!localPayment) continue;
    if (
      charge.balance_transaction &&
      typeof charge.balance_transaction !== "string"
    )
      await db.execute(
        sql`UPDATE payment SET fee=${charge.balance_transaction.fee} WHERE id=${localPayment.id}`,
      );
    if (charge.disputed) {
      await db.execute(
        sql`UPDATE invoice SET collection_state='disputed' WHERE id=${invoiceId}`,
      );
      await audit(db, ctx, "payment.dispute_detected", invoiceId, { chargeId });
    }
    if (charge.amount_refunded > 0) {
      const refunds = await api.refunds.list(
        { charge: charge.id, limit: 100 },
        { stripeAccount: inv.provider_account },
      );
      for (const refund of refunds.data) {
        if (refund.status === "succeeded")
          await db.execute(
            sql`INSERT INTO payment_adjustment(workspace_id,payment_id,kind,amount,provider_ref,reason) VALUES(${ctx.workspaceId},${localPayment.id},'refund',${refund.amount},${refund.id},'Provider-confirmed refund') ON CONFLICT(payment_id,provider_ref) DO NOTHING`,
          );
      }
      await db.execute(
        sql`UPDATE invoice SET collection_state=${charge.amount_refunded >= charge.amount ? "refunded" : "partial"} WHERE id=${invoiceId}`,
      );
    }
  }
}
