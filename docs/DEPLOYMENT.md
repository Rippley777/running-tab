# Deployment and operations

The architecture is one web/API process, one worker, PostgreSQL and SMTP. No Redis, Kubernetes or proprietary host is required. Tauri is the client; the HTTP server also serves the packaged web interface for authentication and client invoice access.

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
