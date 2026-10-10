# Implementation status

Git-tracking update verified: October 8, 2026. Earlier payment/mail/native-launch verification below dates to September 30, 2026. This is a working local MVP with a native macOS client and a cloud API architecture. No public deployment or live-payment verification occurred.

## Git-tracking verification (October 8)

The [audit matrix and tracking guide](GIT_TRACKING.md) records the existing implementation and completed gaps. Assisted local repository observation, branch rules, session review, durable edits, split/merge/discard, transactional approval, deterministic description styles and optional AI rewrite consent are implemented. No external app contracts or dependencies were added.

- TypeScript, ESLint and the production frontend build pass.
- `npm test`: **51 real-PostgreSQL tests** pass (37 existing plus 14 tracking/mapping/description tests).
- `cargo test -p tab-core --locked`: **16 tests** pass, including real temporary Git repositories and a simulated 85-minute session. Workspace check, Clippy with warnings denied, and Rust formatting pass.
- `npx playwright test --config playwright.development.config.ts`: **two journeys** pass: isolated authenticated session → persisted edits → approved entry → existing invoice draft, plus native-bridge synchronization and offline device pause, including 390px overflow and review-screen axe checks. Screenshots were inspected. The configured $75/hour and 85-minute example yields $106.25. The test simulates the native upload boundary; it does not claim 85 minutes of live human observation.
- `npx tauri build --debug --bundles app` builds the macOS debug app. This update was not signed/notarized, installed, or deployed. No paid AI or live payment request was made.

## Previously implemented and verified

- **Native desktop:** Tauri 2 application, Rust HTTP/session core, system-keychain credentials, trusted external links, native CSV save, repository selection and an always-on-top compact timer. App relaunch retains sign-in. React assets are packaged into the app; PostgreSQL remains authoritative. Closing the app does not stop the timer.
- **Foundation:** seven ordered PostgreSQL migrations, tenant-scoped foreign keys, immutable invoice revisions, append-only financial history, exact integer/rational calculations, one active timer per user, transactional source reservation, scoped/revocable desktop and CLI credentials. Pinned npm dependencies and both npm/Cargo lockfiles.
- **Authentication:** actual Better Auth email magic-link sign-in through local Mailpit, onboarding, sign-out/revocation and recent-verification checks. Explicit local demo sign-in is disabled in production.
- **Work:** client creation/editing/archive with a primary billing contact; four project billing models; prospective rates and project status; lightweight tasks; persistent start/pause/resume/switch/stop; manual duration or interval entry; review, interval corrections, nonbillable classification, eligible splits/deletion and context duplication. Overlap acknowledgement, overnight/DST reporting and retained actual/billed quantities.
- **Billing:** eligible-source inbox, fixed-fee milestone splitting without changing the contract total, one-client multi-project drafts, project/task/date grouping, exact discount/tax, due dates, memo/PO, immutable snapshots, explicit revision-bound approval, durable demo issuance/collection, payment recovery, single-invoice client links and confirmed receipts. Zero-balance drafts cannot enter collection.
- **Agreements:** payment-funded prepaid grants, deterministic coverage, reversals, expiry and audited adjustments; uncovered work requires an explicit overage/write-off decision. Weekly/monthly schedules generate drafts, catch up idempotently, preview dates, pause/cancel and apply fee changes from the next period without rewriting previous periods.
- **Friday Close:** saved review progress and notes, attention items, work treatment review, grouped client drafts, description help and individual invoice approval.
- **Developer context:** functional Rust CLI for project mapping, timers and opt-in Git metadata preview/upload. Sanitized remotes, no source/diffs/absolute paths, optional subjects/branches and explainable accept/reject/correct suggestions. CLI and desktop use separate keychain entries.
- **Reporting:** actual record-derived time/cash/issued/outstanding/refund/fee metrics, project-lifetime realized and projected rates, cost-dependent estimated contribution, prepaid analytical allocation and utilization. Exports cover time, invoices, lines, payments, adjustments and the prepaid ledger with formula-injection escaping.
- **Reminders and delivery:** deduplicated/snoozable in-app reminders, optional owner digest and separate durable invoice/receipt email outbox. Local acceptance tests confirm invoice and receipt SMTP delivery; failed mail can be retried without repeating a charge.
- **Interface:** graphite/amber operator workspace, light client invoice/receipt, keyboard palette, accessible form labels/focus, reduced-motion styles and mobile layout. Automated axe checks pass on the tested owner dashboard and paid client invoice, with a 390px billing layout overflow check.

### Earlier checks (September 30)

