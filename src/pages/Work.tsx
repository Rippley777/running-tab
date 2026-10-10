import { DevelopmentSummary } from "./Development";
import { BillingChangeForm } from "../components/billing-changes";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Plus,
  Clock3,
  Check,
  GitBranch,
  ArrowDownToLine,
  Copy,
  ChevronRight,
  Search,
  Folder,
  Archive,
  Split,
  AlertCircle,
} from "lucide-react";
import type { Snapshot, Entry, Project } from "../../shared/contracts";
import { api, post, navigate, exportCsv } from "../lib/api";
import {
  money,
  hours,
  day,
  time,
  modelLabel,
  invoiceStatus,
  fullDay,
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
} from "../components/ui";
import {
  ClientForm,
  ProjectForm,
  TimeForm,
  EditEntryForm,
  AgreementForm,
} from "../components/forms";
import { TimerCard } from "../components/timer";
export function Metric({
  label,
  value,
  sub,
  accent = false,
  onClick,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
  onClick?: () => void;
}) {
  return (
    <button className={`metric ${accent ? "accent" : ""}`} onClick={onClick}>
      <span>
        {label}
        <ArrowUpRight size={13} />
      </span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </button>
  );
}
export function WeekChart({ data }: { data: Snapshot }) {
  const daily = data.metrics.daily;
  const max = Math.max(
    ...daily.map((d) => d.billable + d.nonbillable),
    8 * 3600,
  );
  const start = new Date(`${data.metrics.from}T12:00:00`);
  const days = Array.from(
    {
      length: Math.max(
        1,
        Math.round(
          (+new Date(data.metrics.to) - +new Date(data.metrics.from)) /
            86400000,
        ),
      ),
    },
    (_, i) => {
      const date = new Date(start);
      date.setDate(date.getDate() + i);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return { date, key, item: daily.find((d) => d.date === key) };
    },
  );
  return (
    <div
      className="week-chart"
      aria-label="Time by day, billable and non-billable"
    >
      <div className="chart-axis">
        <span>{hours(max)}</span>
        <span>{hours(max / 2)}</span>
        <span>0h</span>
      </div>
      <div className="chart-bars">
        {days.map(({ date, key, item }) => (
          <div
            key={key}
            className={`chart-day ${key === new Date().toLocaleDateString("en-CA") ? "today" : ""}`}
          >
            <div
              className="bar-track"
              title={`${date.toLocaleDateString()}: ${hours((item?.billable ?? 0) + (item?.nonbillable ?? 0))}`}
            >
              <div
                className="bar nonbillable"
                style={{ height: `${((item?.nonbillable ?? 0) / max) * 100}%` }}
              />
              <div
                className="bar billable"
                style={{ height: `${((item?.billable ?? 0) / max) * 100}%` }}
              />
            </div>
            <span>
              {days.length > 7
                ? date.getDate() % 5 === 0
                  ? date.getDate()
                  : "·"
                : date
                    .toLocaleDateString("en", { weekday: "short" })
                    .slice(0, 1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
export function EntryList({
  entries,
  data,
  onEdit,
  onDuplicate,
  compact = false,
}: {
  entries: Entry[];
  data: Snapshot;
  onEdit?: (e: Entry) => void;
  onDuplicate?: (e: Entry) => void;
  compact?: boolean;
}) {
  if (!entries.length)
    return (
      <Empty
        title="A clean slate"
        detail="Start a timer or add your first bit of work."
      />
    );
  return (
    <div className={`entry-list ${compact ? "compact" : ""}`}>
      {entries.map((e) => (
        <div className="entry-row" key={e.id}>
          <span className="project-dot" style={{ background: e.color }} />
          <div className="entry-content">
            <button
              className="entry-title"
              onClick={() => onEdit?.(e)}
              disabled={Boolean(e.invoice_id) || !onEdit}
            >
              {e.description || (
                <span className="missing">Add a work description</span>
              )}
            </button>
            <div className="entry-meta">
              <Link to={`/projects/${e.project_id}`}>{e.project_name}</Link>
              <span>·</span>
              <span>{e.client_name}</span>
              {!compact && (
                <>
                  <span>·</span>
                  <span>
                    {time(e.started_at, data.workspace.timezone)} –{" "}
                    {time(e.ended_at, data.workspace.timezone)}
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="entry-status">
            {e.overlap && (
              <span title="Overlapping time" className="warning-text">
                <AlertCircle size={14} />
              </span>
            )}
            {e.invoice_id ? (
              <Badge status="issued">Allocated</Badge>
            ) : !e.reviewed ? (
              <Badge status="review">Review</Badge>
            ) : (
              <span className="muted small">
                {e.treatment === "hourly"
                  ? "Billable"
                  : (modelLabel[e.treatment] ?? e.treatment.replace("_", " "))}
              </span>
            )}
          </div>
          <strong className="mono entry-duration">
            {hours(e.actual_seconds)}
          </strong>
          {onDuplicate && (
            <button
              className="icon-button row-action"
              aria-label="Duplicate work context"
              onClick={() => onDuplicate(e)}
            >
              <Copy size={14} />
            </button>
          )}
          {onEdit && !e.invoice_id && (
            <button
              className="icon-button row-action"
              aria-label="Edit entry"
              onClick={() => onEdit(e)}
            >
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
export function Today({ data }: { data: Snapshot }) {
  const [form, setForm] = useState<null | "time">(null);
  const [edit, setEdit] = useState<Entry | null>(null);
  const latest = data.entries.slice(0, 4);
  const m = data.metrics;
  const cache = useQueryClient();
  const snooze = useMutation({
    mutationFn: (id: string) => post(`/api/v1/notifications/${id}/snooze`),
    onSuccess: () => cache.invalidateQueries(),
  });
  return (
    <>
      <PageHeader
        eyebrow={fullDay(data.serverTime, data.workspace.timezone)}
        title={`Good ${new Date().getHours() < 12 ? "morning" : "afternoon"}, ${data.user.name.trim().split(" ")[0] || "there"}.`}
        description="Your work has value. Keep a good account of it."
        actions={
          <>
            <Button kind="secondary" onClick={() => setForm("time")}>
              <Plus size={15} />
              Add time
            </Button>
            <Button onClick={() => navigate("/close")}>
              Friday Close
              <ArrowUpRight size={15} />
            </Button>
          </>
        }
      />
      <div className="metrics-strip">
        <Metric
          label="TIME TRACKED"
          value={hours(m.actual_seconds)}
          sub={`${hours(m.billable_seconds)} billable · this period`}
          onClick={() => navigate("/time")}
        />
        <Metric
          label="READY TO BILL"
          value={money(m.eligible_value)}
          sub="Unallocated hourly work · this period"
          accent
          onClick={() => navigate("/billing")}
        />
        <Metric
          label="AWAITING PAYMENT"
          value={money(m.outstanding)}
          sub="All issued outstanding invoices"
          onClick={() => navigate("/billing")}
        />
        <Metric
          label="CASH COLLECTED"
          value={money(m.cash)}
          sub="Confirmed payments · this period"
          onClick={() => navigate("/reports")}
        />
      </div>
      <div className="dashboard-grid">
        <div className="dashboard-main">
          {!data.clients.length && (
            <div className="notice">
              <div>
                <strong>
                  Your next good working relationship starts here.
                </strong>
                <p>Create a client, add a project, and your timer is ready.</p>
              </div>
              <Button onClick={() => navigate("/clients")}>
                Create your first client
              </Button>
            </div>
          )}
          <TimerCard data={data} />
          <DevelopmentSummary data={data} />
          <section className="panel recent-work">
            <SectionHeading
              title="Your recent work"
              aside={`${data.entries.length} entries`}
              action="View all time"
              onAction={() => navigate("/time")}
            />
            <EntryList entries={latest} data={data} compact onEdit={setEdit} />
            <button className="add-row" onClick={() => setForm("time")}>
              <Plus size={15} />
              Add work you didn’t track
            </button>
          </section>
        </div>
        <aside className="dashboard-aside">
          <section className="attention-panel">
            <SectionHeading
              title="A little attention"
              aside={String(data.notifications.length)}
            />
            {data.notifications.length ? (
              data.notifications.slice(0, 3).map((n) => (
                <div className="attention-item" key={n.id}>
                  <span className="attention-symbol">
                    {n.kind === "warning" ? (
                      <AlertCircle size={17} />
                    ) : (
                      <Clock3 size={17} />
                    )}
                  </span>
                  <div>
                    <button onClick={() => navigate(`/${n.target}`)}>
                      {n.title}
                      <ArrowUpRight size={13} />
                    </button>
                    <p>{n.detail}</p>
                    <button
                      className="snooze"
                      onClick={() => snooze.mutate(n.id)}
                    >
                      Later, please
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <p className="muted">
                Nothing needs your attention. A good place to be.
              </p>
            )}
          </section>
          <section className="panel week-panel">
            <SectionHeading title="Time across this period" />
            <div className="week-summary">
              <strong>{hours(m.actual_seconds)}</strong>
              <span>
                {m.utilization === null
                  ? "No time yet"
                  : `${Math.round(m.utilization * 100)}% billable`}
              </span>
            </div>
            <WeekChart data={data} />
            <div className="chart-legend">
              <span>
                <i />
                Billable
              </span>
              <span>
                <i />
                Non-billable
              </span>
            </div>
          </section>
        </aside>
      </div>
      <section className="panel projects-section">
        <SectionHeading
          title="Projects in motion"
          action="All projects"
          onAction={() => navigate("/projects")}
        />
        <ProjectTable
          projects={data.projects
            .filter((p) => p.status === "active")
            .slice(0, 4)}
        />
      </section>
      <div className="quiet-footer">
        <span className="tiny-mark">rt</span> A good day’s work deserves a clear
        record.<span>All amounts in USD</span>
      </div>
      {form && <TimeForm data={data} onClose={() => setForm(null)} />}{" "}
      {edit && <EditEntryForm entry={edit} onClose={() => setEdit(null)} />}
    </>
  );
}
export function ProjectTable({ projects }: { projects: Project[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Project / client</th>
            <th>Agreement</th>
            <th className="numeric">Time invested</th>
            <th className="numeric">Collected service / hour</th>
            <th className="numeric">Unbilled hourly</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
              <td>
                <div className="project-cell">
                  <span
                    className="project-square"
                    style={{ color: p.color, background: `${p.color}18` }}
                  >
                    <Folder size={17} />
                  </span>
                  <div>
                    <Link to={`/projects/${p.id}`}>{p.name}</Link>
                    <small>{p.client_name}</small>
                  </div>
                </div>
              </td>
              <td>
                <span className="model-tag">{modelLabel[p.model]}</span>
              </td>
              <td className="numeric mono">{hours(p.actual_seconds)}</td>
              <td className="numeric">
                {p.realized_rate === null ? "—" : money(p.realized_rate)}
                <small>
                  {p.target_rate
                    ? `${money(p.target_rate)} target`
                    : "Target not set"}
                </small>
              </td>
              <td className="numeric">
                {p.eligible_value ? money(p.eligible_value) : "—"}
              </td>
              <td>
                <ChevronRight size={15} className="muted" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function TimePage({ data }: { data: Snapshot }) {
  const [manual, setManual] = useState<boolean | Entry>(false),
    [edit, setEdit] = useState<Entry | null>(null),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [correct, setCorrect] = useState(false),
    [split, setSplit] = useState<Entry | null>(null);
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
    onSuccess: () => {
      cache.invalidateQueries();
      setCorrect(false);
      setSplit(null);
    },
  });
  const filtered = data.entries.filter(
    (e) =>
      (filter === "all" ||
        (filter === "review" && (!e.reviewed || !e.description || e.overlap)) ||
        (filter === "unbilled" && !e.invoice_id && e.treatment === "hourly") ||
        (filter === "nonbillable" && !e.billable)) &&
      `${e.description} ${e.project_name} ${e.client_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const groups = new Map<string, Entry[]>();
  for (const e of filtered) {
    const k = fullDay(e.started_at, data.workspace.timezone);
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return (
    <>
      <PageHeader
        eyebrow="THE WORK, ACCOUNTED FOR"
        title="Time well recorded."
        description="A clear record of where your attention went."
        actions={
          <>
            <Button kind="secondary" onClick={() => exportCsv("time")}>
              <ArrowDownToLine size={15} />
              Export
            </Button>
            <Button onClick={() => setManual(true)}>
              <Plus size={15} />
              Add time
            </Button>
          </>
        }
      />
      {data.timer && (
        <div className="notice warning">
          <Clock3 size={18} />
          <div>
            <strong>{data.timer.project_name} has an active timer</strong>
            <p>
              It keeps running through sleep and app closure. Review it if the
              duration looks unexpected.
            </p>
          </div>
          <Button kind="secondary" onClick={() => setCorrect(true)}>
            Correct end time
          </Button>
        </div>
      )}
      <div className="toolbar">
        <div className="tabs">
          {[
            ["all", "All work"],
            ["review", "Needs review"],
            ["unbilled", "Unbilled hourly"],
            ["nonbillable", "Non-billable"],
          ].map(([k, l]) => (
            <button
              className={filter === k ? "active" : ""}
              key={k}
              onClick={() => setFilter(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search time"
            placeholder="Find some work…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <ErrorMessage error={m.error} />
      {filtered.length ? (
        [...groups].map(([date, items]) => (
          <section className="panel time-day" key={date}>
            <SectionHeading
              title={date}
              aside={hours(items.reduce((s, e) => s + e.actual_seconds, 0))}
            />
            <EntryList
              entries={items}
              data={data}
              onEdit={setEdit}
              onDuplicate={setManual}
            />
            <div className="day-actions">
              {items
                .filter(
                  (e) => !e.invoice_id && e.reviewed && e.covered_seconds === 0,
                )
                .slice(0, 1)
                .map((e) => (
                  <button
                    key={e.id}
                    className="text-button"
                    onClick={() => setSplit(e)}
                  >
                    <Split size={13} />
                    Split an entry
                  </button>
                ))}
            </div>
          </section>
        ))
      ) : (
        <Empty
          title="Nothing in this view"
          detail="Your next bit of work will find a home here."
          action={<Button onClick={() => setManual(true)}>Add time</Button>}
        />
      )}
      <p className="fine-print">
        Dates shown in {data.workspace.timezone}. Actual seconds are preserved.{" "}
        {data.workspace.rounding_minutes
          ? `Billing rounds each entry up to ${data.workspace.rounding_minutes} minutes.`
          : "No billing-time rounding."}{" "}
        Entries allocated to invoices are locked.
      </p>
      {manual && (
        <TimeForm
          data={data}
          context={typeof manual === "object" ? manual : undefined}
          onClose={() => setManual(false)}
        />
      )}{" "}
      {edit && <EditEntryForm entry={edit} onClose={() => setEdit(null)} />}{" "}
      {correct && data.timer && (
        <Modal
          title="Set the actual end time"
          description="No time is silently deducted. This records your explicit correction."
          onClose={() => setCorrect(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              m.mutate({
                path: `/api/v1/timer/${data.timer!.id}/correct`,
                body: {
                  endedAt: new Date(String(f.get("end"))).toISOString(),
                  version: data.timer!.version,
                },
              });
            }}
          >
            <Field label="Work finished at">
              <input name="end" type="datetime-local" required />
            </Field>
            <ErrorMessage error={m.error} />
            <footer className="form-footer">
              <Button busy={m.isPending}>Correct & stop timer</Button>
            </footer>
          </form>
        </Modal>
      )}
      {split && (
        <Modal
          title="Split this entry"
          description={split.description}
          onClose={() => setSplit(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              m.mutate({
                path: `/api/v1/entries/${split.id}`,
                method: "PATCH",
                body: {
                  version: split.version,
                  splitSeconds:
                    Number(new FormData(e.currentTarget).get("minutes")) * 60,
                },
              });
            }}
          >
            <Field label="Minutes in the first part">
              <input
                name="minutes"
                type="number"
                min="1"
                max={Math.floor(split.actual_seconds / 60) - 1}
                required
              />
            </Field>
            <ErrorMessage error={m.error} />
            <footer className="form-footer">
              <Button busy={m.isPending}>Split entry</Button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}
export function ClientsPage({
  data,
  clientId,
}: {
  data: Snapshot;
  clientId?: string;
}) {
  const [create, setCreate] = useState(false),
    [editClient, setEditClient] = useState(false),
    [project, setProject] = useState(false),
    [search, setSearch] = useState("");
  const c = data.clients.find((c) => c.id === clientId);
  const cache = useQueryClient();
  const archive = useMutation({
    mutationFn: () => post(`/api/v1/clients/${c?.id}/archive`),
    onSuccess: () => cache.invalidateQueries(),
  });
  if (clientId && !c)
    return (
      <Empty
        title="Client not found"
        detail="This client isn’t in your workspace."
      />
    );
  return (
    <>
      <PageHeader
        eyebrow={c ? "CLIENT WORKSPACE" : "GOOD PEOPLE. GOOD WORK."}
        title={c ? c.name : "Your clients."}
        description={
          c ? c.email : "A small roster. A clear picture of every relationship."
        }
        actions={
          c ? (
            <>
              <Button kind="secondary" onClick={() => setEditClient(true)}>
                Edit client
              </Button>
              <Button
                disabled={Boolean(c.archived_at)}
                onClick={() => setProject(true)}
              >
                <Plus size={15} />
                New project
              </Button>
            </>
          ) : (
            <Button onClick={() => setCreate(true)}>
              <Plus size={15} />
              New client
            </Button>
          )
        }
      />
      {c ? (
        <>
          <div className="client-summary">
            <div>
              <span className="eyebrow">BILLING CONTACT</span>
              <p>{c.email}</p>
              <p className="muted preserve">{c.address}</p>
            </div>
            <Metric
              label="AWAITING PAYMENT"
              value={money(c.outstanding)}
              sub="Issued outstanding balance"
            />
            <Metric
              label="PROJECTS"
              value={String(c.project_count)}
              sub="History is preserved when archived"
            />
          </div>
          <section className="panel">
            <SectionHeading title="Projects" />
            <ProjectTable
              projects={data.projects.filter((p) => p.client_id === c.id)}
            />
          </section>
          <section className="panel mt">
            <SectionHeading title="Invoice history" />
            {data.invoices
              .filter((i) => i.client_id === c.id)
              .map((i) => (
                <Link to={`/invoice/${i.id}`} className="simple-row" key={i.id}>
                  <strong>{i.number}</strong>
                  <span>{day(i.created_at)}</span>
                  <Badge status={invoiceStatus(i)} />
                  <b>{money(i.total)}</b>
                  <ChevronRight size={16} />
                </Link>
              ))}
          </section>
          <div className="archive-note">
            <p>
              Archiving pauses schedules and prevents new work. Outstanding
              invoices and history remain available. Active timers must be
              stopped first.
            </p>
            <Button
              kind="ghost"
              disabled={Boolean(c.archived_at)}
              onClick={() => archive.mutate()}
            >
              <Archive size={15} />
              {c.archived_at ? "Archived" : "Archive client"}
            </Button>
          </div>
          <ErrorMessage error={archive.error} />
        </>
      ) : (
        <>
          <div className="toolbar">
            <span className="muted">
              {data.clients.length} client relationships
            </span>
            <label className="search">
              <Search size={15} />
              <input
                aria-label="Search clients"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find a client…"
              />
            </label>
          </div>
          <div className="client-grid">
            {data.clients
              .filter((c) =>
                c.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c) => (
                <Link
                  to={`/clients/${c.id}`}
                  className="client-card"
                  key={c.id}
                >
                  <div className="client-card-top">
                    <span
                      className="client-avatar"
                      style={{ color: c.color, background: `${c.color}18` }}
                    >
                      {c.name.slice(0, 1)}
                    </span>
                    <ArrowUpRight size={18} />
                  </div>
                  <h2>{c.name}</h2>
                  <p>{c.email}</p>
                  <div className="client-card-bottom">
                    <span>
                      {c.project_count} projects
                      {c.archived_at ? " · archived" : ""}
                    </span>
                    <div>
                      <strong>{money(c.outstanding)}</strong>
                      <small>outstanding</small>
                    </div>
                  </div>
                </Link>
              ))}
            <button
              className="client-card new-client"
              onClick={() => setCreate(true)}
            >
              <Plus size={24} />
              <h3>Your next good client</h3>
              <p>Make room for a new relationship.</p>
            </button>
          </div>
        </>
      )}
      {create && <ClientForm onClose={() => setCreate(false)} />}{" "}
      {editClient && c && (
        <ClientForm client={c} onClose={() => setEditClient(false)} />
      )}
      {project && (
        <ProjectForm
          data={data}
          clientId={c?.id}
          onClose={() => setProject(false)}
        />
      )}
    </>
  );
}
export function ProjectsPage({
  data,
  projectId,
}: {
  data: Snapshot;
  projectId?: string;
}) {
  const [create, setCreate] = useState(false),
    [agreement, setAgreement] = useState(false),
    [milestone, setMilestone] = useState<any>(null),
    [manual, setManual] = useState(false),
    [filter, setFilter] = useState("active"),
    [task, setTask] = useState("");
  const p = data.projects.find((p) => p.id === projectId);
  const q = useQueryClient();
  const m = useMutation({
    mutationFn: ({
      path,
      data,
      method = "POST",
    }: {
      path: string;
      data: unknown;
      method?: string;
    }) => api(path, { method, data, key: crypto.randomUUID() }),
    onSuccess: () => {
      q.invalidateQueries();
      setTask("");
    },
  });
  if (projectId && !p)
    return (
      <Empty
        title="Project not found"
        detail="This project isn’t in your workspace."
      />
    );
  return (
    <>
      <PageHeader
        eyebrow={
          p ? `${p.client_name} / ${modelLabel[p.model]}` : "THE BIGGER PICTURE"
        }
        title={p ? p.name : "Projects with purpose."}
        description={
          p
            ? p.description
            : "Keep the work, the agreement, and the outcome in one place."
        }
        actions={
          p ? (
            <>
              <Button kind="secondary" onClick={() => setManual(true)}>
                <Plus size={15} />
                Add time
              </Button>
              {["support", "prepaid"].includes(p.model) && (
                <Button onClick={() => setAgreement(true)}>
                  {p.model === "prepaid" ? "New hours bucket" : "New schedule"}
                </Button>
              )}
            </>
          ) : (
            <Button
              disabled={!data.clients.length}
              onClick={() => setCreate(true)}
            >
              <Plus size={15} />
              New project
            </Button>
          )
        }
      />
      {p ? (
        <>
          <div className="metrics-strip">
            <Metric
              label="TIME INVESTED"
              value={hours(p.actual_seconds)}
              sub={`${hours(p.billable_seconds)} billable · all time`}
            />
            <Metric
              label="COLLECTED SERVICE / HOUR"
              value={p.realized_rate === null ? "—" : money(p.realized_rate)}
              sub="Collected service allocated / all effort"
            />
            <Metric
              label="CASH COLLECTED"
              value={money(p.cash)}
              sub="Invoice-attributed cash · all time"
            />
            <Metric
              label="ESTIMATED CONTRIBUTION"
              value={p.contribution === null ? "—" : money(p.contribution)}
              sub={
                p.cost_rate == null
                  ? "Cost rate needed"
                  : `${money(p.cost_rate)}/h labor assumption · all time`
              }
            />
          </div>
          {p.model === "fixed" && p.underquote > 0 && (
            <div className="notice warning">
              <AlertCircle size={19} />
              <div>
                <strong>Your target deserves a closer look.</strong>
                <p>
                  This {money(p.fee)} project took {hours(p.actual_seconds)}.{" "}
                  {money(p.underquote)} below the fee implied by your{" "}
                  {money(p.target_rate ?? 0)}/hour target.
                </p>
              </div>
            </div>
          )}
          <ErrorMessage error={m.error} />
          <div className="detail-grid">
            <section className="panel">
              <SectionHeading title="Work history" aside="All time" />
              <EntryList
                entries={data.entries
                  .filter((e) => e.project_id === p.id)
                  .slice(0, 15)}
                data={data}
                compact
              />
            </section>
            <div>
              <section className="panel padded">
                <SectionHeading title="A few things to do" />
                {data.tasks
                  .filter((t) => t.project_id === p.id)
                  .map((t) => (
                    <label className="task-row" key={t.id}>
                      <input
                        type="checkbox"
                        checked={Boolean(t.completed_at)}
                        onChange={(e) =>
                          m.mutate({
                            path: `/api/v1/tasks/${t.id}`,
                            method: "PATCH",
                            data: { completed: e.target.checked },
                          })
                        }
                      />
                      <span className={t.completed_at ? "completed" : ""}>
                        {t.title}
                      </span>
                    </label>
                  ))}
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    m.mutate({
                      path: "/api/v1/tasks",
                      data: { projectId: p.id, title: task },
                    });
                  }}
                >
                  <input
                    aria-label="New task"
                    placeholder="Add a lightweight task…"
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    required
                  />
                  <button aria-label="Create task" className="icon-button">
                    <Plus size={16} />
                  </button>
                </form>
              </section>
              <section className="panel padded mt">
                <SectionHeading title="The agreement" />
                <dl className="details-list">
                  <div>
                    <dt>Model</dt>
                    <dd>{modelLabel[p.model]}</dd>
                  </div>
                  <div>
                    <dt>Rate / fee</dt>
                    <dd>
                      {money(
                        p.model === "hourly" || p.model === "prepaid"
                          ? (p.rate ?? data.workspace.default_rate)
                          : p.fee,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Estimated effort</dt>
                    <dd>
                      {p.estimate_seconds
                        ? hours(p.estimate_seconds)
                        : "Not set"}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{p.status}</dd>
                  </div>
                </dl>
                {data.milestones
                  .filter((x) => x.project_id === p.id)
                  .map((x) => (
                    <div key={x.id}>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          disabled={Boolean(x.invoice_id)}
                          checked={x.ready}
                          onChange={(e) =>
                            m.mutate({
                              path: `/api/v1/milestones/${x.id}`,
                              method: "PATCH",
                              data: { ready: e.target.checked },
                            })
                          }
                        />
                        {x.title} · {money(x.amount, true)}
                      </label>
                      {!x.invoice_id && (
                        <button
                          className="text-button"
                          onClick={() => setMilestone(x)}
                        >
                          Divide into milestones
                        </button>
                      )}
                    </div>
                  ))}
                {data.repositories
                  .filter((r) => r.project_id === p.id)
                  .map((r) => (
                    <p key={r.id} className="repo-line">
                      <GitBranch size={14} />
                      {r.identity}
                    </p>
                  ))}
              </section>
            </div>
          </div>
          <div className="archive-note">
            <p>
              Completing or archiving a project pauses its schedules. History
              and outstanding balances are preserved.
            </p>
            <Button
              kind="ghost"
              onClick={() =>
                m.mutate({
                  path: `/api/v1/projects/${p.id}`,
                  method: "PATCH",
                  data: {
                    status: p.status === "active" ? "completed" : "active",
                  },
                })
              }
            >
              <Check size={15} />
              {p.status === "active" ? "Mark completed" : "Reopen project"}
            </Button>
            <Button
              kind="ghost"
              onClick={() =>
                m.mutate({
                  path: `/api/v1/projects/${p.id}`,
                  method: "PATCH",
                  data: { status: "archived" },
                })
              }
            >
              <Archive size={15} />
              Archive
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="toolbar">
            <div className="tabs">
              {["active", "completed", "archived", "all"].map((s) => (
                <button
                  key={s}
                  className={filter === s ? "active" : ""}
                  onClick={() => setFilter(s)}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <span className="muted small">
              Profitability includes all project effort
            </span>
          </div>
          <section className="panel">
            <ProjectTable
              projects={data.projects.filter(
                (p) => filter === "all" || p.status === filter,
              )}
            />
            {!data.projects.length && (
              <Empty
                title="Your next project starts here"
                detail="Create a client, then choose how you’ll bill your work."
                action={
                  <Button onClick={() => navigate("/clients")}>
                    Create a client
                    <ArrowRight size={15} />
                  </Button>
                }
              />
            )}
          </section>
        </>
      )}
      {create && <ProjectForm data={data} onClose={() => setCreate(false)} />}{" "}
      {milestone && (
        <BillingChangeForm
          kind="milestone"
          record={milestone}
          onClose={() => setMilestone(null)}
        />
      )}
      {p && agreement && (
        <AgreementForm
          project={p}
          timezone={data.workspace.timezone}
          onClose={() => setAgreement(false)}
        />
      )}{" "}
      {manual && <TimeForm data={data} onClose={() => setManual(false)} />}
    </>
  );
}
