# Architecture

## Confirmed deployment decision

The user selected a cloud-backed SaaS with a native desktop client. PostgreSQL is authoritative. A disconnected client may preserve unsaved form input, but must not create financial truth offline. A persisted server timer keeps running through app closure and sleep.

## Modules

- `src/`: React desktop presentation, strict TypeScript contracts, accessible interaction. Vite builds static assets packaged inside Tauri.
- `src-tauri/`: native window, Rust HTTP/session broker, system keychain, and narrow IPC adapter. No arbitrary shell or filesystem access from the webview.
- `crates/tab-core/`: native Rust client, safe Git metadata extraction, device/session handling.
- `crates/tab-cli/`: intentional Git context and timer operations, sharing the Rust core.
- `server/`: TypeScript modular API, Better Auth, Drizzle/PostgreSQL domain services, official Stripe SDK and durable worker. The desktop Rust core is not the financial authority.
- `migrations/`: checked-in schema and database constraints.

PostgreSQL owns all workspace records. Composite tenant foreign keys prevent cross-workspace references. Domain services accept authenticated workspace context. Better Auth owns authentication and session lifecycle; desktop tokens live in the system keychain, not frontend storage. No SQLite billing database or offline financial synchronization.

## Domain model

Workspace/business settings → clients/contacts → projects/tasks/versioned terms → timer sessions and confirmed entries. Activity evidence/suggestions are separate from time. Billing sources (hourly entries, milestones, prepaid purchases, agreement periods) allocate once to invoice lines. Immutable invoice revisions bind approvals to content, amount, customer, currency and action. Durable operations separate transport retries from a new collection attempt. Confirmed payments fund prepaid grants; append-only consumption/reversal/expiry entries determine balance. Audit records identify actor and safe state metadata.

## Transaction boundaries

Timer start/switch serializes writers and enforces one active timer per owner. Source reservation, invoice revision and audit commit together. An edit invalidates approval. Approval and durable outbox creation commit together. Payment fulfillment and prepaid grants are idempotent. Recurrence is unique by agreement and period; missed periods catch up without generating charges.

## Source documentation consulted

- Tauri 2: https://v2.tauri.app/develop/calling-rust/ and https://v2.tauri.app/security/capabilities/
- Stripe Connect invoices: https://docs.stripe.com/connect/invoices
- Stripe invoice approval controls: https://docs.stripe.com/api/invoices/update
- Stripe invoice collection: https://docs.stripe.com/api/invoices/pay

The original Next.js/Better Auth/PostgreSQL stack was inspected before the desktop change. The native decision supersedes the web deployment architecture; implementation status will distinguish local features from hosted-service requirements.
