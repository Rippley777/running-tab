import { BillingChangeForm } from "../components/billing-changes";
import { DescriptionAssistant } from "../components/descriptions";
import { parseMoney, duration } from "../lib/format";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  Wallet,
  Clock3,
  ShieldCheck,
  ArrowDownToLine,
  Link2,
  RefreshCw,
  GitBranch,
  AlertCircle,
  Mail,
  CreditCard,
  X,
} from "lucide-react";
import type { Snapshot, Invoice, Line, Entry } from "../../shared/contracts";
import { api, post, navigate, openUrl, exportCsv } from "../lib/api";
import {
  money,
  hours,
  day,
  invoiceStatus,
  modelLabel,
  dateRange,
} from "../lib/format";
import {
  Button,
  Badge,
  PageHeader,
  SectionHeading,
  Empty,
  Link,
  Modal,
  Field,
  ErrorMessage,
  MoneyNote,
} from "../components/ui";
import { EditEntryForm } from "../components/forms";
import { Metric } from "./Work";
export function InvoiceTable({ invoices }: { invoices: Invoice[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Client</th>
            <th>Status</th>
            <th>Due date</th>
            <th className="numeric">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {invoices.map((i) => (
            <tr key={i.id} onClick={() => navigate(`/invoice/${i.id}`)}>
              <td>
                <Link to={`/invoice/${i.id}`}>
                  <span className="invoice-number">
                    <FileText size={16} />
                    {i.number}
                  </span>
                </Link>
                <small>Revision {i.revision}</small>
              </td>
              <td>{i.client_name}</td>
              <td>
                <Badge status={invoiceStatus(i)} />
              </td>
              <td>{day(i.due_at)}</td>
              <td className="numeric">
                <strong>{money(i.total, true)}</strong>
              </td>
              <td>
                <ChevronRight size={15} className="muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!invoices.length && (
        <Empty
          title="No invoices here yet"
          detail="Reviewed work is the start of a confident invoice."
        />
      )}
    </div>
  );
}
type Billable = {
  id: string;
  kind: "time" | "milestone" | "bucket" | "period";
  title: string;
  subtitle: string;
  amount: number;
  clientId: string;
};
function billableItems(
  data: Snapshot,
  range?: { from: string; to: string },
): Billable[] {
  return [
    ...data.entries
      .filter(
        (e) =>
          !e.invoice_id &&
          e.treatment === "hourly" &&
          e.reviewed &&
          e.description.trim() &&
          (!range ||
            (e.started_at.slice(0, 10) >= range.from &&
              e.started_at.slice(0, 10) < range.to)),
      )
      .map((e) => ({
        id: e.id,
        kind: "time" as const,
        title: e.description,
        subtitle: `${e.project_name} · ${hours(e.billed_seconds)}`,
        amount: Math.floor((e.billed_seconds * e.rate + 1800) / 3600),
        clientId: data.projects.find((p) => p.id === e.project_id)!.client_id,
      })),
    ...data.milestones
      .filter((m) => m.ready && !m.invoice_id)
      .map((m) => ({
        id: m.id,
        kind: "milestone" as const,
        title: m.title,
        subtitle: "Fixed-price milestone",
        amount: m.amount,
        clientId: m.client_id,
      })),
    ...data.buckets
      .filter((b) => !b.activated_at && !b.invoice_id)
      .map((b) => ({
        id: b.id,
        kind: "bucket" as const,
        title: b.name,
        subtitle: `${b.project_name} · ${hours(b.purchased_seconds)} prepaid`,
        amount: b.price,
        clientId: data.projects.find((p) => p.id === b.project_id)!.client_id,
      })),
    ...data.periods
      .filter((p) => !p.invoice_id)
      .map((p) => ({
        id: p.id,
        kind: "period" as const,
        title: `${p.project_name} support`,
        subtitle: `${p.starts_on} – ${p.ends_on}`,
        amount: p.fee,
        clientId: p.client_id,
      })),
  ];
}
function DraftModal({
  data,
  clientId,
  onClose,
  range,
}: {
  data: Snapshot;
  clientId: string;
  onClose: () => void;
  range?: { from: string; to: string };
}) {
  const items = billableItems(data, range).filter(
    (i) => i.clientId === clientId,
  );
  const [selected, setSelected] = useState<string[]>([]),
    [group, setGroup] = useState("project");
  const [key] = useState(() => crypto.randomUUID());
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: () =>
      post<Invoice>(
        "/api/v1/invoices",
        {
          clientId,
          groupBy: group,
          timeEntryIds: selected.filter(
            (id) => items.find((i) => i.id === id)?.kind === "time",
          ),
          milestoneIds: selected.filter(
            (id) => items.find((i) => i.id === id)?.kind === "milestone",
          ),
          bucketIds: selected.filter(
            (id) => items.find((i) => i.id === id)?.kind === "bucket",
          ),
          periodIds: selected.filter(
            (id) => items.find((i) => i.id === id)?.kind === "period",
          ),
        },
        key,
      ),
    onSuccess: (i) => {
      cache.invalidateQueries();
      onClose();
      navigate(`/invoice/${i.id}`);
    },
  });
  return (
    <Modal
      wide
      title={`Draft for ${data.clients.find((c) => c.id === clientId)?.name}`}
      description="Choose the work to include. Creating a draft won’t send an invoice or charge a card."
      onClose={onClose}
    >
      <div className="draft-toolbar">
        <label className="check-field">
          <input
            type="checkbox"
            checked={selected.length === items.length && items.length > 0}
            onChange={(e) =>
              setSelected(e.target.checked ? items.map((i) => i.id) : [])
            }
          />
          Select eligible work
        </label>
        <select
          aria-label="Group invoice lines"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="project">Group by project</option>
          <option value="task">Group by task</option>
          <option value="date">Group by date</option>
        </select>
      </div>
      <div className="source-list">
        {items.map((i) => (
          <label className="source-row" key={i.id}>
            <input
              type="checkbox"
              checked={selected.includes(i.id)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, i.id]
                    : selected.filter((x) => x !== i.id),
                )
              }
            />
            <div>
              <strong>{i.title}</strong>
              <small>{i.subtitle}</small>
            </div>
            <span>{money(i.amount, true)}</span>
          </label>
        ))}
      </div>
      <ErrorMessage error={m.error} />
      <footer className="form-footer">
        <div className="draft-total">
          <span>Estimated selected subtotal</span>
          <strong>
            {money(
              items
                .filter((i) => selected.includes(i.id))
                .reduce((n, i) => n + i.amount, 0),
              true,
            )}
          </strong>
        </div>
        <Button
          disabled={!selected.length}
          busy={m.isPending}
          onClick={() => m.mutate()}
        >
          Create draft
          <ArrowRight size={15} />
        </Button>
      </footer>
      <MoneyNote />
    </Modal>
  );
}
export function BillingPage({ data }: { data: Snapshot }) {
  const [tab, setTab] = useState("inbox"),
    [draft, setDraft] = useState<string | null>(null),
    [ledger, setLedger] = useState<string | null>(null),
    [change, setChange] = useState<{
      kind: "bucket" | "agreement";
      record: any;
    } | null>(null);
  const cache = useQueryClient();
  const items = billableItems(data);
  const groups = data.clients.filter((c) =>
    items.some((i) => i.clientId === c.id),
  );
  const q = useQuery({
    queryKey: ["ledger", ledger],
    queryFn: () => api<any[]>(`/api/v1/buckets/${ledger}/ledger`),
    enabled: Boolean(ledger),
  });
  const m = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(path, { method: "PATCH", data: body }),
    onSuccess: () => cache.invalidateQueries(),
  });
  const pending = data.invoices.filter(
    (i) => i.issuance_state !== "void" && i.collection_state !== "paid",
  );
  return (
    <>
      <PageHeader
        eyebrow="CLOSE THE LOOP"
        title="Good work. Clear invoices."
        description="See what’s billable, what’s approved, and what’s actually paid."
        actions={
          <>
            <Button kind="secondary" onClick={() => exportCsv("invoices")}>
              <ArrowDownToLine size={15} />
              Export
            </Button>
            <Button onClick={() => navigate("/close")}>
              Start Friday Close
              <ArrowUpRight size={15} />
            </Button>
          </>
        }
      />
      <div className="metrics-strip">
        <Metric
          label="ELIGIBLE TO DRAFT"
          value={money(items.reduce((n, i) => n + i.amount, 0))}
          sub="Reviewed hourly work and agreement charges"
        />
        <Metric
          label="NEEDS APPROVAL"
          value={String(
            data.invoices.filter((i) => i.issuance_state === "local").length,
          )}
          sub="Local drafts · nothing sent yet"
        />
        <Metric
          label="AWAITING PAYMENT"
          value={money(data.metrics.outstanding)}
          sub="Issued balances · all time"
        />
        <Metric
          label="CASH THIS PERIOD"
          value={money(data.metrics.cash)}
          sub="Confirmed payments only"
        />
      </div>
      <div className="toolbar">
        <div className="tabs">
          {[
            ["inbox", "Billing inbox"],
            ["invoices", "All invoices"],
            ["prepaid", "Prepaid hours"],
            ["agreements", "Schedules"],
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
        <span className="mode-indicator">
          <ShieldCheck size={13} />
          {data.mode === "demo" ? "Isolated demo billing" : "Stripe sandbox"}
        </span>
      </div>
      {tab === "inbox" ? (
        <>
          <SectionHeading
            title="Ready for a draft"
            aside={`${items.length} eligible sources`}
          />
          {groups.length ? (
            <div className="billing-client-grid">
              {groups.map((c) => {
                const sources = items.filter((i) => i.clientId === c.id);
                return (
                  <section className="billing-client" key={c.id}>
                    <div>
                      <span
                        className="client-avatar small-avatar"
                        style={{ color: c.color, background: `${c.color}18` }}
                      >
                        {c.name[0]}
                      </span>
                      <div>
                        <h3>{c.name}</h3>
                        <p>
                          {sources.length} reviewed source
                          {sources.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                    </div>
                    <strong>
                      {money(sources.reduce((n, s) => n + s.amount, 0))}
                    </strong>
                    <Button kind="secondary" onClick={() => setDraft(c.id)}>
                      Build draft
                      <ArrowRight size={14} />
                    </Button>
                  </section>
                );
              })}
            </div>
          ) : (
            <Empty
              title="Your billing slate is clear"
              detail="Review time entries or mark a fixed milestone ready to bring work into this inbox."
            />
          )}
          {data.entries.some((e) => e.treatment === "overage") && (
            <div className="notice warning">
              <AlertCircle size={18} />
              <div>
                <strong>Uncovered prepaid time needs a decision</strong>
                <p>
                  Covered hours are never billed again. Review the uncovered
                  portion in Friday Close.
                </p>
              </div>
              <Button kind="secondary" onClick={() => navigate("/close")}>
                Review overages
              </Button>
            </div>
          )}
          <section className="panel mt">
            <SectionHeading
              title="The next things to close"
              aside={`${pending.length} invoices`}
            />
            <InvoiceTable invoices={pending} />
          </section>
        </>
      ) : tab === "invoices" ? (
        <section className="panel">
          <InvoiceTable invoices={data.invoices} />
        </section>
      ) : tab === "prepaid" ? (
        <div className="retainer-grid">
          {data.buckets.map((b) => (
            <section className="panel retainer-card" key={b.id}>
              <div className="retainer-heading">
                <Wallet size={21} />
                <Badge status={b.activated_at ? "paid" : "draft"}>
                  {b.activated_at ? "Funded" : "Not funded"}
                </Badge>
              </div>
              <p className="eyebrow">{b.client_name}</p>
              <h2>{b.name}</h2>
              <div className="retainer-balance">
                <strong>{hours(b.balance)}</strong>
                <span>of {hours(b.purchased_seconds)} remaining</span>
              </div>
              <div className="progress">
                <span
                  style={{
                    width: `${Math.max(0, (b.balance / b.purchased_seconds) * 100)}%`,
                  }}
                />
              </div>
              <dl className="details-list">
                <div>
                  <dt>Purchase</dt>
                  <dd>{money(b.price)}</dd>
                </div>
                <div>
                  <dt>Expiry</dt>
                  <dd>{b.expires_at ? day(b.expires_at) : "No expiry"}</dd>
                </div>
                <div>
                  <dt>Consumption order</dt>
                  <dd>Earliest expiry first</dd>
                </div>
              </dl>
              <Button kind="secondary" onClick={() => setLedger(b.id)}>
                View the ledger
                <ArrowUpRight size={14} />
              </Button>
            </section>
          ))}
          {!data.buckets.length && (
            <Empty
              title="Hours, ready when needed"
              detail="Create a prepaid project, then add its first hour bucket."
            />
          )}
        </div>
      ) : (
        <section className="panel padded">
          <SectionHeading
            title="Recurring draft schedules"
            aside="Never automatic charges"
          />
          {data.agreements.map((a) => (
            <div className="agreement-row" key={a.id}>
              <div>
                <h3>{a.project_name}</h3>
                <p>
                  {money(a.fee)} /{" "}
                  {a.frequency === "monthly" ? "month" : "week"} · {a.timezone}
                </p>
                <small>Next dates: {a.next_dates.join(" · ")}</small>
                {a.next_terms && (
                  <small>
                    From {a.next_terms.effective_on}: {money(a.next_terms.fee)}{" "}
                    / period
                  </small>
                )}
                {a.end_date && <small>Ends {a.end_date}</small>}
              </div>
              <Badge status={a.status} />
              <Button
                kind="secondary"
                onClick={() =>
                  m.mutate({
                    path: `/api/v1/agreements/${a.id}`,
                    body: {
                      status: a.status === "active" ? "paused" : "active",
                    },
                  })
                }
              >
                {a.status === "active" ? "Pause schedule" : "Resume schedule"}
              </Button>
              <Button
                kind="ghost"
                onClick={() => setChange({ kind: "agreement", record: a })}
              >
                Change future terms
              </Button>
              <Button
                kind="ghost"
                disabled={a.status === "cancelled"}
                onClick={() =>
                  m.mutate({
                    path: `/api/v1/agreements/${a.id}`,
                    body: { status: "cancelled" },
                  })
                }
              >
                Cancel schedule
              </Button>
            </div>
          ))}
          {!data.agreements.length && (
            <Empty
              title="A steady rhythm"
              detail="Open a recurring support project to set its billing schedule."
            />
          )}
          <p className="fine-print">
            Monthly schedules preserve the original anchor day and clamp to the
            last day of shorter months. Missed periods generate drafts on
            recovery. No prorations.
          </p>
          <ErrorMessage error={m.error} />
        </section>
      )}
      {change && (
        <BillingChangeForm
          kind={change.kind}
          record={change.record}
          onClose={() => setChange(null)}
        />
      )}
      {draft && (
        <DraftModal
          data={data}
          clientId={draft}
          onClose={() => setDraft(null)}
        />
      )}{" "}
      {ledger && (
        <Modal
          title="An honest ledger"
          description="Grants, usage, reversals, and expiry are append-only records."
          onClose={() => setLedger(null)}
          wide
        >
          {q.isPending ? (
            <p>Loading ledger…</p>
          ) : (
            q.data?.map((l) => (
              <div className="ledger-row" key={l.id}>
                <Badge status={l.kind} />
                <div>
                  <strong>{l.reason}</strong>
                  <small>{day(l.created_at)}</small>
                </div>
                <b className="mono">
                  {l.seconds > 0 ? "+" : "−"}
                  {hours(Math.abs(l.seconds))}
                </b>
              </div>
            ))
          )}
          <ErrorMessage error={q.error} />
          <footer className="form-footer">
            <Button
              kind="secondary"
              onClick={() => {
                const record = data.buckets.find((b) => b.id === ledger);
                setLedger(null);
                setChange({ kind: "bucket", record });
              }}
            >
              Adjust funded hours
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
export function FridayClose({ data }: { data: Snapshot }) {
  const [range, setRange] = useState(dateRange("month"));
  const saved = data.closes.find(
    (c) =>
      c.starts_on.slice(0, 10) === range.from &&
      c.ends_on.slice(0, 10) === range.to,
  );
  const [step, setStep] = useState(saved?.step ?? 0),
    [notes, setNotes] = useState(saved?.notes ?? ""),
    [draft, setDraft] = useState<string | null>(null),
    [edit, setEdit] = useState<Entry | null>(null);
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: ({
      path,
      body,
      method = "POST",
    }: {
      path: string;
      body: unknown;
      method?: string;
    }) => api(path, { method, data: body, key: crypto.randomUUID() }),
    onSuccess: () => cache.invalidateQueries(),
  });
  const save = async (next: number) => {
    await m.mutateAsync({
      path: "/api/v1/close",
      method: "PUT",
      body: { ...range, step: next, notes },
    });
    setStep(next);
  };
  const periodEntries = data.entries.filter(
    (e) =>
      e.started_at.slice(0, 10) >= range.from &&
      e.started_at.slice(0, 10) < range.to,
  );
  const review = periodEntries.filter(
    (e) => !e.invoice_id && (!e.reviewed || !e.description || e.overlap),
  );
  const items = billableItems(data, range);
  const steps = [
    "Check the work",
    "Sort the billing",
    "Review each draft",
    "Follow it through",
  ];
  return (
    <>
      <PageHeader
        eyebrow="AVAILABLE ANY DAY OF THE WEEK"
        title="Friday Close."
        description="A small ritual. A clearer head. A properly closed tab."
        actions={<Badge status="paid">Progress saved to your workspace</Badge>}
      />
      <div className="close-layout">
        <aside className="close-sidebar">
          <div className="close-period">
            <span className="eyebrow">BILLING PERIOD</span>
            <Field label="From">
              <input
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
              />
            </Field>
            <Field label="Until · exclusive">
              <input
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
              />
            </Field>
          </div>
          <ol className="close-steps">
            {steps.map((s, i) => (
              <li
                className={`${step === i ? "active" : ""} ${step > i ? "done" : ""}`}
                key={s}
              >
                <button onClick={() => void save(i)}>
                  <span>
                    {step > i ? (
                      <Check size={14} />
                    ) : (
                      String(i + 1).padStart(2, "0")
                    )}
                  </span>
                  {s}
                </button>
              </li>
            ))}
          </ol>
          <div className="close-promise">
            <ShieldCheck size={22} />
            <p>Your approval is the boundary.</p>
            <span>
              No invoice is sent and no payment is collected until you review
              the exact action.
            </span>
          </div>
        </aside>
        <section className="panel close-content">
          <div className="close-content-heading">
            <span className="eyebrow">STEP {Math.min(step + 1, 4)} OF 4</span>
            <h2>{steps[Math.min(step, 3)]}</h2>
            <p>
              {
                [
                  "Catch the loose ends before they become billing questions.",
                  "Separate time spent from money ready to bill.",
                  "One client at a time. One clear, explicit approval.",
                  "A sent invoice is a beginning. Confirmed payment closes the loop.",
                ][Math.min(step, 3)]
              }
            </p>
          </div>
          {step === 0 ? (
            <>
              <div className="review-summary">
                <Clock3 size={20} />
                <strong>{review.length} time entries to review</strong>
                <span>
                  {hours(
                    periodEntries.reduce((n, e) => n + e.actual_seconds, 0),
                  )}{" "}
                  recorded in this period
                </span>
              </div>
              {review.map((e) => (
                <button
                  className="review-row"
                  key={e.id}
                  onClick={() => setEdit(e)}
                >
                  <div>
                    <strong>
                      {e.description || "Missing work description"}
                    </strong>
                    <span>
                      {e.project_name} · {day(e.started_at)}
                      {e.overlap ? " · Overlap detected" : ""}
                    </span>
                  </div>
                  <Badge status="review" />
                  <ChevronRight size={16} />
                </button>
              ))}
              {!review.length && (
                <div className="inline-success">
                  <Check size={17} />
                  Your confirmed work is in good shape.
                </div>
              )}
              {data.timer && (
                <div className="notice warning">
                  <Clock3 size={17} />
                  <p>
                    A timer is still {data.timer.state}. Review its duration
                    before closing the period.
                  </p>
                  <Button kind="ghost" onClick={() => navigate("/time")}>
                    Review timer
                  </Button>
                </div>
              )}
              <SectionHeading
                title="A little context from Git"
                aside="Evidence, never hours"
              />
              {data.suggestions
                .filter((s) => s.status === "pending")
                .map((s) => (
                  <div className="suggestion-row" key={s.id}>
                    <GitBranch size={17} />
                    <div>
                      <strong>{s.subject ?? s.commit_ref.slice(0, 8)}</strong>
                      <p>{s.reason}</p>
                    </div>
                    <button
                      className="icon-button"
                      title="Accept project association"
                      aria-label="Accept suggestion"
                      onClick={() =>
                        m.mutate({
                          path: `/api/v1/suggestions/${s.id}`,
                          method: "PATCH",
                          body: { status: "accepted" },
                        })
                      }
                    >
                      <Check size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title="Reject suggestion"
                      aria-label="Reject suggestion"
                      onClick={() =>
                        m.mutate({
                          path: `/api/v1/suggestions/${s.id}`,
                          method: "PATCH",
                          body: { status: "rejected" },
                        })
                      }
                    >
                      <X size={17} />
                    </button>
                  </div>
                ))}
            </>
          ) : step === 1 ? (
            <>
              {["hourly", "fixed", "prepaid", "support", "nonbillable"].map(
                (model) => {
                  const es = periodEntries.filter((e) => e.treatment === model);
                  return (
                    <div className="classification-row" key={model}>
                      <span>{modelLabel[model] ?? "Non-billable"}</span>
                      <strong className="mono">
                        {hours(es.reduce((n, e) => n + e.actual_seconds, 0))}
                      </strong>
                      <small>
                        {model === "hourly"
                          ? "Eligible after review"
                          : model === "nonbillable"
                            ? "Included in profitability"
                            : "Covered by the agreement; not hourly charges"}
                      </small>
                    </div>
                  );
                },
              )}
              {periodEntries
                .filter((e) => e.treatment === "overage")
                .map((e) => (
                  <div className="overage-row" key={e.id}>
                    <div>
                      <strong>{e.project_name}</strong>
                      <p>
                        {hours(e.actual_seconds - e.covered_seconds)} uncovered
                        · {hours(e.covered_seconds)} already covered
                      </p>
                    </div>
                    <Button
                      kind="secondary"
                      onClick={() =>
                        m.mutate({
                          path: `/api/v1/entries/${e.id}`,
                          method: "PATCH",
                          body: {
                            version: e.version,
                            overageDecision: "invoice",
                            reviewed: true,
                          },
                        })
                      }
                    >
                      Approve hourly overage
                    </Button>
                    <Button
                      kind="ghost"
                      onClick={() =>
                        m.mutate({
                          path: `/api/v1/entries/${e.id}`,
                          method: "PATCH",
                          body: {
                            version: e.version,
                            overageDecision: "write_off",
                          },
                        })
                      }
                    >
                      Write off
                    </Button>
                  </div>
                ))}
              <SectionHeading title="Build the right drafts" />
              {data.clients
                .filter((c) => items.some((i) => i.clientId === c.id))
                .map((c) => (
                  <div className="review-row" key={c.id}>
                    <div>
                      <strong>{c.name}</strong>
                      <span>
                        {items.filter((i) => i.clientId === c.id).length}{" "}
                        eligible sources
                      </span>
                    </div>
                    <Button kind="secondary" onClick={() => setDraft(c.id)}>
                      Choose work
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                ))}
              {!items.length && (
                <Empty
                  title="Nothing ready to draft in this period"
                  detail="Review incomplete work, or choose a wider billing period."
                />
              )}
            </>
          ) : step === 2 ? (
            <>
              <InvoiceTable
                invoices={data.invoices.filter(
                  (i) =>
                    i.issuance_state === "local" ||
                    i.issuance_state === "queued",
                )}
              />
              <p className="fine-print">
                Open each draft to inspect its source trail, client-facing
                descriptions, total, and collection action. Approvals are bound
                to that exact revision.
              </p>
            </>
          ) : (
            <>
              <InvoiceTable
                invoices={data.invoices
                  .filter((i) => i.issuance_state === "issued")
                  .slice(0, 12)}
              />
              <div className="inline-success">
                <ShieldCheck size={18} />
                Only provider-confirmed payments appear as cash collected.
              </div>
            </>
          )}
          <Field label="A note for when you return">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything to pick up next time…"
              rows={2}
            />
          </Field>
          <ErrorMessage error={m.error} />
          <footer className="close-footer">
            <Button
              kind="secondary"
              busy={m.isPending}
              onClick={() => void save(step)}
            >
              Save progress
            </Button>
            {step < 3 ? (
              <Button busy={m.isPending} onClick={() => void save(step + 1)}>
                Continue
                <ArrowRight size={15} />
              </Button>
            ) : (
              <Button busy={m.isPending} onClick={() => void save(3)}>
                Save this close
                <Check size={15} />
              </Button>
            )}
          </footer>
        </section>
      </div>
      {edit && <EditEntryForm entry={edit} onClose={() => setEdit(null)} />}{" "}
      {draft && (
        <DraftModal
          data={data}
          range={range}
          clientId={draft}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  );
}
export function InvoicePaper({
  invoice: i,
  lines,
}: {
  invoice: Invoice;
  lines: Line[];
}) {
  return (
    <article className="invoice-paper">
      <div className="paper-top">
        <div>
          <span className="paper-brand">
            rt<span> / </span>
            {i.business_snapshot.name}
          </span>
          <p className="preserve">{i.business_snapshot.address}</p>
          <p>{i.business_snapshot.email}</p>
        </div>
        <div>
          <span className="paper-label">INVOICE</span>
          <h2>{i.number}</h2>
          <span>
            {i.provider === "demo"
              ? "DEMO DOCUMENT · NO REAL CHARGE"
              : "Stripe sandbox"}
          </span>
        </div>
      </div>
      <div className="paper-parties">
        <div>
          <span className="paper-label">BILL TO</span>
          <h3>{i.client_snapshot.name}</h3>
          <p>{i.client_snapshot.email}</p>
          <p className="preserve">{i.client_snapshot.address}</p>
        </div>
        <div>
          <span className="paper-label">PAYMENT DUE</span>
          <h3>{day(i.due_at)}</h3>
          <p>USD{i.po_reference ? ` · PO ${i.po_reference}` : ""}</p>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th className="numeric">Quantity</th>
            <th className="numeric">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, n) => (
            <tr key={l.id ?? n}>
              <td>
                {l.description}
                {l.service_start && (
                  <small>
                    {day(l.service_start)}
                    {l.service_end ? ` – ${day(l.service_end)}` : ""}
                  </small>
                )}
              </td>
              <td className="numeric mono">
                {l.source_kind === "time" ? duration(l.quantity_seconds) : "1"}
              </td>
              <td className="numeric">{money(l.amount, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="paper-totals">
        <div>
          <span>Service subtotal</span>
          <span>{money(i.subtotal, true)}</span>
        </div>
        {i.discount > 0 && (
          <div>
            <span>Discount</span>
            <span>−{money(i.discount, true)}</span>
          </div>
        )}
        {i.tax > 0 && (
          <div>
            <span>Exclusive tax</span>
            <span>{money(i.tax, true)}</span>
          </div>
        )}
        <div className="paper-total">
          <strong>Total · USD</strong>
          <strong>{money(i.total, true)}</strong>
        </div>
        {i.paid_amount > 0 && (
          <div>
            <span>Paid</span>
            <span>{money(i.paid_amount, true)}</span>
          </div>
        )}
      </div>
      {i.memo && <p className="paper-memo preserve">{i.memo}</p>}
      <div className="paper-thanks">
        Thank you for the trust, and the good work.
        <span>Prepared with Running Tab</span>
      </div>
    </article>
  );
}
export function InvoicePage({ data, id }: { data: Snapshot; id: string }) {
  const q = useQuery({
    queryKey: ["invoice", id],
    queryFn: () =>
      api<{
        invoice: Invoice;
        lines: Line[];
        sources: any[];
        timeline: any[];
        profile: { card_suffix: string; consent: boolean } | null;
        payments: any[];
        operations: any[];
      }>(`/api/v1/invoices/${id}`),
    refetchInterval: 4000,
  });
  const [tab, setTab] = useState("preview"),
    [approve, setApprove] = useState(false),
    [editing, setEditing] = useState(false),
    [descriptions, setDescriptions] = useState<Record<string, string>>({}),
    [external, setExternal] = useState(false),
    [share, setShare] = useState<string | null>(null),
    [approvalKey] = useState(() => crypto.randomUUID());
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: ({
      path,
      body,
      method = "POST",
      key,
    }: {
      path: string;
      body?: unknown;
      method?: string;
      key?: string;
    }) =>
      api<any>(path, {
        method,
        data: body ?? {},
        key: key ?? crypto.randomUUID(),
      }),
    onSuccess: () => {
      cache.invalidateQueries();
      setApprove(false);
      setEditing(false);
      setExternal(false);
    },
  });
  const [action, setAction] = useState<"send" | "charge">("send");
  if (q.isPending)
    return (
      <div className="page-loading">Loading the invoice and its evidence…</div>
    );
  if (q.error || !q.data) return <ErrorMessage error={q.error} />;
  const { invoice: i, lines, sources, timeline, profile, operations } = q.data;
  const local = i.issuance_state === "local";
  const isPaid = i.collection_state === "paid";
  return (
    <>
      <PageHeader
        eyebrow={`${i.client_name} / INVOICE`}
        title={i.number}
        description={`Revision ${i.revision} · ${i.provider === "demo" ? "Isolated demo" : "Stripe sandbox"} · ${money(i.total, true)} USD`}
        actions={
          <>
            <Badge status={invoiceStatus(i)} />
            {local && (
              <Button kind="secondary" onClick={() => setEditing(true)}>
                Edit draft
              </Button>
            )}
            {!isPaid &&
              i.issuance_state !== "void" &&
              i.issuance_state !== "queued" && (
                <Button
                  onClick={() => {
                    setAction(local ? "send" : "charge");
                    setApprove(true);
                  }}
                >
                  Review & approve
                  <ArrowRight size={15} />
                </Button>
              )}
            {i.issuance_state === "issued" && (
              <Button
                kind="secondary"
                onClick={async () => {
                  const r = await m.mutateAsync({
                    path: `/api/v1/invoices/${id}/access`,
                  });
                  setShare(r.url);
                }}
              >
                <Link2 size={15} />
                Client link
              </Button>
            )}
          </>
        }
      />
      <ErrorMessage error={m.error} />
      {operations.some(
        (o) => o.state === "queued" || o.state === "processing",
      ) && (
        <div className="notice">
          <Clock3 size={18} />
          <p>
            Your approved operation is queued for the worker. Payment will only
            appear after confirmation.
          </p>
        </div>
      )}
      {operations.some((o) => o.state === "reconcile") && (
        <div className="notice warning">
          <AlertCircle size={18} />
          <p>
            The provider response is ambiguous. This operation must be
            reconciled; a new charge is blocked.
          </p>
        </div>
      )}
      <div className="invoice-layout">
        <div>
          <div className="tabs invoice-tabs">
            <button
              className={tab === "preview" ? "active" : ""}
              onClick={() => setTab("preview")}
            >
              Client preview
            </button>
            <button
              className={tab === "sources" ? "active" : ""}
              onClick={() => setTab("sources")}
            >
              Private source trail <span>{sources.length}</span>
            </button>
          </div>
          {tab === "preview" ? (
            <InvoicePaper invoice={i} lines={lines} />
          ) : (
            <section className="panel padded">
              <SectionHeading title="What this invoice is built on" />
              <p className="muted">
                This evidence is private. Clients see only the approved invoice
                descriptions.
              </p>
              {sources.map((s) => (
                <div className="source-evidence" key={s.id}>
                  <FileText size={17} />
                  <div>
                    <strong>{s.description ?? "Agreement source"}</strong>
                    <small className="mono">
                      {s.time_entry_id ??
                        s.milestone_id ??
                        s.bucket_id ??
                        s.period_id}
                    </small>
                    {s.actual_seconds && (
                      <p>
                        Actual: {hours(s.actual_seconds)} · Billed:{" "}
                        {hours(s.billed_seconds)} · Rate snapshot:{" "}
                        {money(s.rate)}/h
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
        <aside>
          <section className="panel padded">
            <SectionHeading title="The state of the tab" />
            <dl className="details-list">
              <div>
                <dt>Approval</dt>
                <dd>{i.approval_state}</dd>
              </div>
              <div>
                <dt>Issuance</dt>
                <dd>{i.issuance_state}</dd>
              </div>
              <div>
                <dt>Collection</dt>
                <dd>{i.collection_state.replace("_", " ")}</dd>
              </div>
              <div>
                <dt>Outstanding</dt>
                <dd>{money(Math.max(0, i.total - i.paid_amount), true)}</dd>
              </div>
            </dl>
            {isPaid && (
              <div className="paid-stamp">
                <Check size={22} />
                <strong>Payment confirmed</strong>
                <span>A receipt is available in the client view.</span>
              </div>
            )}
            {profile && (
              <p className="payment-method">
                <CreditCard size={15} />
                •••• {profile.card_suffix} ·{" "}
                {profile.consent ? "consent recorded" : "no charge consent"}
              </p>
            )}
            {data.mode === "demo" && !profile && (
              <Button
                kind="ghost"
                onClick={() =>
                  m.mutate({ path: `/api/v1/demo/consent/${i.client_id}` })
                }
              >
                Simulate client card consent
              </Button>
            )}
            {i.provider_url && (
              <Button kind="secondary" onClick={() => openUrl(i.provider_url!)}>
                Open Stripe invoice
                <ArrowUpRight size={14} />
              </Button>
            )}
            {i.provider_pdf && (
              <Button kind="ghost" onClick={() => openUrl(i.provider_pdf!)}>
                <ArrowDownToLine size={14} />
                Official invoice PDF
              </Button>
            )}
            {local && (
              <Button
                kind="ghost"
                onClick={() =>
                  m.mutate({ path: `/api/v1/invoices/${id}/review` })
                }
              >
                Mark ready for review
              </Button>
            )}
            {i.issuance_state === "issued" &&
              !isPaid &&
              i.provider === "demo" && (
                <Button kind="ghost" onClick={() => setExternal(true)}>
                  Record external payment
                </Button>
              )}
            {i.provider === "stripe_test" && (
              <Button
                kind="ghost"
                onClick={() =>
                  m.mutate({ path: `/api/v1/invoices/${id}/reconcile` })
                }
              >
                <RefreshCw size={14} />
                Reconcile provider
              </Button>
            )}
          </section>
          <section className="panel padded mt">
            <SectionHeading title="A clear paper trail" />
            <ol className="timeline">
              {timeline.map((t, n) => (
                <li key={n}>
                  <span className="timeline-dot" />
                  <div>
                    <strong>
                      {t.action.replaceAll(".", " ").replaceAll("_", " ")}
                    </strong>
                    <small>
                      {day(t.created_at)} ·{" "}
                      {new Date(t.created_at).toLocaleTimeString("en", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {local && (
            <button
              className="text-button danger-text mt"
              onClick={() => m.mutate({ path: `/api/v1/invoices/${id}/void` })}
            >
              Discard draft & release work
            </button>
          )}
        </aside>
      </div>
      {approve && (
        <Modal
          title="Close this tab with confidence"
          description="Your approval applies to this exact invoice revision and action."
          onClose={() => setApprove(false)}
        >
          <div className="approval-amount">
            <span>{i.client_name}</span>
            <strong>{money(i.total, true)}</strong>
            <small>
              USD · {i.number} · revision {i.revision}
            </small>
          </div>
          <label
            className={`approval-choice ${action === "send" ? "chosen" : ""}`}
          >
            <input
              type="radio"
              name="action"
              checked={action === "send"}
              disabled={!local}
              onChange={() => setAction("send")}
            />
            <Mail size={20} />
            <div>
              <strong>Issue for customer payment</strong>
              <span>
                The worker issues the invoice, emails its billing contact, and
                creates a private payment link.
              </span>
            </div>
          </label>
          <label
            className={`approval-choice ${action === "charge" ? "chosen" : ""}`}
          >
            <input
              type="radio"
              name="action"
              checked={action === "charge"}
              disabled={!profile?.consent}
              onChange={() => setAction("charge")}
            />
            <CreditCard size={20} />
            <div>
              <strong>Charge the authorized saved method</strong>
              <span>
                {profile?.consent
                  ? `Card ending ${profile.card_suffix}. Charge the exact approved amount.`
                  : "Requires a saved method and explicit client consent."}
              </span>
            </div>
          </label>
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              {data.mode === "demo"
                ? "This is a simulated financial action. No real card will be charged."
                : "Stripe test mode only. Live payment execution is disabled."}
            </p>
          </div>
          <ErrorMessage error={m.error} />
          <footer className="form-footer">
            <Button kind="secondary" onClick={() => setApprove(false)}>
              Keep reviewing
            </Button>
            <Button
              busy={m.isPending}
              disabled={action === "charge" && !profile?.consent}
              onClick={() =>
                m.mutate({
                  path: `/api/v1/invoices/${id}/approve`,
                  body: {
                    revision: i.revision,
                    action,
                    confirmedTotal: i.total,
                  },
                  key: approvalKey,
                })
              }
            >
              {action === "send"
                ? "Approve & issue invoice"
                : `Approve & charge ${money(i.total, true)}`}
            </Button>
          </footer>
        </Modal>
      )}
      {editing && (
        <Modal
          wide
          title="Refine the draft"
          description="Any edit creates a new revision and invalidates previous approval."
          onClose={() => setEditing(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              m.mutate({
                path: `/api/v1/invoices/${id}`,
                method: "PATCH",
                body: {
                  revision: i.revision,
                  memo: f.get("memo"),
                  dueAt: new Date(`${f.get("due")}T12:00:00Z`).toISOString(),
                  poReference: f.get("po"),
                  discount: parseMoney(String(f.get("discount"))),
                  taxBps: parseMoney(String(f.get("tax"))),
                  lines: lines.map((l) => ({
                    id: l.id,
                    description: f.get(l.id),
                  })),
                },
              });
            }}
          >
            <DescriptionAssistant
              sources={sources}
              lines={lines}
              enabled={data.workspace.ai_enabled}
              onUse={(id, text) =>
                setDescriptions((v) => ({ ...v, [id]: text }))
              }
            />
            {lines.map((l) => (
              <Field
                label={`Description · ${money(l.amount, true)}`}
                key={l.id}
              >
                <textarea
                  name={l.id}
                  value={descriptions[l.id] ?? l.description}
                  onChange={(e) =>
                    setDescriptions((v) => ({ ...v, [l.id]: e.target.value }))
                  }
                  rows={3}
                  required
                />
              </Field>
            ))}
            <div className="form-grid">
              <Field label="Discount · USD">
                <input
                  name="discount"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={i.discount / 100}
                />
              </Field>
              <Field
                label="Exclusive tax · %"
                hint="Your manual setting; not tax advice."
              >
                <input
                  name="tax"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  defaultValue={i.tax_bps / 100}
                />
              </Field>
            </div>
            <Field label="Payment due date">
              <input
                name="due"
                type="date"
                required
                defaultValue={i.due_at.slice(0, 10)}
              />
            </Field>
            <Field label="Purchase order">
              <input name="po" defaultValue={i.po_reference} />
            </Field>
            <Field label="Client memo">
              <textarea name="memo" defaultValue={i.memo} rows={2} />
            </Field>
            <ErrorMessage error={m.error} />
            <footer className="form-footer">
              <Button
                kind="secondary"
                type="button"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button busy={m.isPending}>Save new revision</Button>
            </footer>
          </form>
        </Modal>
      )}
      {external && (
        <Modal
          title="Record a full external payment"
          description="Use this only when the full amount has already been received outside the app. No new charge is created."
          onClose={() => setExternal(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate({
                path: `/api/v1/invoices/${id}/external-payment`,
                body: {
                  reference: new FormData(e.currentTarget).get("reference"),
                },
              });
            }}
          >
            <div className="approval-amount">
              <strong>{money(i.total, true)}</strong>
              <span>{i.client_name}</span>
            </div>
            <Field label="Payment reference">
              <input
                name="reference"
                required
                minLength={3}
                placeholder="Bank transfer reference"
              />
            </Field>
            <ErrorMessage error={m.error} />
            <footer className="form-footer">
              <Button busy={m.isPending}>
                Confirm payment already received
              </Button>
            </footer>
          </form>
        </Modal>
      )}
      {share && (
        <Modal
          title="A focused client view"
          description="This link expires in seven days and replaces previous links for this invoice. It contains no private time notes or profitability data."
          onClose={() => setShare(null)}
        >
          <Field label="Private invoice link">
            <input readOnly value={share} onFocus={(e) => e.target.select()} />
          </Field>
          <footer className="form-footer">
            <Button
              kind="secondary"
              onClick={() => navigator.clipboard.writeText(share)}
            >
              Copy link
            </Button>
            <Button onClick={() => openUrl(share)}>
              Open client view
              <ArrowUpRight size={14} />
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
export function PortalPage({ token }: { token: string }) {
  const [consent, setConsent] = useState(false);
  const setup = useMutation({
    mutationFn: async (revoke: boolean) => {
      const r = await post(
        `/api/portal/${token}/${revoke ? "revoke-consent" : "setup"}`,
        { accepted: consent },
      );
      if (r.url) await openUrl(r.url);
      return r;
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: ["portal", token] }),
  });
  const q = useQuery({
    queryKey: ["portal", token],
    queryFn: () => api<any>(`/api/portal/${token}`),
    refetchInterval: 5000,
  });
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: (outcome: string) =>
      post(`/api/portal/${token}/demo-pay`, { outcome }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["portal", token] }),
  });
  if (q.isPending)
    return <div className="portal-shell">Loading your invoice…</div>;
  if (q.error)
    return (
      <div className="portal-shell">
        <h1>This invoice link is unavailable.</h1>
        <p>
          It may have expired or been revoked. Ask the sender for a new link.
        </p>
      </div>
    );
  const { invoice: i, lines, payments, savedMethod } = q.data;
  return (
    <main className="portal-shell">
      <div className="portal-header">
        <span className="brand-word">
          running tab<span className="brand-period">.</span>
        </span>
        <span>PRIVATE CLIENT INVOICE</span>
      </div>
      <div className="portal-payment">
        <div>
          <span>
            {i.collection_state === "paid" ? "PAYMENT CONFIRMED" : "AMOUNT DUE"}
          </span>
          <h1>{money(Math.max(0, i.total - i.paid_amount), true)}</h1>
          <p>
            {i.client_snapshot.name} · {i.number}
          </p>
        </div>
        {i.collection_state === "paid" ? (
          <div className="portal-paid">
            <Check size={28} />
            <strong>All paid. Thank you.</strong>
          </div>
        ) : i.provider === "demo" ? (
          <div>
            <Button busy={m.isPending} onClick={() => m.mutate("success")}>
              <CreditCard size={17} />
              Pay {money(i.total, true)} · demo
            </Button>
            <p className="fine-print">
              Demo only. No card details or real payment.
            </p>
            <button className="text-button" onClick={() => m.mutate("decline")}>
              Simulate a declined payment
            </button>
          </div>
        ) : (
          <Button onClick={() => openUrl(i.provider_url)}>
            Pay securely with Stripe
            <ArrowUpRight size={15} />
          </Button>
        )}
      </div>
      <ErrorMessage error={m.error} />
      {i.collection_state === "failed" && (
        <div className="notice warning">
          Payment wasn’t completed. You can try again using the payment button.
        </div>
      )}
      <InvoicePaper invoice={i} lines={lines} />
      {payments.length > 0 && (
        <section className="portal-receipts">
          <h2>Payment receipts</h2>
          {payments.map((p: any) => (
            <div key={p.id}>
              <div>
                <strong>{money(p.amount, true)} received</strong>
                <p>
                  {day(p.received_at)} ·{" "}
                  {p.provider === "demo" ? "Simulated payment" : p.provider}
                </p>
                <small>Receipt {p.id.slice(0, 8).toUpperCase()}</small>
              </div>
              <Button kind="secondary" onClick={() => window.print()}>
                <ArrowDownToLine size={15} />
                Print / save PDF
              </Button>
            </div>
          ))}
        </section>
      )}
      {i.provider === "stripe_test" && (
        <section className="portal-receipts">
          <h2>Payment authorization</h2>
          {savedMethod?.authorized ? (
            <>
              <p>
                Card ending {savedMethod.card_suffix}. Authorized for the exact
                USD total of each invoice explicitly approved by your service
                provider.
              </p>
              <Button
                kind="secondary"
                busy={setup.isPending}
                onClick={() => setup.mutate(true)}
              >
                Revoke future charges
              </Button>
            </>
          ) : (
            <>
              <p>
                Optionally authorize this business to charge a saved card for
                each explicitly approved invoice, for its exact USD total. You
                can revoke future authorization here at any time. Terms:
                saved-method-v1.
              </p>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                I authorize these future off-session charges.
              </label>
              <Button
                disabled={!consent}
                busy={setup.isPending}
                onClick={() => setup.mutate(false)}
              >
                Save a card securely with Stripe
              </Button>
            </>
          )}
          <ErrorMessage error={setup.error} />
        </section>
      )}
      <footer className="portal-footer">
        Your invoice and payment details. Nothing more.
        <button className="text-button" onClick={() => window.print()}>
          Print invoice
        </button>
      </footer>
    </main>
  );
}