- `npm run check`: strict TypeScript, ESLint, **37 real-PostgreSQL domain/integration tests**, and production frontend build pass.
- `npm run test:e2e`: **four Chromium journeys** cover real local magic-link authentication, client/project creation, timer persistence, reviewed invoicing, exact approval, demo payment, receipts/dashboard, declined-payment recovery, prepaid funding/usage/adjustments and milestone/recurring-term controls.
- `cargo test -p tab-core --locked`: **four Rust tests** cover origin/path restrictions and sanitized Git metadata. `cargo check --workspace --locked` and Rust formatting pass.
- `npm run test:cli`: built CLI exercised against the local API using an isolated fictional workspace and temporary Git repository; project mapping, metadata preview/upload and start/status/stop verified.
- `npm run test:seed`: fresh temporary PostgreSQL database, all migrations and deterministic service-backed seed verified: **five clients, eight projects, 56 entries, seven invoices**; payment/ledger totals reconcile and prepaid balances are nonnegative.
- The final debug `.app` bundle builds and launches on this Apple Silicon Mac. After macOS keychain authorization cleared, saved sign-in, the packaged dashboard, command palette and compact timer layout were inspected directly. Closing the compact window retained the running server timer. That earlier verification left the main app on Today; the October update only rebuilt the bundle.

The frontend build currently emits an approximately 872 kB minified JavaScript chunk (235 kB gzip); further route splitting and large-data performance work remain. Passing local tests is not external provider or production certification.

## Implemented but not externally verified

- **Stripe sandbox:** official SDK, Express/direct-charge connected-account architecture, hosted onboarding, hosted saved-method setup, explicit off-session consent, provider invoice approval gate, stable operation keys, webhook raw-body signature verification/inbox, authoritative reconciliation and receipt integration. Signed synthetic callback/account-isolation/out-of-order tests pass; no actual Stripe account, checkout, card challenge, refund or dispute was exercised.
- **Google sign-in:** library provider configuration and UI entry point; OAuth callback and account behavior need a real configured Google client.
- **AI descriptions:** server-only OpenAI structured-output adapter, bounded selected reviewed notes, no payment tools, source validation, quota/timeout and accurately labeled fallback. No paid model request was made. The deterministic fallback and opt-in boundary are tested.
- **Hosting:** Docker/Compose examples and VM instructions exist. The local Docker daemon was unavailable; container build, remote hosting, real-domain email, backup restoration and production monitoring were not exercised.
- **Hosting selection:** A paid Render PostgreSQL/API/background-worker Blueprint and Postmark SMTP configuration are checked in. This resolves provider selection, but no account, paid service, domain, sender verification, external backup, container build, or deployment has been verified.
- **Distribution:** only local macOS debug packaging verified; no signing/notarization, updates, Windows/Linux packaging or cross-platform keychain test.

## Requires credentials or external configuration

- Stripe **test** platform credentials, webhook secret, sandbox connected account and a completed sandbox acceptance matrix in [STRIPE.md](STRIPE.md). The application rejects live keys; there is no live execution path.
- HTTPS canonical public origin, deployed API/worker/PostgreSQL, authenticated SMTP with explicitly enabled external recipients, secrets management and monitoring. Desktop release builds require trusted HTTPS URLs at compile time.
- Optional Google OAuth credentials and server-side AI key/model plus workspace/evidence opt-in.
- Signing/notarization credentials and an independent security/payment review before distributing or using this with real clients.

## Current MVP boundaries and remaining work

- One owner per workspace, USD, one primary client billing contact and business-name/address invoice branding. Multiple-contact routing, logo uploads and arbitrary invoice templates are not included.
- Client links authorize one invoice; there is no customer-wide invoice directory. Print/save-to-PDF works through the browser; Stripe-hosted PDF links are used when supplied by the provider. No separate local PDF-rendering service.
- The Time page is an all-history, day-grouped log with filters; dashboard/reports support week/month periods. A separate editable week grid is not included. Covered prepaid entries cannot be split directly; interval corrections or reversed/re-entered segments are supported.
- AI evidence selection uses reviewed entry descriptions or explicitly selected saved session descriptions. Private notes, raw files/diffs, paths, durations and rates are excluded from session AI input. Native sessions currently include commit hashes rather than commit subjects; owners can add confirmed work notes.
- Timer contracts validate both input and output at runtime. Other response projections are typed, but comprehensive response-schema parsing and paginated snapshot endpoints remain before large hosted workspaces.
- Full external-payment recording is an audited demo action. For Stripe sandbox, record an out-of-band receipt in the connected account and reconcile. User-entered partial payments and payment plans are deferred; unexpected provider partial receipts are recorded and block unsafe owner collection.
- Provider ambiguity without a recoverable invoice ID needs operator investigation. Comprehensive credit-note allocation, complex partial/multiple-provider-payment fee attribution, dispute closure and refund-related entitlement decisions need further implementation/validation before live use. No automatic financial repair or automatic payment retry is claimed.
- Email is at-least-once: an ambiguous SMTP acknowledgement can duplicate a message, never a charge. All implementation emails stayed in local Mailpit with fictional `.test` recipients.
- Full offline sync, richer library-backed verification/account recovery for live financial actions, automated backup/restore drills, retention/deletion policy, monitoring/alerting and independent accessibility/security review remain.

## Deliberately deferred

Team invitations/permissions, payroll/payouts, full project management/CRM, unapproved monitoring/screenshots/keystrokes, mobile/menu-bar integrations, cross-project pooled retainers, complex rollover/proration/hybrid contracts, multi-currency/tax automation/full accounting, expenses/accounting integrations, automatic replenishment, autonomous collections, a general AI assistant, Running Tab subscription billing and external Black Box integration. The user explicitly brought the native desktop client into scope; it is delivered rather than deferred.
