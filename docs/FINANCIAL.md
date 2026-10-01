# Financial model and invariants

## Separate state machines

| Concern        | States                                                                                 | Authority                                                       |
| -------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Timer          | running → paused/resumed → stopped                                                     | UTC timestamps, optimistic version and unique active-user index |
| Time treatment | hourly, fixed, prepaid, support, nonbillable, overage, written_off                     | Billing model + explicit owner classification                   |
| Approval       | draft → review → approved; material edits return to draft                              | Exact immutable revision hash and owner verification            |
| Issuance       | local → queued → issued; local void releases sources                                   | Worker/provider confirmation                                    |
| Collection     | unpaid, processing, paid, failed, authentication_required, partial, refunded, disputed | Confirmed payment/reconciliation, never redirects               |
| Operation      | queued → processing → succeeded/failed/blocked/reconcile                               | Durable record, stable provider key                             |
| Delivery       | queued → processing → sent/failed                                                      | SMTP acknowledgement; separate from payment                     |

A source may be reserved by only one active invoice. Even local draft allocations lock time. Discarding a local draft releases its sources; issued invoices require provider adjustments. Refunds do not release previously invoiced work. Ledger, revision and audit history is append-only.

All domain mutations serialize the owner and workspace rows, then enforce scoped foreign keys, unique indexes and optimistic versions. This deliberately favors correctness for solo workspaces over parallel write throughput. Idempotency records include the request hash; reusing a key for different input fails.

## Amounts and time

USD only; integers represent cents and seconds. `server/domain/math.ts` uses BigInt rational arithmetic with half-up rounding to cents. Rate precedence is authorized entry override → project → client → workspace. Entries snapshot the selected rate and rounding policy.

Optional time rounding rounds **each entry upward** to the configured increment. Actual seconds are retained. Each entry’s value is rounded to cents before grouping into lines, so changing grouping cannot change the invoice total. Splitting an entry can change billed seconds under an increment policy; both segments show their actual and billed values. Taxes are a manually configured exclusive basis-point rate after the discount. Discounts cannot exceed subtotal. Tax automation is absent.

UTC intervals can cross midnight/DST. Period reports clip intervals and split at the workspace’s local midnight. Financial reports use payment or issue instants in that same zone. Eligible hourly value uses the entry’s start date and is labeled accordingly; outstanding balances and project profitability are explicitly all-time. The Time page is an all-history work log with day grouping and review/search filters.

## Approval and payment

Approval requires a recent owner verification (15 minutes), exact revision/total/action, a ready connected account and, for off-session collection, the selected saved method plus unrevoked consent. Execution rechecks the snapshot, provider content/total, balance and consent. Approval expires if unexecuted for 24 hours.

Zero-balance drafts cannot be approved for issuance/collection in this MVP. Review or discard them rather than creating a payment attempt. Fixed-fee milestones can be divided before allocation; the original milestone retains the remainder and the total agreed fee is unchanged. Client-detail changes apply to new drafts and future rates, preserving existing invoice identity/address snapshots.

Transport retries reuse one operation/key. An ambiguous response enters reconciliation and blocks new approval. Definitive failure permits a newly reviewed approval. Customer payment and owner collection converge on the invoice’s own payment flow; there is no parallel unrelated PaymentIntent. Payment references and retainer grants are deduplicated locally as well as by provider context.

Unexpected partial cash is recorded in the payment ledger, attributed proportionally to service/tax with exact cumulative rounding, and blocks owner collection. User-entered partial payments/plans are not available. Full external payment is an explicit audited demo action; in Stripe sandbox, record it out-of-band in the connected account and reconcile. Unknown fees stay unknown rather than being invented.

## Prepaid hours

Purchases do not create usable hours until the invoice is confirmed fully paid. An append-only grant references that payment and bucket. Usage is deterministic: earliest expiry, then activation, then stable bucket ID. Only the overlap with each bucket’s funded interval can be covered; a second bucket cannot cover the same second. Late entries cannot resurrect a balance already expired by the worker. Correcting old work reverses the previous usage and records replacement usage; returned hours that have expired remain expired.

Uncovered seconds become an overage review. The owner can explicitly invoice only those seconds or write them off. Covered seconds never enter hourly eligibility. Covered entries cannot currently be split; correct the interval or reverse/remove and re-enter reviewed segments. Refunds reduce analytical funding; they never make covered time hourly-billable. Refund-related entitlement adjustments require an explicit operational review.

The ledger view supports explicit positive/negative adjustments with a reason and recent owner verification. An adjustment requires an already-funded bucket, cannot create a negative balance or revive expired hours, and never records cash. Complimentary coverage does not increase analytical service revenue: recognized coverage is capped at purchased seconds.

## Recurrence

Weekly anchors advance seven local calendar days. Monthly anchors retain their original day, clamped to each month’s final day (Jan 31 → Feb 28 → Mar 31). One agreement/period and one active period allocation are enforced. A worker catches up missed periods as drafts, never charges. Pausing suppresses generation; resuming catches up ungenerated periods since the anchor. Cancel an agreement when future catch-up is unwanted. No automatic prorations or complex entitlements.

Fee changes take effect on the first original-anchor billing date strictly after today in the agreement’s time zone. Missed earlier periods retain earlier terms, and generated periods/drafts stay unchanged. The optional end date excludes periods starting on or after that date. Archiving pauses active schedules and retains cancelled schedules as cancelled; existing invoices and balances remain.

## Metrics

- Cash: confirmed payment cents by receipt date; refunds and known fees shown separately.
- Issued value: invoice totals by issue date; not cash.
- Service funding: paid service amount excluding tax, after discount/refund allocation.
- Realized effective rate: attributable collected service / **all** project effort, including nonbillable time.
- Prepaid service allocation: net funded service price × consumed seconds / purchased seconds. Analytical value only; never another cash receipt.
- Projected fixed rate: agreed fee / estimated total hours. Labeled projected.
- Underquote: max(0, target rate × all project hours − agreed fee).
- Estimated contribution: attributable service − estimated labor − known processing fees. Current configured cost rates are assumptions, not payroll facts. No expense ledger is claimed.
- Contribution margin: contribution / attributable service; undefined at zero service. Missing cost → “Cost rate needed”.
- Time utilization: billable tracked seconds / all tracked seconds. Fixed/support/prepaid effort remains billable classification without extra hourly billing.
- Capacity utilization: billable seconds / configured weekly capacity prorated by calendar days in the requested period.

Refund and credit integration is conservative. Stripe-origin refunds are reconciled; comprehensive credit-note allocation and dispute-resolution accounting require further sandbox validation. None of these analytics is a general ledger or accounting system.
