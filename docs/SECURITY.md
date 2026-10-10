# Security boundaries and launch review

## Implemented controls

- Better Auth owns magic links, cookies, expiry, single-use hashed verification and bearer verification. Automatic linking of unrelated provider accounts is disabled. Optional Google sign-in requires configured credentials.
- One owner per workspace. Context is derived from authenticated membership. Every domain read/write is scoped; composite foreign keys also reject cross-workspace relationships. Client access is separately scoped to one issued invoice.
- Session/device revocation, hashed random credentials, expiry, recent owner verification for financial approval and device issuance. OS keychain native storage; no credential in webview localStorage. Native sign-out revokes its current server credential and removes the keychain value.
- Exact money arithmetic, transactional source reservation, version checks, immutable invoice revisions and append-only ledger/audit history. One active timer per user is a database constraint.
- Fixed canonical origin, origin checks for cookie writes, explicit optional trusted-proxy allowlist, private no-store responses, bounded bodies and rate limits. Never configure `TRUSTED_PROXY=true` or a public network; use only the immediate proxy IP/CIDR.
- Tauri packages its frontend with a restrictive CSP. IPC exposes fixed API, repository selection, metadata preview, export and trusted URL actions; it does not expose arbitrary shell execution. Rust restricts host, redirects and API paths. Release network URLs must use HTTPS.
- Git commands use argument arrays and explicit directories. No hooks, diffs, source contents, or broad activity monitoring. Optional development tracking observes only approved repository metadata with bounded discovery, file enumeration and subprocess timeouts. Local paths are gated by the authenticated native workspace and never synchronized. Remotes are sanitized, subjects/branches opt-in, text redacted and treated as untrusted data.
- Stripe secrets exist only in deployment environment. Cards stay on Stripe pages. Setup consent records terms version, frequency, amount policy, time and revocation; saved method alone is insufficient authority.
- Logs contain event codes, record IDs and request IDs, not tokens, invoice contents, card details or prompts. AI uses bounded selected reviewed-entry or explicitly shared saved-session descriptions, no tools, structured validation, no stored prompt, 12-second timeout, at most 20 requests/day/workspace and a 1,200-token output ceiling.
- SMTP is restricted to `.test` recipients by default; local messages go to Mailpit. Delivery does not modify approval or payment state. Client links expire after seven days; manually reissuing one revokes earlier links.

## Before any public or live launch

Live execution is deliberately absent; passing a live key is rejected, not a feature flag to enable. Before implementing it:

- Obtain an independent authorization/tenant/security review and payment architecture review. This build is not security-certified or a claim of legal/tax compliance.
- Complete external Stripe tests, including lost acknowledgements, retries after provider key-retention windows, partial/credit/refund/dispute flows and account revocation. Close documented provider operational gaps.
- Add and validate stronger library-backed verification for live financial actions, account recovery and device renewal.
- Configure HTTPS, verified canonical origins, SMTP authentication, real email domain delivery, secret management/rotation, abuse controls and account-level monitoring. Do not ship demo authentication or seed data.
- Sign/notarize the macOS build and test distribution/update trust. Windows/Linux packaging has not been verified.
- Add backup/restore drills, worker/webhook alerting, health probes, database capacity limits, recovery objectives and an on-call procedure.
- Validate accessibility with keyboard and assistive technology; automated axe and responsive checks are only a subset.
- Add paginated/time-bounded large datasets before loading a large multi-year ledger; current snapshot endpoints load solo-workspace history.

## Data lifecycle

Exports are available to the owner. Unbilled time is soft-deleted; financial history is retained and adjusted rather than silently erased. Tokens are hashed; prompt content is not saved. Local manual drafts can remain in browser sessionStorage until saved/closed; they are not synchronized offline. Clear device sessions and local browser state when transferring a device.

There is no self-service destructive workspace deletion or automated legal-retention policy. Define retention with the business before launch. Keep encrypted backups under separate access controls; don't delete records with financial dependencies to fulfill a casual UI operation. Document legal deletion exceptions, anonymization and export requirements separately.

Development activity can be deleted from the review screen. This removes evidence and descriptive metadata from active views while retaining the minimal source ID and billing provenance needed to prevent re-import and duplicate billing. Approved time and invoice history follow existing financial retention and locking rules. Local unsynchronized sessions can be deleted separately in tracking setup. Changing accounts or signing out stops local collection for the previous workspace. Disabling a repository on the web reaches the connected desktop at its next synchronization; an offline desktop needs a local disable.
