import { DevelopmentPage, NativeCollector } from "./pages/Development";
import { useEffect, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useIsMutating,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  LayoutDashboard,
  Users,
  Folder,
  Clock3,
  ReceiptText,
  ChartNoAxesCombined,
  Settings,
  Search,
  ChevronDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  PanelLeftClose,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import type { Snapshot } from "../shared/contracts";
import brand from "../brand.json";
import {
  api,
  post,
  demoLogin,
  native,
  navigate,
  openUrl,
  ApiError,
} from "./lib/api";
import { dateRange, parseMoney } from "./lib/format";
import { Button, Modal, Field, ErrorMessage, Link } from "./components/ui";
import { TimeForm } from "./components/forms";
import { TimerRail, TimerCard } from "./components/timer";
import { Today, TimePage, ClientsPage, ProjectsPage } from "./pages/Work";
import {
  BillingPage,
  FridayClose,
  InvoicePage,
  PortalPage,
} from "./pages/Billing";
import { ReportsPage } from "./pages/Reports";
import { SettingsPage } from "./pages/Settings";
const navigation = [
  { path: "today", label: "Today", icon: LayoutDashboard },
  { path: "clients", label: "Clients", icon: Users },
  { path: "projects", label: "Projects", icon: Folder },
  { path: "time", label: "Time", icon: Clock3 },
  { path: "development", label: "Development", icon: Folder },
  { path: "billing", label: "Billing", icon: ReceiptText },
  { path: "reports", label: "Reports", icon: ChartNoAxesCombined },
];
function Brand() {
  return (
    <span className="brand-word">
      {brand.name.toLowerCase()}
      <span className="brand-period">.</span>
    </span>
  );
}
function Login({ onSuccess, path }: { onSuccess: () => void; path: string }) {
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api<any>("/api/config"),
  });
  const [email, setEmail] = useState(""),
    [token, setToken] = useState(""),
    [sent, setSent] = useState(false);
  const m = useMutation({
    mutationFn: async (kind: string) => {
      if (kind === "demo") {
        await demoLogin();
        onSuccess();
      } else if (kind === "connect") {
        await invoke("connect_device", { token });
        setToken("");
        onSuccess();
      } else if (kind === "google") {
        const r = await post("/api/auth/sign-in/social", {
          provider: "google",
          callbackURL: path === "/connect" ? "/connect" : "/today",
        });
        if (r.url) window.location.assign(r.url);
      } else {
        await post("/api/auth/sign-in/magic-link", {
          email,
          callbackURL: path === "/connect" ? "/connect" : "/today",
          newUserCallbackURL: "/onboard",
        });
        setSent(true);
      }
    },
  });
  return (
    <main className="auth-screen">
      <div data-tauri-drag-region className="auth-drag" />
      <div className="auth-brand">
        <Brand />
        <span className="eyebrow">A LITTLE ORDER FOR INDEPENDENT WORK</span>
      </div>
      <section className="auth-card">
        <div className="auth-monogram">rt</div>
        <span className="eyebrow">YOUR WORK HAS VALUE</span>
        <h1>
          A clear head.
          <br />A closed tab.
        </h1>
        <p>
          Track the work. Know what it earns.
          <br />
          Get back to the part you love.
        </p>
        {native ? (
          <>
            <Button
              onClick={() =>
                openUrl(
                  `${config.data?.appUrl ?? "http://localhost:1420"}/connect`,
                )
              }
            >
              Sign in through your browser
              <ArrowUpRight size={16} />
            </Button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                m.mutate("connect");
              }}
            >
              <Field
                label="Desktop connection token"
                hint="After signing in, create a desktop token in the browser."
              >
                <input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste your rt_ token"
                  autoComplete="off"
                  type="password"
                  required
                />
              </Field>
              <Button kind="secondary" busy={m.isPending} type="submit">
                Connect this desktop
                <ArrowRight size={15} />
              </Button>
            </form>
          </>
        ) : sent ? (
          <div className="auth-sent">
            <Check size={22} />
            <h3>Check your inbox.</h3>
            <p>
              A single-use sign-in link is on its way to {email}. It expires in
              ten minutes.
            </p>
            <button className="text-button" onClick={() => setSent(false)}>
              Use a different email
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate("email");
            }}
          >
            <Field label="Your email">
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourstudio.com"
                required
              />
            </Field>
            <Button busy={m.isPending} type="submit">
              Send me a sign-in link
              <ArrowRight size={16} />
            </Button>
          </form>
        )}
        {!native && config.data?.googleEnabled && (
          <Button
            kind="secondary"
            busy={m.isPending}
            onClick={() => m.mutate("google")}
          >
            Continue with Google
          </Button>
        )}
        <ErrorMessage error={m.error ?? config.error} />
        {config.data?.demoEnabled && (
          <div className="demo-signin">
            <span>Take a look around</span>
            <Button
              kind="secondary"
              busy={m.isPending}
              onClick={() => m.mutate("demo")}
            >
              Explore the demo workspace
              <ArrowRight size={15} />
            </Button>
            <small>Fictional clients. Real workflows. No real charges.</small>
          </div>
        )}
      </section>
      <footer>
        {brand.tagline}
        <span>
          {native ? "Native desktop · Rust + Tauri" : "Cloud workspace"}
        </span>
      </footer>
    </main>
  );
}
function Onboard({ onSuccess }: { onSuccess: () => void }) {
  const m = useMutation({
    mutationFn: (v: unknown) => post("/api/onboard", v),
    onSuccess,
  });
  return (
    <main className="auth-screen">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-card onboarding">
        <span className="eyebrow">MAKE YOURSELF AT HOME</span>
        <h1>
          Your name.
          <br />
          Your good work.
        </h1>
        <p>
          A few essentials, then you can start tracking. Payment setup can wait.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            m.mutate({
              name: f.get("name"),
              businessEmail: f.get("email"),
              businessAddress: f.get("address"),
              timezone: f.get("timezone"),
              defaultRate: parseMoney(String(f.get("rate"))),
            });
          }}
        >
          <Field label="Business / studio name">
            <input
              name="name"
              required
              autoFocus
              placeholder="Your name or studio"
            />
          </Field>
          <Field label="Invoice contact email">
            <input name="email" type="email" required />
          </Field>
          <Field label="Business address">
            <textarea name="address" rows={2} />
          </Field>
          <Field label="Time zone">
            <input
              name="timezone"
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone}
              required
            />
          </Field>
          <Field label="Default hourly rate · USD">
            <input
              name="rate"
              required
              defaultValue="150.00"
              pattern="[0-9]+(\.[0-9]{1,2})?"
            />
          </Field>
          <ErrorMessage error={m.error} />
          <Button busy={m.isPending}>
            Create my workspace
            <ArrowRight size={15} />
          </Button>
        </form>
      </section>
    </main>
  );
}
function DesktopConnect({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const m = useMutation({
    mutationFn: () =>
      post<{ token: string }>("/api/v1/devices", {
        name: "My desktop",
        kind: "desktop",
      }),
    onSuccess: (r) => setToken(r.token),
  });
  return (
    <main className="auth-screen">
      <div className="auth-brand">
        <Brand />
      </div>
      <section className="auth-card">
        <div className="auth-monogram">rt</div>
        <h1>
          Bring your work
          <br />
          to your desktop.
        </h1>
        <p>
          Your identity is verified. Create a connection token, then paste it
          into the native app. It will be stored in the system keychain.
        </p>
        {token ? (
          <>
            <Field label="Copy this token once">
              <input
                readOnly
                value={token}
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <Button onClick={() => navigator.clipboard.writeText(token)}>
              Copy desktop token
            </Button>
            <p className="fine-print">
              This token expires in 30 days. Financial approvals require
              verification within the last 15 minutes.
            </p>
          </>
        ) : (
          <Button busy={m.isPending} onClick={() => m.mutate()}>
            Create desktop connection
          </Button>
        )}
        <ErrorMessage error={m.error} />
        <button className="text-button" onClick={onDone}>
          Continue in this browser
          <ArrowRight size={15} />
        </button>
      </section>
    </main>
  );
}
export default function App() {
  const [path, setPath] = useState(window.location.pathname),
    [period, setPeriod] = useState("week"),
    [palette, setPalette] = useState(false),
    [paletteSearch, setPaletteSearch] = useState(""),
    [manual, setManual] = useState(false),
    [compactNav, setCompactNav] = useState(false),
    [calendar, setCalendar] = useState({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      weekStart: 1,
    });
  const range = dateRange(period, calendar.timezone, calendar.weekStart),
    cache = useQueryClient(),
    saving = useIsMutating();
  useEffect(() => {
    const fn = () => setPath(window.location.pathname);
    window.addEventListener("popstate", fn);
    return () => window.removeEventListener("popstate", fn);
  }, []);
  const portal = path.startsWith("/pay/");
  const q = useQuery<Snapshot>({
    queryKey: ["workspace", range.from, range.to],
    queryFn: () => api(`/api/v1/snapshot?from=${range.from}&to=${range.to}`),
    enabled: !portal,
    retry: (n, e) =>
      !(
        e instanceof ApiError &&
        ["UNAUTHORIZED", "ONBOARDING_REQUIRED"].includes(e.code)
      ) && n < 1,
    refetchInterval: 20000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (q.data)
      setCalendar({
        timezone: q.data.workspace.timezone,
        weekStart: q.data.workspace.week_start,
      });
  }, [q.data]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "t"
      ) {
        e.preventDefault();
        navigate("/today");
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "n"
      ) {
        e.preventDefault();
        setManual(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const reload = () => {
    cache.clear();
    void q.refetch();
  };
  if (portal) return <PortalPage token={path.split("/")[2]} />;
  if (q.error instanceof ApiError && q.error.code === "ONBOARDING_REQUIRED")
    return (
      <Onboard
        onSuccess={() => {
          navigate("/today");
          reload();
        }}
      />
    );
  if (q.error instanceof ApiError && q.error.code === "UNAUTHORIZED")
    return <Login path={path} onSuccess={reload} />;
  if (!q.data)
    return (
      <div className="boot-screen">
        <Brand />
        {q.error ? (
          <>
            <WifiOff size={28} />
            <h1>Let’s reconnect.</h1>
            <p>
              Your workspace couldn’t be reached. Server timers keep their
              timestamps.
            </p>
            <ErrorMessage error={q.error} />
            <Button kind="secondary" onClick={() => q.refetch()}>
              <RefreshCw size={16} />
              Try again
            </Button>
          </>
        ) : (
          <>
            <span className="boot-line" />
            <p>Opening your workspace…</p>
          </>
        )}
      </div>
    );
  const data = q.data;
  if (path === "/timer")
    return (
      <main className="compact-timer">
        <Brand />
        <TimerCard data={data} />
        <p className="fine-print">
          Server-synced · close this window without stopping your timer.
        </p>
      </main>
    );
  if (path === "/connect")
    return <DesktopConnect onDone={() => navigate("/today")} />;
  const page = path.split("/")[1] || "today",
    id = path.split("/")[2];
  const active =
    page === "invoice" ? "billing" : page === "close" ? "billing" : page;
  const label =
    page === "close"
      ? "Friday Close"
      : page === "invoice"
        ? "Invoice"
        : (navigation.find((n) => n.path === active)?.label ?? "Settings");
  const suggestions = data.suggestions.filter(
    (s) => s.status === "pending",
  ).length;
  const commands = [
    {
      label: "Open compact timer",
      detail: "A focused timer window",
      run: () =>
        native
          ? void invoke("open_compact_timer")
          : window.open("/timer", "timer", "width=480,height=460"),
    },
    ...navigation.map((n) => ({
      label: n.label,
      detail: "Go to page",
      run: () => navigate(`/${n.path}`),
    })),
    {
      label: "Friday Close",
      detail: "Review & bill confidently",
      run: () => navigate("/close"),
    },
    { label: "Add manual time", detail: "⌘ ⇧ N", run: () => setManual(true) },
    ...data.projects.map((p) => ({
      label: p.name,
      detail: p.client_name,
      run: () => navigate(`/projects/${p.id}`),
    })),
  ].filter((c) =>
    `${c.label} ${c.detail}`
      .toLowerCase()
      .includes(paletteSearch.toLowerCase()),
  );
  return (
    <div
      className={`app-shell ${native ? "native" : ""} ${compactNav ? "nav-compact" : ""}`}
    >
      <aside className="sidebar">
        <div data-tauri-drag-region className="window-drag" />
        <Link to="/today" className="brand">
          <div className="logo-mark">
            <i />
            <i />
            <i />
          </div>
          <Brand />
        </Link>
        <button
          className="workspace-switch"
          onClick={() => navigate("/settings")}
        >
          <span className="workspace-avatar">
            {data.user.name
              .split(" ")
              .map((s) => s[0])
              .join("")
              .slice(0, 2)}
          </span>
          <span>
            <strong>{data.workspace.name}</strong>
            <small>Independent workspace</small>
          </span>
          <ChevronDown size={13} />
        </button>
        <div className="nav-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((n) => (
            <Link
              key={n.path}
              to={`/${n.path}`}
              className={`nav-link ${active === n.path ? "active" : ""}`}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
              {n.path === "billing" &&
                data.invoices.filter((i) => i.issuance_state === "local")
                  .length > 0 && (
                  <b>
                    {
                      data.invoices.filter((i) => i.issuance_state === "local")
                        .length
                    }
                  </b>
                )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-close">
          <span className="close-icon">↗</span>
          <h3>
            A good week.
            <br />A clean close.
          </h3>
          <p>
            Turn loose ends into
            <br />a little peace of mind.
          </p>
          <button onClick={() => navigate("/close")}>
            Open Friday Close
            <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="sidebar-bottom">
          <Link
            to="/settings"
            className={`nav-link ${page === "settings" ? "active" : ""}`}
          >
            <Settings size={18} />
            <span>Settings</span>
          </Link>
          <button
            className="nav-link command-launcher"
            onClick={() => setPalette(true)}
          >
            <Search size={17} />
            <span>Quick find</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="sidebar-status">
            <span className="connection-dot" />
            {data.mode === "demo" ? "DEMO WORKSPACE" : "SANDBOX WORKSPACE"}
            <span>v{brand.version}</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar" data-tauri-drag-region>
          <div className="topbar-breadcrumb">
            <button
              className="icon-button"
              aria-label="Toggle sidebar"
              onClick={() => setCompactNav((v) => !v)}
            >
              <PanelLeftClose size={17} />
            </button>
            <span>Workspace</span>
            <ChevronRightSmall />
            <strong>{label}</strong>
          </div>
          <div className="topbar-right">
            <span className={`sync-state ${q.error ? "disconnected" : ""}`}>
              {q.error ? (
                <WifiOff size={12} />
              ) : saving ? (
                <RefreshCw size={12} className="spin" />
              ) : (
                <span className="connection-dot" />
              )}
              {q.error
                ? "Connection interrupted"
                : saving
                  ? "Saving…"
                  : "Connected"}
            </span>
            <select
              aria-label="Report period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
            <button
              className="profile-avatar"
              aria-label="Open workspace settings"
              onClick={() => navigate("/settings")}
            >
              {data.user.name
                .split(" ")
                .map((s) => s[0])
                .join("")
                .slice(0, 2)}
            </button>
          </div>
        </header>
        {q.error && (
          <div role="alert" className="stale-banner">
            Showing the last confirmed records. Reconnect before making changes.
            <button onClick={() => q.refetch()}>Retry</button>
          </div>
        )}
        <NativeCollector data={data} />
        <main id="main" className="main-content">
          {page === "today" || page === "" ? (
            <Today data={data} />
          ) : page === "time" ? (
            <TimePage data={data} />
          ) : page === "development" ? (
            <DevelopmentPage data={data} />
          ) : page === "clients" ? (
            <ClientsPage data={data} clientId={id} />
          ) : page === "projects" ? (
            <ProjectsPage data={data} projectId={id} />
          ) : page === "billing" ? (
            <BillingPage data={data} />
          ) : page === "close" ? (
            <FridayClose data={data} />
          ) : page === "invoice" && id ? (
            <InvoicePage data={data} id={id} />
          ) : page === "reports" ? (
            <ReportsPage data={data} />
          ) : page === "settings" ? (
            <SettingsPage data={data} onSignedOut={reload} />
          ) : (
            <Today data={data} />
          )}
        </main>
        <footer className="app-bottom">
          <TimerRail data={data} />
          <span className="bottom-context">
            {suggestions > 0 ? (
              <button onClick={() => navigate("/close")}>
                <span className="evidence-dot" />
                {suggestions} activity suggestions
                <ArrowUpRight size={12} />
              </button>
            ) : (
              <span>Your work, thoughtfully accounted for.</span>
            )}
            <span>{data.workspace.timezone}</span>
          </span>
        </footer>
      </div>
      {palette && (
        <Modal
          title="A shortcut to the good stuff"
          description="Find a project, open a page, or record some time."
          onClose={() => setPalette(false)}
        >
          <div className="palette-search">
            <Search size={18} />
            <input
              autoFocus
              aria-label="Search commands"
              placeholder="Where would you like to go?"
              value={paletteSearch}
              onChange={(e) => setPaletteSearch(e.target.value)}
            />
          </div>
          <div className="command-results">
            {commands.slice(0, 12).map((c) => (
              <button
                key={c.label}
                onClick={() => {
                  c.run();
                  setPalette(false);
                  setPaletteSearch("");
                }}
              >
                <span>{c.label}</span>
                <small>{c.detail}</small>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {manual && <TimeForm data={data} onClose={() => setManual(false)} />}
    </div>
  );
}
function ChevronRightSmall() {
  return <span className="breadcrumb-slash">/</span>;
}
