import {
  configureRepository,
  uploadSession,
  developmentSessions,
  approveSession,
  editSession,
} from "./domain/development.js";
import {
  splitMilestone,
  adjustBucket,
  changeAgreementTerms,
} from "./domain/billing-changes.js";
import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import { config, demoEnabled } from "./config.js";
import {
  auth,
  context,
  identity,
  requestHeaders,
  requireScope,
  issueDevice,
  devices,
  revokeDevices,
  demoMagicLinks,
} from "./auth.js";
import {
  db,
  sql,
  rows,
  required,
  one,
  pool,
  AppError,
  audit,
  recent,
  type Context,
} from "./db/index.js";
import {
  createWorkspace,
  updateWorkspace,
  createClient,
  updateClient,
  createProject,
  updateProject,
  archiveClient,
} from "./domain/catalog.js";
import {
  getTimer,
  timerAction,
  manualEntry,
  patchEntry,
  correctTimer,
} from "./domain/time.js";
import {
  createDraft,
  editInvoice,
  requestReview,
  approveInvoice,
  invoiceDetail,
  voidDraft,
} from "./domain/invoices.js";
import { snapshot, refreshReminders } from "./domain/dashboard.js";
import { createBucket } from "./domain/retainers.js";
import { createAgreement, runSchedules } from "./domain/agreements.js";
import {
  externalPayment,
  demoCustomerPayment,
  demoConsent,
  revokeConsent,
  processDemoQueue,
} from "./domain/payments.js";
import {
  createAccess,
  access,
  portal,
  portalContext,
} from "./domain/portal.js";
import { draftDescriptions } from "./integrations/descriptions.js";
import { ingest, linkRepository, reviewSuggestion } from "./domain/activity.js";
import {
  connectAccount,
  refreshAccount,
  acceptWebhook,
  reconcileInvoice,
  createSavedMethodSetup,
} from "./integrations/stripe.js";
import { reports } from "./domain/reporting.js";
import { csv } from "./domain/math.js";
import { mutate } from "./domain/common.js";
import { Id, Cents, ISO } from "../shared/contracts.js";
const params = (r: FastifyRequest) => r.params as Record<string, string>;
const id = (r: FastifyRequest) => Id.parse(params(r).id);
const key = (r: FastifyRequest) =>
  z.string().min(8).max(120).parse(r.headers["idempotency-key"]);
const DateRange = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine(
    (v) =>
      v.to > v.from && +new Date(v.to) - +new Date(v.from) <= 367 * 86400000,
    "Choose a date range of up to one year.",
  );
