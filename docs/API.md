# HTTP API and CLI contract

Canonical origin is `APP_URL`. Endpoints use JSON under `/api/v1`; workspace identity comes exclusively from a verified session or scoped device token. UUIDs are stable. API bodies cannot choose a tenant. No shared caching of private responses.

Browser writes require the canonical Origin and a Better Auth session cookie. Native/CLI requests use `Authorization: Bearer rt_…` through the Rust client, which restricts host/path and disallows redirects. Device tokens expire after 30 days, are revocable, and are stored hashed server-side. Desktop scopes: read/write/financial. CLI scopes: read/time:write/context:write; no approvals, settings or financial exports.

Timer writes, manual entry creation, draft creation, milestone splits, prepaid adjustments and financial approval require an `Idempotency-Key` of 8–120 characters. Retry a timed-out request with **the same key and identical body**. Changing a body requires a new operation key. A stale entity version returns 409.

## Core examples

```http
POST /api/v1/timer
Idempotency-Key: <unique UUID>
Content-Type: application/json

{"action":"start","projectId":"<uuid>","description":"Account permissions","billable":true}
```

`GET /api/v1/timer` and timer writes return the runtime-validated shared `TimerResponse`:

```json
{
  "timer": {
    "id": "<uuid>",
    "project_id": "<uuid>",
    "project_name": "API",
    "client_name": "Client",
    "state": "running",
    "started_at": "…Z",
    "segment_started_at": "…Z",
    "accumulated_seconds": 0,
    "description": "Account permissions",
    "version": 1,
    "billable": true
  },
  "serverTime": "…Z"
}
```

An idle timer is `null`. Other actions: `pause`, `resume`, `stop` with `version`; `switch` with `version` and new project/context. Manual time: `POST /entries` with `projectId`, UTC `startedAt`/`endedAt`, description, privateNote, billable, optional taskId and explicit overlap acknowledgement. Authorized rateOverride is in cents. `PATCH /entries/:id` supports description/review, eligible interval/classification corrections, splitSeconds, soft delete, and overageDecision `invoice|write_off`.

## Routes

All paths below are prefixed `/api/v1` unless stated otherwise. Inputs are validated by Zod; full DTO types are in `shared/contracts.ts`. Only timer outputs currently have comprehensive runtime parsing; dashboard DTOs are typed projections.

