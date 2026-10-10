# Running Tab

**Track the work. Close the tab. Get paid.**

A native macOS application with a Rust core and a React interface, backed by a multi-tenant cloud API and PostgreSQL. Includes a Rust Git-context CLI. The desktop stores credentials in the system keychain; financial state lives on the server.

The local demo is fully usable without Stripe, Google, or AI credentials. It never charges a real card. See [verified status and limitations](docs/STATUS.md) before using external integrations.

## Local setup

Requirements: Node 24+, Rust 1.95 (pinned by rust-toolchain.toml), macOS/Xcode command-line tools for the desktop, PostgreSQL 17+, SMTP/Mailpit. Docker Compose supplies the last two:

```sh
npm ci
cp .env.example .env
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Open http://localhost:1420 and choose **Explore the demo workspace**. Mailpit is at http://localhost:8025. Email sign-in works with an address ending in `.test`; find its single-use link in Mailpit. External email recipients are blocked by default.

If ports are occupied by an existing local PostgreSQL/Mailpit, use those services instead of starting Compose. This build was verified with PostgreSQL on `127.0.0.1:55432` and Mailpit on 1025/8025; Docker was not available during verification.

## Native desktop

In development, start `npm run dev:api` and `npm run worker` in separate terminals, then run:

```sh
npm run desktop
```

Tauri starts Vite itself. Stop a separately running Vite first. Alternatively, keep `npm run dev` running and launch the already-built debug application:

```sh
open 'target/debug/bundle/macos/Running Tab.app'
```

To rebuild that local app: `npx tauri build --debug --bundles app`. For a cloud build, set `RUNNING_TAB_API_URL` and `RUNNING_TAB_APP_URL` to your trusted HTTPS origin **at build time**, then `npm run desktop:build`. Release builds refuse insecure HTTP. Signing and notarization are not configured. The local app still needs the API, worker, PostgreSQL and SMTP; it is a cloud client, not an offline database.

Sign in through the browser, create a desktop connection token at `/connect`, and paste it into the app. Native storage uses the OS keychain. Local demo sign-in is also available. Financial approvals require a sign-in from the last 15 minutes; reconnect with a freshly issued desktop credential after that window.

After rebuilding an unsigned local app, macOS may ask you to authorize access to its previously saved keychain credential. Handle that protected system dialog locally; the app waits for your decision. Signed distribution and its keychain behavior still need validation.

`⌘K`: command palette. `⌘⇧T`: Today/timer. `⌘⇧N`: manual time. The palette opens an always-on-top compact timer window. Closing a window never silently stops the server timer.

## Main workflows

1. Create a client and project, start a timer, pause/resume/switch, or add manual time. Refreshing preserves the timer.
2. In **Time**, open an entry and mark it reviewed. Fix intervals, descriptions, overlaps and overages explicitly.
3. Open **Friday Close** or **Billing**, select eligible sources for one client, and create a draft. Sources become reserved immediately.
4. Edit descriptions, discount, tax, memo or PO; review the exact revision and choose an action. The durable worker issues or collects only after explicit approval.
5. Open **Client link** and pay in the demo. A declined payment can be simulated and recovered. Receipts, cash reports and prepaid grants follow confirmed payment state.
6. A prepaid project’s **New hours bucket** creates an unfunded purchase. Pay its invoice to activate it; the ledger supports explicit coverage adjustments. Fixed projects let you divide the agreed fee into milestones and mark each ready. Recurring support schedules generate drafts only, with fee changes effective next period.

Demo data includes five clients, eight projects, all four billing models, a nearly depleted prepaid bucket, overdue/paid/draft/failed invoices, Git evidence and a forgotten timer. `DEMO_REFERENCE_DATE=YYYY-MM-DD` makes a fresh seed reproducible. Seeding an existing demo changes nothing. **Destructive local reset:** `CONFIRM_RESET=runningtab-local npm run db:reset`; it refuses production and requires demo mode.

## Git-aware tracking

Open **Development → Repositories & tracking setup** in the desktop app. Choose a repository, add its path, or discover repositories inside an explicitly selected workspace. Connect the result, select an existing client/project and optional task, and enable **Assisted** tracking. Add branch overrides for mixed client work; ambiguous rules stay unassigned.

Keep the desktop app running while coding. File metadata changes suggest sessions; commits alone never imply hours. Finish the session for review or let the idle threshold complete it. Review the evidence, adjust duration and description, then **Approve time entry**. Approved time joins the existing invoice workflow; approval never issues an invoice or charges a card. No AI key, GitHub OAuth or manual timer is required.

Web clients review synchronized suggestions but cannot inspect local files. Local paths and raw observations remain on the device. No source files, diffs, keystrokes or screenshots are collected. [Audit matrix, privacy, estimation rules and limitations](docs/GIT_TRACKING.md).

Run `npm test`, `npm run build`, then `npx playwright test --config playwright.development.config.ts` for the isolated session-to-invoice browser check. It uses the separate test database and port 3141; it does not need SMTP, Stripe, or AI. Deploy migrations 0006–0007 and the API before updating desktop clients.

## Rust CLI

```sh
cargo install --path crates/tab-cli --locked
# Create a CLI credential in Settings → Developer tools, then:
tab login
tab projects
cd /your/selected/repository
tab link --project <project-id>
tab start --description 'Implement account permissions'
tab status
tab context --since 2026-09-01
# Preview first; metadata upload is explicit:
tab context --since 2026-09-01 --include-subjects --upload
tab stop
```

Repository mappings use stable project IDs. No source, diffs, absolute paths or remote credentials are uploaded. Subjects and branches are optional. `.running-tab.json` is a local project mapping; add it to that repository’s ignore file if you prefer. Git evidence never implies a duration. [API and CLI details](docs/API.md).

## Verification

```sh
npm run typecheck
npm run lint
npm test                    # real, separate runningtab_test PostgreSQL database
npx playwright install chromium
npm run test:e2e             # requires local PostgreSQL and Mailpit; starts API/UI/worker
npm run test:cli             # requires the local API; exercises built Rust CLI + Git
npm run test:seed            # creates, checks and drops its own temporary database
cargo test -p tab-core
cargo check --workspace --locked
npm run build
npx tauri build --debug --bundles app
```

E2E tests create isolated fictional workspaces in the development database; they never reset the demo. Only `.test` email recipients are used. Domain tests require a separate database and refuse the main database URL. Production provider verification is not implied by these tests.

## Further documentation

- [Architecture and domain boundaries](docs/ARCHITECTURE.md)
- [Financial states and formulas](docs/FINANCIAL.md)
- [API, errors and exports](docs/API.md)
- [Stripe sandbox setup and responsibilities](docs/STRIPE.md)
- [Deployment, backup and restore](docs/DEPLOYMENT.md)
- [Security and live-launch checklist](docs/SECURITY.md)
- [Implementation status](docs/STATUS.md)

`brand.json` holds the product name, tagline, version and identifier. `npm run brand:sync` updates native packaging metadata. Brand prose in documentation and human-facing email templates should be reviewed when renaming.

## macOS Release

Run `npm run release:mac:check` to validate prerequisites, then `npm run release:desktop` for Developer ID signed, notarized ARM64, Intel and universal apps/DMGs. See [macOS release setup, credentials, outputs and verification](docs/MACOS_RELEASE.md). Existing development and Windows/Linux commands remain available.
