import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import {
  ShieldCheck,
  ArrowUpRight,
  GitBranch,
  KeyRound,
  Plus,
  Check,
  ArrowDownToLine,
  RefreshCw,
  LogOut,
} from "lucide-react";
import type { Snapshot } from "../../shared/contracts";
import { api, openUrl, native, exportCsv, signOut } from "../lib/api";
import {
  Button,
  PageHeader,
  SectionHeading,
  Field,
  ErrorMessage,
  Badge,
  Modal,
} from "../components/ui";
import { parseMoney, day } from "../lib/format";
export function SettingsPage({
  data,
  onSignedOut,
}: {
  data: Snapshot;
  onSignedOut: () => void;
}) {
  const [tab, setTab] = useState("business"),
    [token, setToken] = useState<string | null>(null),
    [gitIdentity, setIdentity] = useState(""),
    [gitProject, setGitProject] = useState(data.projects[0]?.id ?? ""),
    [preview, setPreview] = useState<any>(null),
    [subjects, setSubjects] = useState(false),
    [branches, setBranches] = useState(false),
    [since, setSince] = useState(() =>
      new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
    ),
    [localError, setError] = useState<unknown>();
  const cache = useQueryClient();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<any[]>("/api/v1/devices"),
    enabled: tab === "developer",
  });
  const operations = useQuery({
    queryKey: ["operations"],
    queryFn: () => api<any>("/api/v1/operations"),
    enabled: tab === "payments",
    refetchInterval: 10000,
  });
  const m = useMutation({
    mutationFn: ({
      path,
      body,
      method = "POST",
    }: {
      path: string;
      body?: unknown;
      method?: string;
    }) =>
      api<any>(path, { method, data: body ?? {}, key: crypto.randomUUID() }),
    onSuccess: () => cache.invalidateQueries(),
  });
  const w = data.workspace;
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="A well-set-up workspace."
        description="The details that keep the work and the money in good order."
      />
      <div className="tabs settings-tabs">
        {[
          ["business", "Business details"],
          ["payments", "Payment setup"],
          ["developer", "Developer tools"],
          ["exports", "Data & exports"],
        ].map(([k, l]) => (
          <button
            key={k}
            className={tab === k ? "active" : ""}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      <ErrorMessage error={m.error ?? localError} />
      {tab === "business" ? (
        <section className="panel settings-panel">
          <SectionHeading title="Your business, on the record" />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              try {
                const optional = (k: string) =>
                  String(f.get(k) ?? "").trim()
                    ? parseMoney(String(f.get(k)))
                    : null;
                m.mutate({
                  path: "/api/v1/settings",
                  method: "PUT",
                  body: {
                    name: f.get("name"),
                    businessEmail: f.get("email"),
                    businessAddress: f.get("address"),
                    timezone: f.get("timezone"),
                    defaultRate: parseMoney(String(f.get("rate"))),
                    costRate: optional("cost"),
                    targetRate: optional("target"),
                    capacitySeconds: f.get("capacity")
                      ? Math.round(Number(f.get("capacity")) * 3600)
                      : null,
                    paymentTerms: Number(f.get("terms")),
                    weekStart: Number(f.get("weekStart")),
                    roundingMinutes: Number(f.get("rounding")),
                    aiEnabled: f.get("ai") === "on",
                    digestEnabled: f.get("digest") === "on",
                  },
                });
              } catch (er) {
                setError(er);
              }
            }}
          >
            <div className="form-grid">
              <Field label="Business name">
                <input name="name" defaultValue={w.name} required />
              </Field>
              <Field label="Invoice contact email">
                <input
                  name="email"
                  type="email"
                  defaultValue={w.business_email}
                  required
                />
              </Field>
            </div>
            <Field label="Business address">
              <textarea
                name="address"
                defaultValue={w.business_address}
                rows={3}
              />
            </Field>
            <div className="form-grid">
              <Field label="Time zone">
                <input
                  name="timezone"
                  defaultValue={w.timezone}
                  list="timezones"
                  required
                />
                <datalist id="timezones">
                  {[
                    "America/Chicago",
                    "America/New_York",
                    "America/Los_Angeles",
                    "America/Denver",
                    "Europe/London",
                    "UTC",
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </datalist>
              </Field>
              <Field label="Week starts on">
                <select name="weekStart" defaultValue={w.week_start}>
                  <option value="1">Monday</option>
                  <option value="0">Sunday</option>
                </select>
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Default hourly rate · USD">
                <input
                  name="rate"
                  defaultValue={(w.default_rate / 100).toFixed(2)}
                  required
                  inputMode="decimal"
                />
              </Field>
              <Field label="Target hourly rate · USD">
                <input
                  name="target"
                  defaultValue={
                    w.target_rate == null ? "" : w.target_rate / 100
                  }
                  inputMode="decimal"
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field
                label="Internal cost rate · USD"
                hint="Private. Used only for estimated contribution."
              >
                <input
                  name="cost"
                  defaultValue={w.cost_rate == null ? "" : w.cost_rate / 100}
                  inputMode="decimal"
                />
              </Field>
              <Field label="Weekly capacity · hours">
                <input
                  name="capacity"
                  type="number"
                  min="1"
                  max="168"
                  defaultValue={
                    w.capacity_seconds ? w.capacity_seconds / 3600 : ""
                  }
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Payment terms · days">
                <input
                  name="terms"
                  type="number"
                  min="0"
                  max="365"
                  defaultValue={w.payment_terms}
                />
              </Field>
              <Field
                label="Billing-time rounding"
                hint="Round up per entry. Actual seconds are preserved."
              >
                <select name="rounding" defaultValue={w.rounding_minutes}>
                  {[0, 1, 5, 6, 10, 15, 30].map((n) => (
                    <option key={n} value={n}>
                      {n ? `${n} minute increment` : "None · actual time"}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <label className="check-field">
              <input name="ai" type="checkbox" defaultChecked={w.ai_enabled} />
              Allow opt-in AI description drafting
            </label>
            <p className="fine-print">
              Descriptions always have a deterministic fallback. Each AI request
              needs explicit evidence selection; private notes are excluded.
            </p>
            <label className="check-field">
              <input
                name="digest"
                type="checkbox"
                defaultChecked={w.digest_enabled}
              />
              Daily attention email after 9am in my time zone
            </label>
            <footer className="form-footer">
              <span className="muted small">
                Rates apply to new work. Existing snapshots stay unchanged.
              </span>
              <Button busy={m.isPending}>
                {m.isSuccess ? <Check size={15} /> : null}Save settings
              </Button>
            </footer>
          </form>
        </section>
      ) : tab === "payments" ? (
        <div className="settings-columns">
          <section className="panel padded">
            <div className="integration-icon">
              <ShieldCheck size={25} />
            </div>
            <h2>A deliberate payment setup.</h2>
            <p className="muted">
              Your connected account is the invoice and payment authority. Every
              send or saved-card collection needs approval.
            </p>
            <div className="setup-checklist">
              <div>
                <Check size={16} />
                <span>Business details recorded</span>
              </div>
              <div>
                {data.account?.ready ? (
                  <Check size={16} />
                ) : (
                  <span className="step-dot">2</span>
                )}
                <span>
                  {data.mode === "demo"
                    ? "Isolated demo provider ready"
                    : data.account?.ready
                      ? "Stripe sandbox account ready"
                      : "Connect your Stripe sandbox account"}
                </span>
              </div>
              <div>
                <ShieldCheck size={16} />
                <span>Live payments disabled</span>
              </div>
            </div>
            {data.mode === "demo" ? (
              <div className="notice">
                <p>
                  Demo mode never calls Stripe. To test Stripe, configure
                  sandbox credentials and use a fresh workspace. See
                  docs/STRIPE.md.
                </p>
              </div>
            ) : (
              <div className="button-group">
                <Button
                  busy={m.isPending}
                  onClick={async () => {
                    const r = await m.mutateAsync({
                      path: "/api/v1/stripe/connect",
                    });
                    await openUrl(r.url);
                  }}
                >
                  Set up Stripe Connect
                  <ArrowUpRight size={15} />
                </Button>
                <Button
                  kind="secondary"
                  onClick={() => m.mutate({ path: "/api/v1/stripe/refresh" })}
                >
                  <RefreshCw size={14} />
                  Refresh status
                </Button>
              </div>
            )}
          </section>
          <section className="panel padded">
            <SectionHeading title="Your approval is required" />
            <ul className="plain-list">
              <li>Schedules generate drafts, never charges.</li>
              <li>Changing a draft invalidates its approval.</li>
              <li>A saved card is not consent to charge it.</li>
              <li>Definitive failures need a new approval.</li>
              <li>Ambiguous attempts are reconciled before retrying.</li>
            </ul>
            <p className="fine-print">
              A new sign-in is required for financial approvals after 15
              minutes. No live-payment operation is available in this build.
            </p>
          </section>
        </div>
      ) : tab === "developer" ? (
        <>
          <div className="settings-columns">
            <section className="panel padded">
              <SectionHeading title="A genuine connection to your work" />
              <p className="muted">
                An explicitly linked repository suggests a project. It never
                reconstructs hours from commits.
              </p>
              <pre className="code-block">
                tab login{`\n`}tab projects{`\n`}tab link --project
                &lt;project-id&gt;{`\n`}tab start --description "Account
                permissions"{`\n`}tab context --since 2026-09-01{`\n`}tab stop
              </pre>
              <Button
                kind="secondary"
                busy={m.isPending}
                onClick={async () => {
                  const r = await m.mutateAsync({
                    path: "/api/v1/devices",
                    body: { name: "My Git CLI", kind: "cli" },
                  });
                  setToken(r.token);
                }}
              >
                <KeyRound size={15} />
                Create CLI credential
              </Button>
              <p className="fine-print">
                Scoped to read, timers, and context ingestion. Cannot approve
                invoices or charge customers. Tokens are displayed once and
                stored only as hashes.
              </p>
            </section>
            <section className="panel padded">
              <SectionHeading title="Linked repositories" />
              {data.repositories.map((r) => (
                <div className="repo-setting" key={r.id}>
                  <GitBranch size={16} />
                  <div>
                    <strong>{r.identity}</strong>
                    <small>
                      {data.projects.find((p) => p.id === r.project_id)?.name}
                    </small>
                  </div>
                </div>
              ))}
              {native ? (
                <>
                  <Button
                    kind="secondary"
                    onClick={async () => {
                      try {
                        setIdentity(await invoke<string>("select_repository"));
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    <Plus size={15} />
                    Select local repository
                  </Button>
                  {gitIdentity && (
                    <>
                      <p className="repo-line">{gitIdentity}</p>
                      <Field label="Link to project">
                        <select
                          value={gitProject}
                          onChange={(e) => setGitProject(e.target.value)}
                        >
                          {data.projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Button
                        kind="secondary"
                        onClick={() =>
                          m.mutate({
                            path: "/api/v1/repositories",
                            body: {
                              projectId: gitProject,
                              identity: gitIdentity,
                              alias: "",
                            },
                          })
                        }
                      >
                        Confirm repository mapping
                      </Button>
                      <Field label="Commits since">
                        <input
                          type="date"
                          value={since}
                          onChange={(e) => setSince(e.target.value)}
                        />
                      </Field>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={subjects}
                          onChange={(e) => setSubjects(e.target.checked)}
                        />
                        Include commit subjects
                      </label>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={branches}
                          onChange={(e) => setBranches(e.target.checked)}
                        />
                        Include branch names
                      </label>
                      <Button
                        kind="secondary"
                        onClick={async () => {
                          try {
                            setPreview(
                              await invoke("git_preview", {
                                since,
                                subjects,
                                branches,
                              }),
                            );
                          } catch (e) {
                            setError(e);
                          }
                        }}
                      >
                        Preview metadata
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <p className="fine-print">
                  Open the native desktop app to select repositories, or use the
                  Rust CLI. Absolute paths stay on your device.
                </p>
              )}
            </section>
          </div>
          <section className="panel padded mt">
            <SectionHeading title="Connected devices" />
            {devices.data?.map((d) => (
              <div className="simple-row" key={d.id}>
                <div>
                  <strong>{d.name}</strong>
                  <small>{d.scopes.join(" · ")}</small>
                </div>
                <span>Expires {day(d.expires_at)}</span>
                <Badge status={d.revoked_at ? "void" : "active"}>
                  {d.revoked_at ? "Revoked" : "Active"}
                </Badge>
                <Button
                  kind="ghost"
                  disabled={Boolean(d.revoked_at)}
                  onClick={() =>
                    m.mutate({
                      path: `/api/v1/devices/${d.id}`,
                      method: "DELETE",
                    })
                  }
                >
                  Revoke
                </Button>
              </div>
            ))}
            <ErrorMessage error={devices.error} />
          </section>
        </>
      ) : (
        <>
          <section className="panel padded">
            <SectionHeading title="Your records, in your hands" />
            <p className="muted">
              CSV files include stable IDs and formula-injection protection.
              These exports are source records, not a complete accounting
              system.
            </p>
            <div className="export-grid">
              {[
                [
                  "time",
                  "Time entries",
                  "Actual seconds, billed seconds, rate snapshots",
                ],
                ["invoices", "Invoices", "Issued and draft amounts; not cash"],
                [
                  "lines",
                  "Invoice lines",
                  "Client-facing services and source categories",
                ],
                ["payments", "Payments", "Confirmed cash receipts"],
                [
                  "adjustments",
                  "Adjustments",
                  "Refunds, credits, and disputes",
                ],
                [
                  "retainers",
                  "Prepaid ledger",
                  "Grants, usage, reversals, and expiry",
                ],
              ].map(([kind, title, detail]) => (
                <button key={kind} onClick={() => exportCsv(kind)}>
                  <ArrowDownToLine size={18} />
                  <strong>{title}</strong>
                  <span>{detail}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="panel padded mt">
            <SectionHeading title="Sessions & access" />
            <p className="muted">
              Sign out on this device, or revoke every session and device
              credential for your account.
            </p>
            <div className="button-group">
              <Button
                kind="secondary"
                onClick={async () => {
                  await signOut();
                  onSignedOut();
                }}
              >
                <LogOut size={15} />
                Sign out
              </Button>
              <Button
                kind="danger"
                onClick={async () => {
                  await m.mutateAsync({ path: "/api/v1/sessions/revoke" });
                  await signOut();
                  onSignedOut();
                }}
              >
                Revoke all sessions
              </Button>
            </div>
          </section>
        </>
      )}
      {tab === "payments" && (
        <section className="panel padded mt">
          <SectionHeading title="Delivery & integration health" />
          <p className="fine-print">
            Email delivery is separate from invoice issuance and payment
            confirmation. Retrying mail never charges a client.
          </p>
          <ErrorMessage error={operations.error} />
          {operations.data?.delivery.map((d: any) => (
            <div className="simple-row" key={d.id}>
              <strong>{d.kind}</strong>
              <Badge status={d.state} />
              <span className="muted small">
                {d.error_code ?? day(d.created_at)}
              </span>
              {d.state === "failed" && (
                <Button
                  kind="secondary"
                  onClick={() =>
                    m.mutate({ path: `/api/v1/delivery/${d.id}/retry` })
                  }
                >
                  Retry delivery
                </Button>
              )}
            </div>
          ))}
          {data.operations
            .filter((o) => ["failed", "blocked", "reconcile"].includes(o.state))
            .map((o) => (
              <div className="simple-row" key={o.id}>
                <strong>Payment operation</strong>
                <Badge status={o.state} />
                <span>{o.error_code}</span>
              </div>
            ))}
          {operations.data?.webhooks.map((e: any) => (
            <div className="simple-row" key={e.id}>
              <strong>{e.event_type}</strong>
              <Badge status={e.state} />
              <span>{e.error_code ?? "Waiting for worker"}</span>
            </div>
          ))}
        </section>
      )}
      {token && (
        <Modal
          title="Your new device credential"
          description="Copy it now. Only its hash is stored on the server. Don’t put this token in source control."
          onClose={() => setToken(null)}
        >
          <Field label="Device token">
            <input readOnly value={token} onFocus={(e) => e.target.select()} />
          </Field>
          <footer className="form-footer">
            <Button onClick={() => navigator.clipboard.writeText(token)}>
              Copy credential
            </Button>
          </footer>
        </Modal>
      )}
      {preview && (
        <Modal
          wide
          title="Exactly what will be shared"
          description="No source code, diffs, filesystem paths, or environment files. Subjects and branches can contain sensitive information; review them before upload."
          onClose={() => setPreview(null)}
        >
          <pre className="code-block metadata-preview">
            {JSON.stringify(preview, null, 2)}
          </pre>
          <footer className="form-footer">
            <Button kind="secondary" onClick={() => setPreview(null)}>
              Keep local
            </Button>
            <Button
              busy={m.isPending}
              onClick={async () => {
                await m.mutateAsync({
                  path: "/api/v1/activity",
                  body: preview,
                });
                setPreview(null);
              }}
            >
              Upload this metadata
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