| Route                                                  | Purpose                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /snapshot?from=YYYY-MM-DD&to=YYYY-MM-DD`          | Workspace data + period metrics; end date exclusive, max one year                    |
| `POST /clients`, `POST /clients/:id/archive`           | Create/archive billing client and primary contact                                    |
| `GET/POST /projects`, `PATCH /projects/:id`            | Project records and prospective rates/status                                         |
| `POST /tasks`, `PATCH /tasks/:id`                      | Lightweight task labels/completion                                                   |
| `POST /timer`, `GET /timer`, `POST /timer/:id/correct` | Persistent intentional time capture                                                  |
| `POST /entries`, `PATCH /entries/:id`                  | Manual work and audited review/correction                                            |
| `POST /invoices`                                       | Explicit source IDs, clientId, groupBy project/task/date; reserve sources atomically |
| `GET/PATCH /invoices/:id`                              | Private detail; edit descriptions, due date, memo, PO, discount/tax with revision    |
| `POST /invoices/:id/review`, `/approve`, `/void`       | Review request, exact approval, discard local draft                                  |
| `POST /invoices/:id/access`                            | Issue a seven-day client link, revoke earlier manually shared links                  |
| `POST /invoices/:id/external-payment`, `/reconcile`    | Audited full external payment / Stripe reconciliation                                |
| `POST /buckets`, `GET /buckets/:id/ledger`             | Unfunded project-specific prepaid purchase and ledger                                |
| `POST /agreements`, `PATCH /agreements/:id`            | Weekly/monthly fixed-support schedule and pause/resume/cancel status                 |
| `POST /schedules/run`                                  | Owner-triggered catch-up; normal execution is the worker                             |
| `PATCH /milestones/:id`                                | Mark a fixed-fee milestone ready before allocation                                   |
| `POST /repositories`, `GET /repositories`              | Explicit sanitized repository/project mapping                                        |
| `POST /activity`                                       | Opt-in Git metadata ingestion, max 100 commits                                       |
| `PATCH /suggestions/:id`                               | Accept/reject/correct mapping; optional confirmed time-entry association             |
| `POST /descriptions`                                   | Selected reviewed entry IDs, useAI, confirmedSharing; structured suggestions         |
| `PUT /close`                                           | Save period, review step and notes                                                   |
| `GET /reports?from=…&to=…`                             | Defined period metrics                                                               |
| `PUT /settings`                                        | Business details, prospective rates, preferences                                     |
| `GET/POST /devices`, `DELETE /devices/:id`             | Scoped credentials, displayed once                                                   |
| `POST /sessions/revoke`                                | Revoke all owner sessions and device tokens                                          |
| `GET /operations`, `POST /delivery/:id/retry`          | Email/provider attention and safe mail retry                                         |
| `POST /stripe/connect`, `/stripe/refresh`              | Hosted sandbox Connect onboarding/readiness                                          |
| `POST /notifications/:id/snooze`, `/reminders/refresh` | In-app attention lifecycle                                                           |
| `GET /exports/:kind`                                   | Owner-only CSV exports                                                               |

Auth: library-managed `/api/auth/*`, `/api/session`, `/api/onboard`, `/api/sign-out`. `/api/demo/sign-in` is available only in explicitly enabled local development and refuses non-loopback requests. `/api/health` probes PostgreSQL. `/api/config` contains no secrets.

Additional agreement and client changes:

- `PATCH /clients/:id`: complete `ClientInput`, applied prospectively; existing invoice identity/address snapshots remain unchanged.
- `POST /milestones/:id/split`: `{title, amount}` in cents, smaller than the original amount; unallocated sources only. The original retains the remainder.
- `POST /buckets/:id/adjust`: `{seconds, reason}` with signed nonzero seconds and a five-character minimum reason. Requires recent verification; funded buckets only, no negative balance or restoration of expired coverage.
- `POST /agreements/:id/terms`: `{fee, endDate?}` in cents and optional exclusive ISO end date. Fee becomes effective at the next original-anchor billing date after today in the agreement's time zone.

Client access: `GET /api/portal/:token`, `POST …/setup` with explicit `accepted:true`, `POST …/revoke-consent`, and demo-only `POST …/demo-pay`. Tokens authorize a single issued invoice; private notes, Git evidence, raw time records, other clients and profitability are never returned. `/api/stripe/webhook` requires the raw body and valid connected-account sandbox signature.

## Activity input

```json
{
  "identity": "github.com/studio/project",
  "commits": [
    {
      "ref": "a1b2c3d4",
      "occurredAt": "2026-09-30T12:00:00Z",
      "subject": "Optional explicitly shared subject",
      "branch": "optional-branch"
    }
  ]
}
```

No source code, diffs or local paths. Mapping takes priority over inference. A suggestion is not a time entry. The future desktop/Black Box adapter can use this contract without introducing an external dependency. Client subjects are bounded and redacted again on the server; never intentionally include secrets.

## Errors

`{ "error": { "code": "CONFLICT", "message": "…", "requestId": "…" } }`. Typical statuses: 401 unauthorized/expired; 403 scope, origin or recent-auth required; 404 unavailable scoped record; 409 version/idempotency/source conflict; 422 schema/currency; 428 onboarding needed; 429 rate limit. Unexpected failures return a generic message and correlation ID, without private invoice contents.

## CSV semantics

- `time`: IDs, project, UTC interval, actual/billed seconds, snapshotted cents/hour, USD, treatment, description, soft deletion.
- `invoices`: totals in cents and separate approval/issuance/collection states. Includes drafts; **not cash**.
- `lines`: invoice/project IDs, descriptions, quantities in seconds, cents rates/amounts, source category. Currency is the parent invoice’s USD.
- `payments`: confirmed receipt cents, service portion, known fee, provider and timestamp. **Cash receipts**; subtract refunds separately.
- `adjustments`: payment ID, refund/credit/dispute category, cents and timestamp. Currency inherits the payment’s USD.
- `retainers`: bucket/source IDs, signed seconds, kind/reason/time. This is service coverage, not money.

All fields are quoted. Cells beginning with spreadsheet formula/control prefixes are escaped with an apostrophe. CSV exports are portable records, not a complete accounting ledger.

## Development sessions (v1)

- `PATCH /api/v1/repositories/:id`: optimistic `version`, nullable `projectId`, optional `taskId`, `billable`, `trackingEnabled`, and `rules` (`pattern`, nullable `projectId`, optional `taskId`, `billable`). Exact rules precede wildcards; equal precedence is ambiguous. Requires context-write permission.
- `POST /api/v1/development-sessions`: stable UUID `id`, `repositoryId`, `branch`, UTC `startedAt`/`endedAt`, integer `inferredSeconds`, configured `mergeSeconds` and bounded timestamped evidence. Requires enabled repository and context-write permission. Replays return the original status without replacing edits, including deletion tombstones. The server recomputes the maximum supported estimate.
- `GET /api/v1/development-sessions`: authenticated owner's latest 1,000 non-deleted sessions; never local paths.
- `PATCH /api/v1/development-sessions/:id`: owner-write permission, `version` plus `action`: `edit`, `discard`, `delete`, `split` (`splitAt`), or `merge` (`otherId`, `otherVersion`). Draft edits can contain project/task, billable, description, proposed start and duration in seconds. Merge requires identical billing context.
- `POST /api/v1/development-sessions/:id/approve`: owner-write permission, current `version` and the existing manual-entry payload. An optional idempotency header binds retries to exact input. Creates one reviewed entry with source-session provenance in the same transaction. No overlap override, invoice issuance or payment operation is supported by this endpoint.
- `POST /api/v1/descriptions`: existing reviewed `entryIds` **or** selected pending `sessionIds`, optional `style` (`concise`, `professional`, `detailed`, `technical`), `useAI`, and `confirmedSharing`. Only saved description text is shared; the bounded existing provider and fallback are reused. It cannot modify time or financial records.

No new external event, Deck or Pit Boss contract is introduced. Migrations 0006–0007 precede API/desktop rollout. Existing CLI commit ingestion and manual/timer endpoints remain supported.
