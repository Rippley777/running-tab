# Deployment and operations

The architecture is one web/API process, one worker, PostgreSQL and SMTP. No Redis, Kubernetes or proprietary host is required. Tauri is the client; the HTTP server also serves the packaged web interface for authentication and client invoice access.

## Chosen hosted services (September 30, 2026)

Use **Render in Ohio** for a paid PostgreSQL 17 database, a paid web/API service, and a paid continuously running background worker. Use **Postmark** for transactional SMTP. [`render.yaml`](../render.yaml) captures the three Render resources; the API and worker use the database's private connection string. The worker runs `pg-boss` continuously, so a sleeping or expiring free compute tier cannot stall payment reconciliation, recurrence, or outbox delivery. PostgreSQL contains both application data and the durable job queue. No worker disk is needed.

The initial sizes are a 1 GB RAM PostgreSQL instance with 5 GB storage, and one 512 MB instance each for API and worker. These are starting sizes, not measured production capacity. At the published rates checked on this date, estimate **$49.50/month**: PostgreSQL $19, storage $1.50, API $7, worker $7, and Postmark Basic $15 for 10,000 messages. Usage above included limits, taxes, backups beyond Render's retention, and a domain are extra. Recheck prices before purchasing. Render's paid PostgreSQL has a three-day point-in-time recovery window on the Hobby workspace; arrange encrypted logical exports to separate durable storage and test a restore before real financial use. Do not use Render's free PostgreSQL: it expires after 30 days and has no managed recovery.

