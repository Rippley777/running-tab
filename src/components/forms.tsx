import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Clock3, ArrowRight } from "lucide-react";
import { api, post } from "../lib/api";
import { parseMoney } from "../lib/format";
import { Button, Field, ErrorMessage, Modal } from "./ui";
import type { Snapshot, Entry, Project, Client } from "../../shared/contracts";
function useSave(
  fn: (data: Record<string, any>) => Promise<unknown>,
  onDone: () => void,
) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await cache.invalidateQueries();
      onDone();
    },
  });
}
const str = (f: FormData, name: string) => String(f.get(name) ?? "");
export function ClientForm({
  onClose,
  client,
}: {
  onClose: () => void;
  client?: Client;
}) {
  const [error, setError] = useState<unknown>();
  const m = useSave(
    (data) =>
      client
        ? api(`/api/v1/clients/${client.id}`, { method: "PATCH", data })
        : post("/api/v1/clients", data),
    onClose,
  );
  return (
    <Modal
      title={client ? "Edit client details" : "A new client"}
      description={
        client
          ? "Changes apply to future work and new drafts. Existing invoice snapshots stay intact."
          : "Start with the essentials. Billing details stay private."
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            m.mutate({
              name: str(f, "name"),
              email: str(f, "email"),
              address: str(f, "address"),
              defaultRate: str(f, "rate") ? parseMoney(str(f, "rate")) : null,
              paymentTerms: Number(f.get("terms")),
              ...(client ? { color: client.color } : {}),
            });
          } catch (err) {
            setError(err);
          }
        }}
      >
        <Field label="Client name">
          <input
            name="name"
            placeholder="Northstar"
            required
            autoFocus
            maxLength={120}
            defaultValue={client?.name ?? ""}
          />
        </Field>
        <Field label="Billing email">
          <input
            name="email"
            type="email"
            placeholder="accounts@company.com"
            required
            defaultValue={client?.email ?? ""}
          />
        </Field>
        <Field label="Billing address">
          <textarea
            name="address"
            rows={2}
            placeholder="Street, city, state, ZIP"
            defaultValue={client?.address ?? ""}
          />
        </Field>
        <div className="form-grid">
          <Field
            label="Hourly rate · USD"
            hint="Optional; uses your workspace default."
          >
            <input
              name="rate"
              inputMode="decimal"
              placeholder="150.00"
              pattern="[0-9]+(\.[0-9]{1,2})?"
              defaultValue={
                client?.default_rate == null
                  ? ""
                  : (client.default_rate / 100).toFixed(2)
              }
            />
          </Field>
          <Field label="Payment terms">
            <select
              name="terms"
              defaultValue={String(client?.payment_terms ?? 14)}
            >
              <option value="0">Due on receipt</option>
              <option value="7">Net 7</option>
              <option value="14">Net 14</option>
              <option value="30">Net 30</option>
            </select>
          </Field>
        </div>
        <ErrorMessage error={m.error ?? error} />
        <footer className="form-footer">
          <Button kind="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={m.isPending}>
            {client ? "Save client" : "Create client"}
            <ArrowRight size={15} />
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
export function ProjectForm({
  data,
  onClose,
  clientId,
}: {
  data: Snapshot;
  onClose: () => void;
  clientId?: string;
}) {
  const [model, setModel] = useState("hourly");
  const [localError, setError] = useState<unknown>(null);
  const m = useSave((v) => post("/api/v1/projects", v), onClose);
  return (
    <Modal
      title="Make room for good work"
      description="Choose how this project will be billed. Rates apply prospectively."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            m.mutate({
              clientId: str(f, "client"),
              name: str(f, "name"),
              description: str(f, "description"),
              model,
              rate: str(f, "rate") ? parseMoney(str(f, "rate")) : null,
              fee: str(f, "fee") ? parseMoney(str(f, "fee")) : 0,
              estimateSeconds: str(f, "estimate")
                ? Math.round(Number(f.get("estimate")) * 3600)
                : null,
            });
          } catch (err) {
            setError(err);
          }
        }}
      >
        <Field label="Project name">
          <input
            name="name"
            required
            autoFocus
            placeholder="Something worth building"
          />
        </Field>
        <Field label="Client">
          <select name="client" required defaultValue={clientId ?? ""}>
            <option value="" disabled>
              Choose a client
            </option>
            {data.clients
              .filter((c) => !c.archived_at)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Description">
          <textarea
            name="description"
            placeholder="What are we working toward?"
            rows={2}
          />
        </Field>
        <Field label="Billing model">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="hourly">Hourly · confirmed time × rate</option>
            <option value="fixed">Fixed price · one agreed project fee</option>
            <option value="prepaid">
              Prepaid hours · project-specific buckets
            </option>
            <option value="support">
              Recurring support · a fixed period fee
            </option>
          </select>
        </Field>
        <div className="form-grid">
          <Field
            label={
              model === "fixed" || model === "support"
                ? "Agreed fee · USD"
                : "Hourly rate · USD"
            }
          >
            <input
              name={model === "fixed" || model === "support" ? "fee" : "rate"}
              key={model}
              inputMode="decimal"
              required={model === "fixed" || model === "support"}
              pattern="[0-9]+(\.[0-9]{1,2})?"
              placeholder="150.00"
            />
          </Field>
          <Field label="Estimated hours">
            <input
              name="estimate"
              type="number"
              step="0.25"
              min="0.25"
              placeholder="Optional"
            />
          </Field>
        </div>
        <ErrorMessage error={m.error ?? localError} />
        <footer className="form-footer">
          <Button kind="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={m.isPending}>
            Create project
            <ArrowRight size={15} />
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
export function TimeForm({
  data,
  onClose,
  context,
}: {
  data: Snapshot;
  onClose: () => void;
  context?: Entry;
}) {
  const [mode, setMode] = useState<"duration" | "interval">("duration");
  const [overlap, setOverlap] = useState(false);
  const [localError, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem("manual-time-draft") ?? "{}");
    } catch {
      return {};
    }
  });
  const m = useSave(
    (v) => post("/api/v1/entries", v, draft.key ?? crypto.randomUUID()),
    () => {
      sessionStorage.removeItem("manual-time-draft");
      onClose();
    },
  );
  const now = new Date(),
    offset = new Date(+now - now.getTimezoneOffset() * 60000);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const f = new FormData(e.currentTarget);
      const end =
        mode === "interval"
          ? new Date(str(f, "end"))
          : new Date(`${str(f, "date")}T${str(f, "time")}`);
      const start =
        mode === "interval"
          ? new Date(str(f, "start"))
          : new Date(
              +end -
                Math.round(
                  Number(f.get("hours")) * 3600 + Number(f.get("minutes")) * 60,
                ) *
                  1000,
            );
      m.mutate({
        projectId: str(f, "project"),
        description: str(f, "description"),
        startedAt: start.toISOString(),
        endedAt: end.toISOString(),
        billable: f.get("billable") === "on",
        acknowledgeOverlap: overlap,
      });
    } catch (err) {
      setError(err);
    }
  };
  return (
    <Modal
      title={context ? "Track this work again" : "Add a little time"}
      description={`Enter work you’ve already done. Dates use this device’s time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`}
      onClose={onClose}
    >
      <form
        onSubmit={submit}
        onChange={(e) => {
          const values = Object.fromEntries(new FormData(e.currentTarget));
          const next = { ...values, key: draft.key ?? crypto.randomUUID() };
          setDraft(next);
          sessionStorage.setItem("manual-time-draft", JSON.stringify(next));
        }}
      >
        <Field label="Project">
          <select
            name="project"
            required
            defaultValue={context?.project_id ?? draft.project ?? ""}
          >
            <option value="" disabled>
              Choose a project
            </option>
            {data.projects
              .filter((p) => p.status === "active")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.client_name} / {p.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="What did you work on?">
          <textarea
            name="description"
            defaultValue={context?.description ?? draft.description ?? ""}
            rows={3}
            placeholder="Implemented account permissions and added regression tests"
          />
        </Field>
        <div className="segmented">
          <button
            type="button"
            className={mode === "duration" ? "selected" : ""}
            onClick={() => setMode("duration")}
          >
            Duration
          </button>
          <button
            type="button"
            className={mode === "interval" ? "selected" : ""}
            onClick={() => setMode("interval")}
          >
            Start & end
          </button>
        </div>
        {mode === "duration" ? (
          <>
            <div className="form-grid">
              <Field label="Hours">
                <input
                  name="hours"
                  type="number"
                  min="0"
                  max="168"
                  defaultValue={draft.hours ?? "1"}
                  required
                />
              </Field>
              <Field label="Minutes">
                <input
                  name="minutes"
                  type="number"
                  min="0"
                  max="59"
                  defaultValue={draft.minutes ?? "0"}
                  required
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="Date">
                <input
                  name="date"
                  type="date"
                  defaultValue={draft.date ?? offset.toISOString().slice(0, 10)}
                  required
                />
              </Field>
              <Field label="Finished at">
                <input
                  name="time"
                  type="time"
                  defaultValue={
                    draft.time ?? offset.toISOString().slice(11, 16)
                  }
                  required
                />
              </Field>
            </div>
          </>
        ) : (
          <div className="form-grid">
            <Field label="Started">
              <input
                name="start"
                type="datetime-local"
                required
                defaultValue={offset.toISOString().slice(0, 16)}
              />
            </Field>
            <Field label="Finished">
              <input
                name="end"
                type="datetime-local"
                required
                defaultValue={offset.toISOString().slice(0, 16)}
              />
            </Field>
          </div>
        )}
        <label className="check-field">
          <input
            type="checkbox"
            name="billable"
            defaultChecked={context?.billable ?? true}
          />
          Billable project work
        </label>
        <label className="check-field">
          <input
            type="checkbox"
            checked={overlap}
            onChange={(e) => setOverlap(e.target.checked)}
          />
          I reviewed and want to keep any overlapping time
        </label>
        <p className="fine-print">
          Fixed-price, support, and covered prepaid time won’t become an hourly
          charge.
        </p>
        <ErrorMessage error={m.error ?? localError} />
        <footer className="form-footer">
          <Button type="button" kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={m.isPending}>
            <Clock3 size={15} />
            Save time
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
export function EditEntryForm({
  entry,
  onClose,
}: {
  entry: Entry;
  onClose: () => void;
}) {
  const [timing, setTiming] = useState(false);
  const localTime = (value: string) => {
    const d = new Date(value);
    return new Date(+d - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19);
  };
  const m = useSave(
    (v) => api(`/api/v1/entries/${entry.id}`, { method: "PATCH", data: v }),
    onClose,
  );
  return (
    <Modal
      title="Review this work"
      description="Confirmed billing sources are locked when allocated to an invoice."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          m.mutate({
            version: entry.version,
            description: str(f, "description"),
            reviewed: true,
            ...(timing
              ? {
                  startedAt: new Date(str(f, "start")).toISOString(),
                  endedAt: new Date(str(f, "end")).toISOString(),
                  billable: f.get("billable") === "on",
                  acknowledgeOverlap: f.get("overlap") === "on",
                }
              : {}),
          });
        }}
      >
        <Field label="Client-facing work description">
          <textarea
            name="description"
            required
            rows={4}
            defaultValue={entry.description}
            autoFocus
          />
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            checked={timing}
            onChange={(e) => setTiming(e.target.checked)}
          />
          Correct the time or billable classification
        </label>
        {timing && (
          <>
            <div className="form-grid">
              <Field label="Actual start · device time">
                <input
                  name="start"
                  type="datetime-local"
                  step="1"
                  required
                  defaultValue={localTime(entry.started_at)}
                />
              </Field>
              <Field label="Actual end · device time">
                <input
                  name="end"
                  type="datetime-local"
                  step="1"
                  required
                  defaultValue={localTime(entry.ended_at)}
                />
              </Field>
            </div>
            <label className="check-field">
              <input
                name="billable"
                type="checkbox"
                defaultChecked={entry.billable}
              />
              Billable work
            </label>
            <label className="check-field">
              <input name="overlap" type="checkbox" />I reviewed and want to
              keep any overlapping time
            </label>
          </>
        )}
        <p className="fine-print">
          Rate snapshot: ${(entry.rate / 100).toFixed(2)}/hour · The rate stays
          fixed. Correcting prepaid time records reversals.
        </p>
        <ErrorMessage error={m.error} />
        <footer className="form-footer">
          <Button
            type="button"
            kind="danger"
            busy={m.isPending}
            onClick={() => m.mutate({ version: entry.version, delete: true })}
          >
            Remove unbilled entry
          </Button>
          <Button busy={m.isPending}>
            <Check size={15} />
            Save & mark reviewed
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
export function AgreementForm({
  project,
  onClose,
  timezone,
}: {
  project: Project;
  onClose: () => void;
  timezone: string;
}) {
  const prepaid = project.model === "prepaid";
  const [err, setErr] = useState<unknown>();
  const m = useSave(
    (v) => post(prepaid ? "/api/v1/buckets" : "/api/v1/agreements", v),
    onClose,
  );
  return (
    <Modal
      title={prepaid ? "A new bank of hours" : "Set a support schedule"}
      description={
        prepaid
          ? "Hours activate only after the purchase invoice is paid."
          : "Schedules create drafts for approval. They never initiate charges."
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            m.mutate(
              prepaid
                ? {
                    projectId: project.id,
                    name: str(f, "name"),
                    seconds: Math.round(Number(f.get("hours")) * 3600),
                    price: parseMoney(str(f, "fee")),
                    expiresAt: str(f, "expiry")
                      ? new Date(`${str(f, "expiry")}T23:59:59`).toISOString()
                      : null,
                  }
                : {
                    projectId: project.id,
                    fee: parseMoney(str(f, "fee")),
                    frequency: str(f, "frequency"),
                    anchor: str(f, "anchor"),
                    timezone,
                  },
            );
          } catch (er) {
            setErr(er);
          }
        }}
      >
        {prepaid ? (
          <>
            <Field label="Bucket name">
              <input name="name" required defaultValue="Engineering hours" />
            </Field>
            <Field label="Purchased hours">
              <input
                name="hours"
                type="number"
                min="1"
                max="1000"
                required
                defaultValue="20"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Frequency">
              <select name="frequency">
                <option value="monthly">Monthly</option>
                <option value="weekly">Weekly</option>
              </select>
            </Field>
            <Field label="First billing date">
              <input
                name="anchor"
                type="date"
                required
                defaultValue={new Date().toISOString().slice(0, 10)}
              />
            </Field>
          </>
        )}
        <Field label="Agreed price · USD">
          <input
            name="fee"
            inputMode="decimal"
            required
            defaultValue={String(project.fee / 100 || "")}
          />
        </Field>
        {prepaid && (
          <Field label="Expiry date · optional">
            <input name="expiry" type="date" />
          </Field>
        )}
        <ErrorMessage error={m.error ?? err} />
        <footer className="form-footer">
          <Button type="button" kind="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={m.isPending}>
            Create {prepaid ? "bucket" : "schedule"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
