# Running Tab — product brief

Track the work. Close the tab. Get paid.

A quiet, precise desktop workspace for an independent developer. The primary loop is intentional time capture → review evidence → allocate eligible work → review an exact invoice → explicitly approve a financial action → reconcile confirmed payment.

The user changed the original web-first brief to a native Rust application with a web-based interface. Use Tauri 2, a Rust native core, and a React/TypeScript interface. Target macOS first. Product naming lives in `brand.json`.

The first complete slice must work without external credentials. Demo payment is conspicuously labeled and cannot invoke a real provider. Successful payment, approval, invoice issuance, and time classification remain separate concepts. USD only. Never infer hours from Git activity.

Design: graphite canvas, warm off-white, restrained amber, compact editorial typography, tabular numbers, visible keyboard focus. Persistent timer, useful empty states, and actions that describe exactly what will happen.

## Consequential decisions

- A desktop timer persists UTC timestamps; UI ticks are presentation only. Sleep/quit does not silently deduct time.
- Rust owns native session transport and Git context. Server-side domain services own every money calculation and state transition; the interface formats authoritative values.
- The user explicitly retained cloud-backed SaaS: PostgreSQL owns transactions, foreign keys, append-only ledgers, immutable revisions, and active-source uniqueness. No offline billing writes.
- No live payment execution, public deployment, customer email, or OS activity surveillance during development.
- Native signing/notarization and external-provider verification require external configuration.

## Acceptance priorities

Correct financial states and durable work take precedence over breadth. Every implemented view reads persisted records. Every unavailable integration is labeled honestly. Keep `docs/STATUS.md` current with actual verification results.