const headers = (r: FastifyRequest) => requestHeaders(r.headers);
export async function createApp() {
  const app = Fastify({
    logger: false,
    trustProxy:
      process.env.TRUSTED_PROXY?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? false,
    bodyLimit: 128 * 1024,
  });
  await app.register(cors, { origin: config.APP_URL, credentials: true });
  app.addHook("preValidation", async (req) => {
    if (
      req.url.startsWith("/api/v1/") &&
      req.body &&
      typeof req.body === "object" &&
      "currency" in req.body &&
      req.body.currency !== "USD"
    )
      throw new AppError("UNSUPPORTED_CURRENCY", "Only USD is supported.", 422);
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      if (req.url === "/api/stripe/webhook") {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body.toString()));
      } catch {
        done(new Error("Invalid JSON"));
      }
    },
  );
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (config.NODE_ENV === "production")
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (
      ["POST", "PATCH", "DELETE", "PUT"].includes(req.method) &&
      req.url !== "/api/stripe/webhook" &&
      !req.headers.authorization
    ) {
      if (req.headers.origin !== config.APP_URL)
        throw new AppError(
          "INVALID_ORIGIN",
          "Request origin is not allowed.",
          403,
        );
    }
    if (req.url.startsWith("/api/") && !req.url.startsWith("/api/auth/")) {
      const limit = await required(
        sql`INSERT INTO rate_limit(key,window_at,count) VALUES(${`api:${req.ip}`},now(),1) ON CONFLICT(key) DO UPDATE SET window_at=CASE WHEN rate_limit.window_at<now()-interval '1 minute' THEN now() ELSE rate_limit.window_at END,count=CASE WHEN rate_limit.window_at<now()-interval '1 minute' THEN 1 ELSE rate_limit.count+1 END RETURNING count`,
      );
      if (limit.count > 300)
        throw new AppError(
          "RATE_LIMIT",
          "Too many requests. Try again in a minute.",
          429,
        );
    }
  });
  app.setErrorHandler((error: any, req, reply) => {
    const databaseCode = error.cause?.code ?? error.code;
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError
          ? 422
          : databaseCode === "23505"
            ? 409
            : databaseCode === "23503"
              ? 404
              : 500;
    const code =
      error instanceof AppError
        ? error.code
        : error instanceof z.ZodError
          ? "VALIDATION"
          : status === 409
            ? "CONFLICT"
            : status === 404
              ? "NOT_FOUND"
              : "INTERNAL";
    const message =
      error instanceof AppError
        ? error.message
        : error instanceof z.ZodError
          ? error.issues
              .map((i: any) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : status === 409
            ? "This action conflicts with a record that already exists. Refresh and try again."
            : status === 404
              ? "The referenced record is not available."
              : "The operation could not be completed. Your input has been preserved.";
    if (status === 500)
      console.error(
        JSON.stringify({
          event: "request_failed",
          requestId: req.id,
          code: error.code ?? error.name,
        }),
      );
    reply.status(status).send({ error: { code, message, requestId: req.id } });
  });
  const secured =
    (
      scope: string,
      fn: (
        ctx: Context,
        req: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await context(headers(req));
      requireScope(ctx, scope);
      return fn(ctx, req, reply);
    };
  app.get("/api/health", async () => {
    await pool.query("SELECT 1");
    return { ok: true, mode: config.BILLING_MODE, livePayments: false };
  });
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const response = await auth.handler(
        new Request(`${config.APP_URL}${req.url}`, {
          method: req.method,
          headers: headers(req),
          ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.status(response.status);
      for (const [k, v] of response.headers.entries())
        if (k !== "set-cookie") reply.header(k, v);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(await response.text());
    },
  });
  app.post("/api/sign-out", async (req, reply) => {
    const who = await identity(headers(req));
    if (who.deviceId) {
      await db.execute(
        sql`UPDATE device_credential SET revoked_at=now() WHERE id=${who.deviceId} AND user_id=${who.user.id}`,
      );
      return { ok: true };
    }
    const response = await auth.handler(
      new Request(`${config.APP_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: headers(req),
        body: "{}",
      }),
    );
    for (const cookie of response.headers.getSetCookie())
      reply.header("set-cookie", cookie);
    return { ok: true };
  });
  app.get(
    "/api/v1/operations",
    secured("financial", async (ctx) => ({
      delivery: await rows(
        sql`SELECT id,invoice_id,kind,state,attempts,error_code,created_at,sent_at FROM delivery_outbox WHERE workspace_id=${ctx.workspaceId} ORDER BY created_at DESC LIMIT 50`,
      ),
      webhooks: await rows(
        sql`SELECT id,event_type,state,error_code,received_at FROM webhook_inbox WHERE workspace_id=${ctx.workspaceId} AND state<>'processed' ORDER BY received_at DESC LIMIT 50`,
      ),
    })),
  );
  app.post(
    "/api/v1/delivery/:id/retry",
    secured("financial", async (ctx, req) => {
      await required(
        sql`UPDATE delivery_outbox SET state='queued',attempts=0,error_code=NULL WHERE workspace_id=${ctx.workspaceId} AND id=${id(req)} AND state='failed' RETURNING id`,
      );
      return { ok: true };
    }),
  );
  app.get("/api/config", async () => ({
    demoEnabled,
    googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID),
    appUrl: config.APP_URL,
    mode: config.BILLING_MODE,
  }));
  app.post("/api/demo/sign-in", async (req, reply) => {
    if (!demoEnabled || !["127.0.0.1", "::1"].includes(req.ip))
      throw new AppError(
        "DEMO_DISABLED",
        "Demo sign-in is available only on a local development server.",
        403,
      );
    const email = "alex@demo.runningtab.test";
    await auth.api.signInMagicLink({
      body: { email, callbackURL: "/today" },
      headers: new Headers({ origin: config.APP_URL }),
    });
    const url = demoMagicLinks.get(email);
    demoMagicLinks.delete(email);
    if (!url)
      throw new AppError(
        "DEMO_NOT_READY",
        "Seed the demo workspace first.",
        503,
      );
    const response = await auth.handler(
      new Request(url, { headers: new Headers({ origin: config.APP_URL }) }),
    );
    const cookie = response.headers.getSetCookie();
    if (cookie.length) reply.header("set-cookie", cookie);
    const token = response.headers.get("set-auth-token");
    if (!token)
      throw new AppError(
        "SIGN_IN_FAILED",
        "Unable to create the demo session.",
      );
    return { ok: true, token };
  });
  app.get("/api/session", async (req) => {
    const who = await identity(headers(req));
    const w = await one(
      sql`SELECT workspace_id FROM membership WHERE user_id=${who.user.id}`,
    );
    return {
      user: { name: who.user.name, email: who.user.email },
      onboarding: !w,
      verifiedAt: who.verifiedAt,
    };
  });
  app.post("/api/onboard", async (req) => {
    const who = await identity(headers(req));
    if (!who.scopes.includes("financial"))
      throw new AppError("FORBIDDEN", "Owner sign-in required.", 403);
    return createWorkspace(who.user, req.body as any);
  });
  app.get(
    "/api/v1/snapshot",
    secured("read", async (ctx, req) => {
      const q = DateRange.parse(req.query);
      return snapshot(ctx, q.from, q.to);
    }),
  );
  app.get(
    "/api/v1/timer",
    secured("read", async (ctx) => ({
      timer: await getTimer(ctx),
      serverTime: new Date().toISOString(),
    })),
  );
  app.post(
    "/api/v1/timer",
    secured("time:write", async (ctx, req) =>
      timerAction(ctx, req.body as any, key(req)),
    ),
  );
  app.post(
    "/api/v1/timer/:id/correct",
    secured("time:write", async (ctx, req) => {
      const v = z
        .object({ endedAt: ISO, version: z.number().int() })
        .parse(req.body);
      return correctTimer(ctx, id(req), v.endedAt, v.version);
    }),
  );
  app.post(
    "/api/v1/entries",
    secured("time:write", async (ctx, req) =>
      manualEntry(ctx, req.body as any, key(req)),
    ),
  );
  app.patch(
    "/api/v1/entries/:id",
    secured("time:write", async (ctx, req) =>
      patchEntry(ctx, id(req), req.body as any),
    ),
  );
  app.post(
    "/api/v1/clients",
    secured("write", async (ctx, req) => createClient(ctx, req.body as any)),
  );
  app.post(
    "/api/v1/clients/:id/archive",
    secured("write", async (ctx, req) => archiveClient(ctx, id(req))),
  );
  app.patch(
    "/api/v1/clients/:id",
    secured("write", async (ctx, req) =>
      updateClient(ctx, id(req), req.body as any),
    ),
  );
  app.post(
    "/api/v1/projects",
    secured("write", async (ctx, req) => createProject(ctx, req.body as any)),
  );
  app.get(
    "/api/v1/projects",
    secured("read", async (ctx) =>
      rows(
        sql`SELECT p.id,p.name,p.model,c.name client_name FROM project p JOIN client c ON c.id=p.client_id WHERE p.workspace_id=${ctx.workspaceId} AND p.status='active' ORDER BY p.name`,
      ),
    ),
  );
  app.patch(
    "/api/v1/projects/:id",
    secured("write", async (ctx, req) =>
      updateProject(
        ctx,
        id(req),
        z
          .object({
            status: z.enum(["active", "completed", "archived"]).optional(),
            rate: Cents.optional(),
            costRate: Cents.optional(),
            targetRate: Cents.optional(),
            estimateSeconds: z.number().int().positive().optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/tasks",
    secured("write", async (ctx, req) => {
      const v = z
        .object({ projectId: Id, title: z.string().trim().min(1).max(200) })
        .parse(req.body);
      return mutate(ctx, "task.create", v, async (tx) => {
        await required(
          sql`SELECT id FROM project WHERE id=${v.projectId} AND workspace_id=${ctx.workspaceId}`,
          tx,
        );
        return required(
          sql`INSERT INTO project_task(workspace_id,project_id,title) VALUES(${ctx.workspaceId},${v.projectId},${v.title}) RETURNING *`,
          tx,
        );
      });
    }),
  );
  app.patch(
    "/api/v1/tasks/:id",
    secured("write", async (ctx, req) => {
      const v = z.object({ completed: z.boolean() }).parse(req.body);
      await required(
        sql`UPDATE project_task SET completed_at=${v.completed ? new Date() : null} WHERE workspace_id=${ctx.workspaceId} AND id=${id(req)} RETURNING id`,
      );
      return { ok: true };
    }),
  );
  app.post(
    "/api/v1/invoices",
    secured("financial", async (ctx, req) =>
      createDraft(ctx, req.body as any, key(req)),
    ),
  );
  app.get(
    "/api/v1/invoices/:id",
    secured("read", async (ctx, req) => invoiceDetail(ctx, id(req))),
  );
  app.patch(
    "/api/v1/invoices/:id",
    secured("financial", async (ctx, req) =>
      editInvoice(ctx, id(req), req.body as any),
    ),
  );
  app.post(
    "/api/v1/invoices/:id/review",
    secured("financial", async (ctx, req) => requestReview(ctx, id(req))),
  );
  app.post(
    "/api/v1/invoices/:id/approve",
    secured("financial", async (ctx, req) =>
      approveInvoice(ctx, id(req), req.body as any, key(req)),
    ),
  );
  app.post(
    "/api/v1/invoices/:id/void",
    secured("financial", async (ctx, req) => voidDraft(ctx, id(req))),
  );
  app.post(
    "/api/v1/invoices/:id/access",
    secured("financial", async (ctx, req) => createAccess(ctx, id(req))),
  );
  app.post(
    "/api/v1/invoices/:id/revoke-access",
    secured("financial", async (ctx, req) => {
      await db.execute(
        sql`UPDATE client_access SET revoked_at=now() WHERE workspace_id=${ctx.workspaceId} AND invoice_id=${id(req)}`,
      );
      return { ok: true };
    }),
  );
  app.post(
    "/api/v1/invoices/:id/external-payment",
    secured("financial", async (ctx, req) =>
      externalPayment(
        ctx,
        id(req),
        z
          .object({ reference: z.string().trim().min(3).max(200) })
          .parse(req.body).reference,
      ),
    ),
  );
  app.post(
    "/api/v1/invoices/:id/reconcile",
    secured("financial", async (ctx, req) => reconcileInvoice(ctx, id(req))),
  );
  app.get("/api/portal/:token", async (req) => portal(params(req).token));
  app.post("/api/portal/:token/demo-pay", async (req) => {
    const a = await access(params(req).token);
    const v = z
      .object({ outcome: z.enum(["success", "decline", "authentication"]) })
      .parse(req.body);
    return demoCustomerPayment(portalContext(a), a.invoice_id, v.outcome);
  });
  app.post("/api/portal/:token/setup", async (req) => {
    const a = await access(params(req).token);
    z.object({ accepted: z.literal(true) }).parse(req.body);
    return createSavedMethodSetup(
      portalContext(a),
      a.invoice_id,
      `${config.APP_URL}/pay/${params(req).token}`,
    );
  });
  app.post("/api/portal/:token/revoke-consent", async (req) => {
    const a = await access(params(req).token);
    return revokeConsent(portalContext(a), a.client_id);
  });
  app.post(
    "/api/v1/buckets/:id/adjust",
    secured("financial", async (ctx, req) =>
      adjustBucket(
        ctx,
        id(req),
        z
          .object({
            seconds: z
              .number()
              .int()
              .min(-3600000)
              .max(3600000)
              .refine((n) => n !== 0),
            reason: z.string().trim().min(5).max(500),
          })
          .parse(req.body),
        key(req),
      ),
    ),
  );
  app.post(
    "/api/v1/milestones/:id/split",
    secured("financial", async (ctx, req) =>
      splitMilestone(
        ctx,
        id(req),
        z
          .object({ title: z.string().trim().min(1).max(200), amount: Cents })
          .parse(req.body),
        key(req),
      ),
    ),
  );
  app.post(
    "/api/v1/agreements/:id/terms",
    secured("financial", async (ctx, req) =>
      changeAgreementTerms(
        ctx,
        id(req),
        z
          .object({
            fee: Cents.refine((n) => n > 0),
            endDate: z.iso.date().nullish(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/buckets",
    secured("financial", async (ctx, req) =>
      createBucket(
        ctx,
        z
          .object({
            projectId: Id,
            name: z.string().min(1).max(120),
            seconds: z.number().int().min(60).max(3600000),
            price: Cents.refine((n) => n > 0),
            expiresAt: ISO.nullish(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.get(
    "/api/v1/buckets/:id/ledger",
    secured("read", async (ctx, req) => {
      await required(
        sql`SELECT id FROM retainer_bucket WHERE workspace_id=${ctx.workspaceId} AND id=${id(req)}`,
      );
      return rows(
        sql`SELECT * FROM retainer_ledger_entry WHERE workspace_id=${ctx.workspaceId} AND bucket_id=${id(req)} ORDER BY created_at,id`,
      );
    }),
  );
  app.post(
    "/api/v1/agreements",
    secured("financial", async (ctx, req) => {
      const v = z
        .object({
          projectId: Id,
          fee: Cents.refine((n) => n > 0),
          frequency: z.enum(["weekly", "monthly"]),
          anchor: z.iso.date(),
          timezone: z.string().refine((s) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: s });
              return true;
            } catch {
              return false;
            }
          }),
        })
        .parse(req.body);
      return createAgreement(ctx, v);
    }),
  );
  app.patch(
    "/api/v1/agreements/:id",
    secured("financial", async (ctx, req) => {
      const v = z
        .object({ status: z.enum(["active", "paused", "cancelled"]) })
        .parse(req.body);
      return mutate(
        ctx,
        "agreement.status",
        { id: id(req), ...v },
        async (tx) => {
          await required(
            sql`UPDATE billing_agreement SET status=${v.status} WHERE workspace_id=${ctx.workspaceId} AND id=${id(req)} RETURNING id`,
            tx,
          );
          await audit(tx, ctx, "agreement.status_changed", id(req), v);
          return { ok: true };
        },
      );
    }),
  );
  app.post(
    "/api/v1/schedules/run",
    secured("financial", async (ctx) => runSchedules(ctx)),
  );
  app.patch(
    "/api/v1/milestones/:id",
    secured("financial", async (ctx, req) => {
      const v = z.object({ ready: z.boolean() }).parse(req.body);
      return mutate(
        ctx,
        "milestone.readiness",
        { id: id(req), ...v },
        async (tx) => {
          await required(
            sql`UPDATE fixed_milestone SET ready=${v.ready} WHERE workspace_id=${ctx.workspaceId} AND id=${id(req)} AND NOT EXISTS(SELECT 1 FROM invoice_source_allocation WHERE milestone_id=${id(req)} AND released_at IS NULL) RETURNING id`,
            tx,
          );
          await audit(tx, ctx, "milestone.readiness", id(req), v);
          return { ok: true };
        },
      );
    }),
  );
  app.post(
    "/api/v1/repositories",
    secured("context:write", async (ctx, req) =>
      linkRepository(
        ctx,
        z
          .object({
            projectId: Id.nullable(),
            identity: z.string(),
            alias: z.string().max(120).default(""),
          })
          .parse(req.body),
      ),
    ),
  );
  app.get(
    "/api/v1/repositories",
    secured("read", async (ctx) =>
      rows(
        sql`SELECT * FROM repository_mapping WHERE workspace_id=${ctx.workspaceId}`,
      ),
    ),
  );
  app.patch(
    "/api/v1/repositories/:id",
    secured("context:write", async (ctx, req) =>
      configureRepository(ctx, id(req), req.body),
    ),
  );
  app.get(
    "/api/v1/development-sessions",
    secured("read", async (ctx) => developmentSessions(ctx)),
  );
  app.post(
    "/api/v1/development-sessions",
    secured("context:write", async (ctx, req) => uploadSession(ctx, req.body)),
  );
  app.patch(
    "/api/v1/development-sessions/:id",
    secured("write", async (ctx, req) => editSession(ctx, id(req), req.body)),
  );
  app.post(
    "/api/v1/development-sessions/:id/approve",
    secured("write", async (ctx, req) =>
      approveSession(ctx, id(req), req.body, key(req)),
    ),
  );
  app.post(
    "/api/v1/activity",
    secured("context:write", async (ctx, req) =>
      ingest(ctx, req.body as any, key(req)),
    ),
  );
  app.patch(
    "/api/v1/suggestions/:id",
    secured("write", async (ctx, req) =>
      reviewSuggestion(
        ctx,
        id(req),
        z
          .object({
            status: z.enum(["accepted", "rejected"]),
            projectId: Id.optional(),
            timeEntryId: Id.optional(),
          })
          .parse(req.body),
      ),
    ),
  );
  app.post(
    "/api/v1/descriptions",
    secured("write", async (ctx, req) =>
      draftDescriptions(
        ctx,
        z
          .object({
            entryIds: z.array(Id).max(30).default([]),
            sessionIds: z.array(Id).max(30).default([]),
            style: z
              .enum(["concise", "professional", "detailed", "technical"])
              .default("professional"),
            useAI: z.boolean().default(false),
            confirmedSharing: z.boolean().default(false),
          })
          .parse(req.body),
      ),
    ),
  );
  app.put(
    "/api/v1/settings",
    secured("write", async (ctx, req) => updateWorkspace(ctx, req.body as any)),
  );
  app.get(
    "/api/v1/devices",
    secured("financial", async (ctx) => devices(ctx)),
  );
  app.post(
    "/api/v1/devices",
    secured("financial", async (ctx, req) => {
      const v = z
        .object({
          name: z.string().min(1).max(120),
          kind: z.enum(["desktop", "cli"]),
        })
        .parse(req.body);
      return issueDevice(ctx, v.name, v.kind);
    }),
  );
  app.delete(
    "/api/v1/devices/:id",
    secured("financial", async (ctx, req) => revokeDevices(ctx, id(req))),
  );
  app.post(
    "/api/v1/sessions/revoke",
    secured("financial", async (ctx) => revokeDevices(ctx)),
  );
  app.post(
    "/api/v1/stripe/connect",
    secured("financial", async (ctx) => {
      recent(ctx);
      return connectAccount(ctx);
    }),
  );
  app.post(
    "/api/v1/stripe/refresh",
    secured("financial", async (ctx) => refreshAccount(ctx)),
  );
  app.post("/api/stripe/webhook", async (req) =>
    acceptWebhook(
      req.body as Buffer,
      z.string().parse(req.headers["stripe-signature"]),
    ),
  );
  app.post(
    "/api/v1/demo/consent/:id",
    secured("financial", async (ctx, req) => {
      if (!demoEnabled)
        throw new AppError("DEMO_DISABLED", "Demo setup is disabled.");
      return demoConsent(ctx, id(req));
    }),
  );
  app.post(
    "/api/v1/demo/process",
    secured("financial", async (ctx) => {
      if (!demoEnabled)
        throw new AppError("DEMO_DISABLED", "Demo processing is disabled.");
      return { processed: await processDemoQueue(ctx.workspaceId) };
    }),
  );
  app.post(
    "/api/v1/notifications/:id/snooze",
    secured("write", async (ctx, req) => {
      await required(
        sql`UPDATE notification SET snoozed_until=now()+interval '1 day' WHERE id=${id(req)} AND workspace_id=${ctx.workspaceId} RETURNING id`,
      );
      return { ok: true };
    }),
  );
  app.post(
    "/api/v1/reminders/refresh",
    secured("write", async (ctx) => {
      await refreshReminders(ctx);
      return { ok: true };
    }),
  );
  app.put(
    "/api/v1/close",
    secured("write", async (ctx, req) => {
      const v = z
        .object({
          from: z.iso.date(),
          to: z.iso.date(),
          step: z.number().int().min(0).max(4),
          notes: z.string().max(4000).default(""),
        })
        .parse(req.body);
      DateRange.parse(v);
      return required(
        sql`INSERT INTO close_review(workspace_id,starts_on,ends_on,step,notes) VALUES(${ctx.workspaceId},${v.from},${v.to},${v.step},${v.notes}) ON CONFLICT(workspace_id,starts_on,ends_on) DO UPDATE SET step=excluded.step,notes=excluded.notes RETURNING *`,
      );
    }),
  );
  app.get(
    "/api/v1/reports",
    secured("read", async (ctx, req) => {
      const q = DateRange.parse(req.query);
      return reports(ctx, q.from, q.to);
    }),
  );
  app.get(
    "/api/v1/exports/:kind",
    secured("financial", async (ctx, req, reply) => {
      const tables = {
        time: "time_entry",
        invoices: "invoice",
        lines: "invoice_line",
        payments: "payment",
        adjustments: "payment_adjustment",
        retainers: "retainer_ledger_entry",
      };
      const kind = z
        .enum([
          "time",
          "invoices",
          "lines",
          "payments",
          "adjustments",
          "retainers",
        ])
        .parse(params(req).kind);
      const data = await rows(
        sql`SELECT * FROM ${sql.identifier(tables[kind])} WHERE workspace_id=${ctx.workspaceId} ORDER BY id`,
      );
      const fields: Record<string, string[]> = {
        time: [
          "id",
          "project_id",
          "started_at",
          "ended_at",
          "actual_seconds",
          "billed_seconds",
          "rate",
          "currency",
          "treatment",
          "description",
          "deleted_at",
        ],
        invoices: [
          "id",
          "number",
          "client_id",
          "currency",
          "subtotal",
          "discount",
          "tax",
          "total",
          "paid_amount",
          "approval_state",
          "issuance_state",
          "collection_state",
          "created_at",
          "issued_at",
        ],
        lines: [
          "id",
          "invoice_id",
          "project_id",
          "description",
          "quantity_seconds",
          "unit_rate",
          "amount",
          "source_kind",
        ],
        payments: [
          "id",
          "invoice_id",
          "provider",
          "amount",
          "currency",
          "service_amount",
          "fee",
          "received_at",
        ],
        adjustments: ["id", "payment_id", "kind", "amount", "created_at"],
        retainers: [
          "id",
          "bucket_id",
          "time_entry_id",
          "payment_id",
          "kind",
          "seconds",
          "reason",
          "created_at",
        ],
      };
      reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="running-tab-${kind}.csv"`,
        );
      await audit(db, ctx, "export.created", kind, { rows: data.length });
      return csv(data, fields[kind]);
    }),
  );
  if (existsSync(resolve("dist/index.html"))) {
    await app.register(fastifyStatic, { root: resolve("dist"), prefix: "/" });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({
            error: { code: "NOT_FOUND", message: "Endpoint not found." },
          })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