Sources: [Render pricing](https://render.com/pricing), [Render PostgreSQL recovery](https://render.com/docs/postgresql-backups), [Render background workers](https://render.com/docs/background-workers), [Postmark pricing](https://postmarkapp.com/pricing), [Postmark SMTP settings](https://postmarkapp.com/support/article/common-smtp-connection-errors).

### Provisioning checklist

1. Create and verify a sender domain or sender signature in Postmark. Put its transactional SMTP token access key/secret in `SMTP_USER`/`SMTP_PASSWORD`; use a verified address in `SMTP_FROM`. The Blueprint uses port 587 with required STARTTLS. Do not commit these values.
2. Connect the repository to Render and review the paid resources in `render.yaml` before creating the Blueprint. Supply `APP_URL` as the exact public HTTPS origin (custom domain or assigned `onrender.com` URL), the Postmark values, and Stripe **test** keys in the prompted fields. Production refuses an example auth secret, demo sign-in and live Stripe keys. The same generated auth secret, URL and provider credentials are passed to the worker by service references.
3. Keep the database, API and worker in Ohio. The Blueprint blocks public database connections (`ipAllowList: []`); use the private database URL inside Render. Both services run the advisory-locked migrations before starting, so first boot does not depend on manual ordering. Automatic deploys are off until the external sandbox acceptance checks are complete.
4. Point Stripe's **test** webhook at the public origin and complete the acceptance matrix in [STRIPE.md](STRIPE.md). Build the desktop with `RUNNING_TAB_API_URL` and `RUNNING_TAB_APP_URL` set to that same trusted HTTPS origin. Verify a real Postmark magic link, invoice and receipt; confirm the worker drains operations and housekeeping after a restart.
5. Configure external encrypted database exports, restore testing, monitoring and alerts for API health, worker liveness, queue failures, delivery failures and storage growth. Render's `/api/health` checks only database connectivity. Do not send real client invoices or claim live payment readiness until the independent review and provider checks in [STATUS.md](STATUS.md) are done.

## Containers / VM

`Dockerfile` and `deploy.compose.yml` are examples. **They were not built or deployed here because the local Docker daemon was unavailable.** Pin image digests and review resource limits for your deployment. The image retains TypeScript tooling because the server runs through tsx; this is a simple operational choice, not a minimal hardened image.

For containers, create an untracked `.env.production` with `NODE_ENV=production`, HTTPS `APP_URL`, `API_PORT=3001`, `DATABASE_URL=postgres://runningtab:…@postgres:5432/runningtab`, a cryptographically random auth secret, `DEMO_ENABLED=false`, `BILLING_MODE=stripe_test`, sandbox keys and SMTP settings. The app has no live mode. Supply `POSTGRES_PASSWORD` to Compose. Run the migration command with the same image/environment **before** starting the API and worker. Migrations use an advisory lock and a checked-in, ordered migration ledger. Never edit an already applied migration.

```sh
docker compose -f deploy.compose.yml build
docker compose -f deploy.compose.yml up -d postgres
docker compose -f deploy.compose.yml run --rm api node --import tsx scripts/migrate.ts
docker compose -f deploy.compose.yml up -d api worker
```

For a VM, `npm ci`, `npm run build`, then run `node --import tsx server/index.ts` and `node --import tsx server/worker.ts` under a process supervisor with the same environment. Database schema must already exist. Configure an HTTPS reverse proxy to API port 3001; do not expose PostgreSQL/SMTP admin ports publicly.

Example Caddy config (replace the hostname):

```caddyfile
runningtab.example.com {
  reverse_proxy 127.0.0.1:3001
}
```

Set `APP_URL=https://runningtab.example.com`. If forwarded client IPs are required, set `TRUSTED_PROXY=127.0.0.1/32,::1/128` only when those are the actual immediate proxy addresses; otherwise leave unset. Never trust arbitrary forwarded hosts/protocols. Canonical auth URLs come from `APP_URL`. Avoid access logs containing `/pay/` tokens or magic-link query strings; redact those paths or disable URL logging on private/auth routes.

## Worker and recovery

pg-boss owns operations and housekeeping jobs. Operation polling every few seconds is durable queue submission, not request-local financial work. Housekeeping generates recurring drafts, expires prepaid balances, builds reminders and reconciles Stripe state. Startup catches up missed jobs. Run at least one worker; the UI does not execute pending payments when a worker is down.

- `/api/health` checks database connectivity. It does not prove worker, Stripe or SMTP health.
- Settings → Payment setup exposes delivery state and provider attention. Payment attempts show their stable operation IDs in the database.
- Query pg-boss job failures for infrastructure errors; application logs carry safe request/record correlation IDs. Add alerts before hosting.
- SMTP delivery uses stable Message-IDs and an outbox. Lost acknowledgements can still result in duplicate email (at-least-once); they cannot duplicate a charge. Failed mail can be retried explicitly.
- Do not reset ambiguous payment operations. Reconcile provider account/object/metadata and local approval before operational repair.
- All replicas need consistent canonical URL, auth secret, provider mode and keys. Do not mix demo and Stripe histories.

## Backup and restore

Back up the entire database, including payment operations, immutable revisions, grants, webhook inbox and pg-boss. Losing deduplication history can be financially dangerous. Example commands (use protected environment or a password file, not a command-line password):

```sh
pg_dump --format=custom --file=runningtab.dump "$DATABASE_URL"
createdb runningtab_restore
pg_restore --dbname=runningtab_restore --no-owner runningtab.dump
```

Encrypt backups, restrict access, rotate and test restoration in an isolated environment. Disable workers and external email on restores until provider reconciliation is complete. Keep the same connected-account context but never replay operations blindly from a backup. Restore tests, recovery-point/time objectives and automated backup retention are operator responsibilities and were not exercised here.

## Optional integrations

Google: create a web OAuth client and use the library callback `/api/auth/callback/google` on the exact canonical origin; configure both Google env values. Account linking is deliberately disabled. No external Google verification occurred.

AI: set a server-only `OPENAI_API_KEY` and an appropriate structured-output-capable `AI_MODEL`, enable drafting in workspace settings and explicitly select/share evidence inside invoice editing. Without credentials, the labeled deterministic template works. The model cannot set rates, amounts, states or call tools. The adapter follows [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs); no external model request was made during verification.

SMTP: use a local Mailpit for development. Real outbound email requires explicit `SMTP_ALLOW_EXTERNAL=true`, TLS/credentials, verified sender configuration and separate delivery testing. Do not enable it merely to exercise fixtures.
