# Stripe sandbox integration

**Implemented against the pinned official Stripe Node SDK; no external Stripe account or credentials were available during this build. A real connected-account sandbox payment has not been verified. Live payment execution is unavailable.**

## Configuration

Use a fresh, unseeded PostgreSQL database/workspace. Set `BILLING_MODE=stripe_test`, `DEMO_ENABLED=false`, a platform `sk_test_…` secret and a webhook signing secret. Never use `sk_live_…`; configuration rejects it. Stripe and demo adapters cannot fall through to each other. Configure SMTP, canonical `APP_URL`, and a new auth secret; keep all keys out of source control.

The app uses **Connect Express accounts with direct-charge invoices**. Customers, setup sessions, methods, invoice items, invoices and payments are scoped to that freelancer’s connected account using the SDK’s account option. Running Tab subscription billing is absent. Express/platform liability, negative balances, disputes, onboarding and tax obligations require an explicit business and legal review before launch. [Stripe Connect invoice documentation](https://docs.stripe.com/connect/invoices).

1. Enable Connect in the Stripe sandbox. Sign in to a fresh workspace.
2. Open Settings → Payment setup → Set up Stripe Connect. Complete Stripe-hosted onboarding with Stripe’s published test data, then refresh readiness.
3. Keep the API and durable worker running. Forward **connected-account** events:

```sh
stripe login
stripe listen --forward-connect-to http://localhost:3001/api/stripe/webhook
```

Put the displayed signing secret in `STRIPE_WEBHOOK_SECRET` and restart API/worker. Do not confuse platform-only forwarding with connected-account events. In a hosted environment, register the HTTPS endpoint for connected-account events through Stripe Workbench. [Official CLI forwarding reference](https://github.com/stripe/stripe-cli/wiki/Listen-command).

4. Create/review work, generate a draft and approve “Issue for customer payment”. The worker creates the connected-account invoice, verifies its exact content and totals, finalizes with `auto_advance:false`, and queues the invoice email. Open the hosted invoice and use Stripe’s documented test payment methods.
5. Confirm the invoice and receipt in the app only after webhook/reconciliation. A browser return is never payment proof.
6. From the private client invoice page, explicitly accept the displayed off-session terms, then use Stripe Checkout **setup mode**. The worker retrieves the completed Checkout Session and SetupIntent, verifies connected account/customer/method and `off_session` use, and records consent only after success. The app stores provider IDs and last four digits, never PAN/CVC. [Saved payment method consent](https://docs.stripe.com/payments/existing-customers?platform=web&ui=stripe-hosted), [Checkout Sessions](https://docs.stripe.com/api/checkout/sessions).
7. Approve a new invoice’s exact saved-card charge. Test success, decline, additional authentication, consent revocation, account restriction, worker restart, duplicate webhook and customer-payment race.

## Approval controls

Provider invoices use `collection_method:send_invoice`, `auto_advance:false`, stable keys per local operation, and explicit finalization/payment calls. Stripe’s automatic billing engine must remain disabled for these invoices; verify account-level retry/dunning settings during sandbox setup as well. [Stripe automatic advancement controls](https://docs.stripe.com/api/invoices).

The approved snapshot includes customer/business identity, source allocation, line descriptions, subtotal, discounts, manually configured tax, currency, due date, memo and action. Provider content/totals are rechecked immediately before payment. A timeout is reconciliation-required, not permission to invent a new key or charge. Definitive failure needs a new owner approval. Current scope handles full external payments by recording them in the connected Stripe account, then reconciling in Running Tab; it does not trigger a charge.

## Operations and remaining validation

Raw-body signatures are verified before minimal event metadata is durably inserted and acknowledged. Delivery deduplication includes provider/account/event ID. The worker retrieves authoritative invoice state, rather than applying stale event payload status. Payment state cannot regress to unpaid/void after confirmed cash. Database integration tests cover signed synthetic events and a stubbed authoritative provider; these are not live sandbox certification.

Housekeeping reconciles issued invoices every five minutes. Provider refund/fee/dispute detection exists, but full credit-note handling, dispute closure, complex multi-payment fee attribution, and ambiguous creation recovery still require external validation and operator intervention. Unknown event kinds remain visible for review. An ambiguous creation with no provider ID stays blocked; locate the exact connected-account object and verify metadata before any operational repair. Do not delete a payment operation to retry it.

Settings → Payment setup shows failed/ambiguous operations, mail delivery and unprocessed webhooks. Inspect pg-boss failures in the database for worker failures. Retry email independently; it never invokes payment. Complete and record the scenario matrix above before representing this integration as ready for real clients.
