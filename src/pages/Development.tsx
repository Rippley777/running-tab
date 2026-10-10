import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Snapshot } from "../../shared/contracts";
import {
  describeDevelopment,
  type DescriptionStyle,
  type DevelopmentSession,
  type Rule,
} from "../../shared/development";
import { api, post, native, navigate } from "../lib/api";
import {
  Button,
  Field,
  ErrorMessage,
  PageHeader,
  Badge,
  Empty,
  SectionHeading,
} from "../components/ui";
import { hours, money, fullDay } from "../lib/format";

type LocalRepository = {
  id: string;
  serverId: string | null;
  identity: string;
  name: string;
  path: string;
  branch: string;
  defaultBranch: string | null;
  remote: string | null;
  mode: string;
  lastActivity: number | null;
  error: string | null;
};
type LocalSession = {
  id: string;
  repositoryId: string;
  branch: string;
  startedAt: number;
  endedAt: number;
  inferredSeconds: number;
  state: string;
  evidence: { at: number; kind: string; detail: string }[];
};
type LocalState = {
  syncError?: string;
  repositories: LocalRepository[];
  sessions: LocalSession[];
  settings: {
    idleSeconds: number;
    mergeSeconds: number;
    minimumSeconds: number;
  };
};
const sessionKey = (data: Snapshot) => [
  "development-sessions",
  data.workspace.id,
];
const localKey = (data: Snapshot) => ["local-development", data.workspace.id];
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
async function shareSession(
  s: LocalSession,
  r: LocalRepository,
  mergeSeconds: number,
) {
  if (!r.serverId)
    throw new Error("Link this repository before reviewing its sessions.");
  await post(
    "/api/v1/development-sessions",
    {
      ...s,
      repositoryId: r.serverId,
      mergeSeconds,
      startedAt: iso(s.startedAt),
      endedAt: iso(s.endedAt),
      evidence: s.evidence.map((e) => ({ ...e, at: iso(e.at) })),
    },
    s.id,
  );
  await invoke("tracking_remove_session", { id: s.id });
}
// Mounted once in the signed-in shell. Native collection itself runs outside the webview.
export function NativeCollector({ data }: { data: Snapshot }) {
  const cache = useQueryClient();
  const q = useQuery({
    queryKey: localKey(data),
    enabled: native,
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
    queryFn: async () => {
      const local = await invoke<LocalState>("tracking_state", {
        workspaceId: data.workspace.id,
      });
      let syncError: string | undefined;
      try {
        // Fetch current permission state; a web-side disable stops collection on the next sync.
        const mappings = await api<Snapshot["repositories"]>(
          "/api/v1/repositories",
        );
        for (const r of local.repositories) {
          if (
            r.mode !== "manual" &&
            r.serverId &&
            !mappings.find((m) => m.id === r.serverId)?.tracking_enabled
          )
            await invoke("tracking_configure", {
              repositoryId: r.id,
              serverId: r.serverId,
              mode: "manual",
            });
        }
        for (const s of local.sessions.filter(
          (s) =>
            s.state === "completed" &&
            s.inferredSeconds >= local.settings.minimumSeconds,
        )) {
          const r = local.repositories.find((r) => r.id === s.repositoryId);
          if (
            r &&
            mappings.find((m) => m.id === r.serverId)?.tracking_enabled
          ) {
            await shareSession(s, r, local.settings.mergeSeconds);
            await cache.invalidateQueries({ queryKey: sessionKey(data) });
          }
        }
      } catch (error) {
        syncError = error instanceof Error ? error.message : String(error);
      }
      return {
        ...(await invoke<LocalState>("tracking_state", {
          workspaceId: data.workspace.id,
        })),
        syncError,
      };
    },
  });
  const error = q.error ?? q.data?.syncError;
  return error ? (
    <div className="stale-banner" role="status">
      Local tracking or synchronization needs attention:{" "}
      {error instanceof Error ? error.message : String(error)}. Unsynchronized
      activity stays on this device.
    </div>
  ) : null;
}
function useSessions(data: Snapshot) {
  return useQuery({
    queryKey: sessionKey(data),
    queryFn: () => api<DevelopmentSession[]>("/api/v1/development-sessions"),
    refetchInterval: 30000,
  });
}
export function DevelopmentSummary({ data }: { data: Snapshot }) {
  const q = useSessions(data);
  const local = useQuery<LocalState>({
    queryKey: localKey(data),
    enabled: false,
  });
  const pending = q.data?.filter((s) => s.status === "suggested").length ?? 0;
  const active =
    local.data?.sessions.filter(
      (s) => s.state === "active" || s.state === "paused",
    ) ?? [];
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: data.workspace.timezone,
  }).format(new Date());
  const daily = data.metrics.daily.find((d) => d.date === today);
  const entries = data.entries.filter(
    (e) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: data.workspace.timezone,
      }).format(new Date(e.started_at)) === today,
  );
  return (
    <section
      className="panel padded mt"
      aria-label="Development tracking summary"
    >
      <SectionHeading
        title="Development activity"
        action="Review suggestions"
        onAction={() => navigate("/development")}
      />
      <p>
        {native
          ? active.length
            ? active
                .map(
                  (s) =>
                    `${local.data?.repositories.find((r) => r.id === s.repositoryId)?.name} · ${s.branch} · ${s.state} · ${hours(s.inferredSeconds)} estimated`,
                )
                .join("; ")
            : "No active development session."
          : "Connect repositories in the desktop app; review synchronized sessions here."}
      </p>
      <p>
        {pending} pending suggestions · Today:{" "}
        {hours((daily?.billable ?? 0) + (daily?.nonbillable ?? 0))} tracked ·{" "}
        {hours(daily?.billable ?? 0)} billable ·{" "}
        {hours(daily?.nonbillable ?? 0)} nonbillable ·
        {money(
          entries
            .filter((e) => e.treatment === "hourly")
            .reduce(
              (n, e) => n + Math.round((e.billed_seconds * e.rate) / 3600),
              0,
            ),
        )}{" "}
        hourly entry value (start dates)
      </p>
      <div className="button-group">
        <Button kind="secondary" onClick={() => navigate("/development")}>
          Connect repository
        </Button>
        <Button kind="ghost" onClick={() => navigate("/billing")}>
          Open invoices
        </Button>
      </div>
      <ErrorMessage error={q.error} />
    </section>
  );
}
function ProjectSelect({
  data,
  value,
  onChange,
  label = "Project / client",
}: {
  data: Snapshot;
  value: string;
  onChange: (v: string) => void;
  label?: string;
}) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Unassigned — needs review</option>
        {data.projects
          .filter((p) => p.status === "active")
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.client_name} / {p.name}
            </option>
          ))}
      </select>
    </Field>
  );
}
function TaskSelect({
  data,
  projectId,
  value,
  onChange,
}: {
  data: Snapshot;
  projectId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Task (optional)">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">No task</option>
        {data.tasks
          .filter((t) => t.project_id === projectId)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
      </select>
    </Field>
  );
}
function RepositoryEditor({
  data,
  repository,
  local,
}: {
  data: Snapshot;
  repository: Snapshot["repositories"][number];
  local?: LocalRepository;
}) {
  const [project, setProject] = useState(repository.project_id ?? ""),
    [task, setTask] = useState(repository.task_id ?? ""),
    [billable, setBillable] = useState(repository.billable),
    [enabled, setEnabled] = useState(repository.tracking_enabled),
    [mode, setMode] = useState(
      local?.mode === "automatic" ? "automatic" : "assisted",
    ),
    [rules, setRules] = useState<Rule[]>(repository.branch_rules ?? []);
  const cache = useQueryClient();
  const m = useMutation({
    mutationFn: async () => {
      await api(`/api/v1/repositories/${repository.id}`, {
        method: "PATCH",
        data: {
          projectId: project || null,
          taskId: task || null,
          billable,
          trackingEnabled: enabled,
          rules,
          version: repository.version,
        },
      });
      if (local)
        await invoke("tracking_configure", {
          repositoryId: local.id,
          serverId: repository.id,
          mode: enabled ? mode : "manual",
        });
    },
    onSuccess: () => cache.invalidateQueries(),
  });
  return (
    <details className="panel padded mt">
      <summary>
        {repository.alias || repository.identity} ·{" "}
        {local
          ? local.mode
          : repository.tracking_enabled
            ? "summary sharing enabled"
            : "manual / disabled"}
      </summary>
      {local && (
        <p className="fine-print">
          {local.path}
          <br />
          {local.branch} · default: {local.defaultBranch ?? "unknown"} · last
          activity:{" "}
          {local.lastActivity
            ? new Date(local.lastActivity * 1000).toLocaleString()
            : "none"}
        </p>
      )}
      <ProjectSelect
        data={data}
        value={project}
        onChange={(v) => {
          setProject(v);
          setTask("");
        }}
      />
      <TaskSelect
        data={data}
        projectId={project}
        value={task}
        onChange={setTask}
      />
      <label className="check-field">
        <input
          type="checkbox"
          checked={billable}
          onChange={(e) => setBillable(e.target.checked)}
        />
        Default billable suggestion
      </label>
      <h3>Branch overrides</h3>
      <p className="fine-print">
        Exact rules win over wildcards. Multiple matching wildcard rules remain
        unassigned. * matches any characters; ? matches one.
      </p>
      {rules.map((r, i) => (
        <div className="tracking-rule" key={i}>
          <Field label={`Branch pattern ${i + 1}`}>
            <input
              value={r.pattern}
              onChange={(e) =>
                setRules(
                  rules.map((x, n) =>
                    n === i ? { ...x, pattern: e.target.value } : x,
                  ),
                )
              }
              placeholder="feature/client-a-*"
            />
          </Field>
          <ProjectSelect
            label={`Rule ${i + 1} project / client`}
            data={data}
            value={r.projectId ?? ""}
            onChange={(v) =>
              setRules(
                rules.map((x, n) =>
                  n === i ? { ...x, projectId: v || null, taskId: null } : x,
                ),
              )
            }
          />
          <TaskSelect
            data={data}
            projectId={r.projectId ?? ""}
            value={r.taskId ?? ""}
            onChange={(v) =>
              setRules(
                rules.map((x, n) =>
                  n === i ? { ...x, taskId: v || null } : x,
                ),
              )
            }
          />
          <label className="check-field">
            <input
              type="checkbox"
              checked={r.billable}
              onChange={(e) =>
                setRules(
                  rules.map((x, n) =>
                    n === i ? { ...x, billable: e.target.checked } : x,
                  ),
                )
              }
            />
            Billable
          </label>
          <Button
            kind="ghost"
            onClick={() => setRules(rules.filter((_, n) => n !== i))}
          >
            Remove rule {i + 1}
          </Button>
        </div>
      ))}
      <Button
        kind="secondary"
        onClick={() =>
          setRules([
            ...rules,
            { pattern: "", projectId: null, billable: false },
          ])
        }
      >
        Add branch rule
      </Button>
      <label className="check-field">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable repository tracking and share session summaries with my Running
        Tab workspace
      </label>
      {local && (
        <Field label="Tracking mode">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="assisted">Assisted — review every entry</option>
            <option value="automatic">
              Automatic observation — opt in; still review before billing
            </option>
          </select>
        </Field>
      )}
      <p className="fine-print">
        Disabling tracking selects Manual mode. Only approved local directories
        are observed. Branch names, commit hashes and session timestamps are
        synchronized; paths and raw file metadata stay local. No source code,
        screenshots or keystrokes. Keep the desktop app running to observe
        activity.
      </p>
      <ErrorMessage error={m.error} />
      <Button busy={m.isPending} onClick={() => m.mutate()}>
        Save repository settings
      </Button>
    </details>
  );
}
function LocalControls({ data, local }: { data: Snapshot; local: LocalState }) {
  const cache = useQueryClient();
  const [path, setPath] = useState("");
  const [settings, setSettings] = useState(local.settings);
  const m = useMutation({
    mutationFn: async ({
      command,
      args,
    }: {
      command: string;
      args: Record<string, unknown>;
    }) => invoke(command, args),
    onSuccess: async () => {
      const fresh = await invoke<LocalState>("tracking_state", {
        workspaceId: data.workspace.id,
      });
      cache.setQueryData(localKey(data), fresh);
      void cache.invalidateQueries();
    },
  });
  const link = useMutation({
    mutationFn: async (r: LocalRepository) => {
      const mapping =
        data.repositories.find((m) => m.identity === r.identity) ??
        (await post<{ id: string }>("/api/v1/repositories", {
          projectId: null,
          identity: r.identity,
          alias: r.name,
        }));
      await invoke("tracking_configure", {
        repositoryId: r.id,
        serverId: mapping.id,
        mode: "manual",
      });
    },
    onSuccess: () => cache.invalidateQueries(),
  });
  const share = useMutation({
    mutationFn: async (s: LocalSession) =>
      shareSession(
        s,
        local.repositories.find((r) => r.id === s.repositoryId)!,
        local.settings.mergeSeconds,
      ),
    onSuccess: () => cache.invalidateQueries(),
  });
  return (
    <section className="panel padded mt">
      <SectionHeading title="Approved local repositories" />
      <div className="button-group">
        <Button
          kind="secondary"
          onClick={() =>
            m.mutate({
              command: "tracking_discover",
              args: {
                workspaceId: data.workspace.id,
                workspace: false,
                manualPath: null,
              },
            })
          }
        >
          Choose repository
        </Button>
        <Button
          kind="secondary"
          onClick={() =>
            m.mutate({
              command: "tracking_discover",
              args: {
                workspaceId: data.workspace.id,
                workspace: true,
                manualPath: null,
              },
            })
          }
        >
          Discover in workspace
        </Button>
      </div>
      <p className="fine-print">
        Discovery is limited to the selected directory, four levels and 2,000
        directories. Every result starts disabled. Re-select a moved repository
        to update its path.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate({
            command: "tracking_discover",
            args: {
              workspaceId: data.workspace.id,
              workspace: false,
              manualPath: path,
            },
          });
        }}
      >
        <Field label="Repository path (manual)">
          <input
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/path/to/approved/repository"
          />
        </Field>
        <Button kind="secondary">Add repository path</Button>
      </form>
      {local.repositories.map((r) => (
        <div className="tracking-local" key={r.id}>
          <strong>{r.name}</strong>
          <p>
            {r.branch} · {r.mode} · {r.path}
          </p>
          <ErrorMessage error={r.error} />
          {r.mode !== "manual" && (
            <Button
              kind="secondary"
              onClick={() =>
                m.mutate({
                  command: "tracking_configure",
                  args: {
                    repositoryId: r.id,
                    serverId: r.serverId,
                    mode: "manual",
                  },
                })
              }
            >
              Pause tracking on this device
            </Button>
          )}
          {!r.serverId ? (
            <Button busy={link.isPending} onClick={() => link.mutate(r)}>
              Connect {r.name}
            </Button>
          ) : (
            <Button
              kind="ghost"
              onClick={() =>
                m.mutate({
                  command: "tracking_finish",
                  args: { repositoryId: r.id },
                })
              }
            >
              Finish current session for review
            </Button>
          )}
        </div>
      ))}
      {local.sessions.map((s) => (
        <div key={s.id} className="tracking-local">
          <Badge status={s.state} />
          <p>
            {local.repositories.find((r) => r.id === s.repositoryId)?.name} ·{" "}
            {s.branch} · {hours(s.inferredSeconds)} inferred
          </p>
          {s.state === "completed" && (
            <div className="button-group">
              <Button
                kind="secondary"
                busy={share.isPending}
                onClick={() => share.mutate(s)}
              >
                Review short or uncertain session
              </Button>
              <Button
                kind="ghost"
                onClick={() =>
                  m.mutate({
                    command: "tracking_remove_session",
                    args: { id: s.id },
                  })
                }
              >
                Delete local activity
              </Button>
            </div>
          )}
        </div>
      ))}
      <details>
        <summary>Session thresholds</summary>
        <p className="fine-print">
          A 30-second poll observes metadata changes. Short gaps are inferred;
          idle and interrupted gaps are excluded. Short sessions stay here until
          explicitly sent for review.
        </p>
        {(
          [
            ["idleSeconds", "Idle threshold (minutes)"],
            ["mergeSeconds", "Merge gap (minutes)"],
            ["minimumSeconds", "Minimum suggestion (minutes)"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              type="number"
              min={key === "minimumSeconds" ? 0 : 1}
              max={key === "idleSeconds" ? 120 : 60}
              value={settings[key] / 60}
              onChange={(e) =>
                setSettings({ ...settings, [key]: Number(e.target.value) * 60 })
              }
            />
          </Field>
        ))}
        <Button
          kind="secondary"
          onClick={() =>
            m.mutate({ command: "tracking_settings", args: { settings } })
          }
        >
          Save thresholds
        </Button>
      </details>
      <ErrorMessage error={m.error ?? link.error ?? share.error} />
    </section>
  );
}
function localTime(value: string) {
  const d = new Date(value);
  return new Date(+d - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}
function SessionCard({
  s,
  data,
  sessions,
}: {
  s: DevelopmentSession;
  data: Snapshot;
  sessions: DevelopmentSession[];
}) {
  const [project, setProject] = useState(s.project_id ?? ""),
    [task, setTask] = useState(s.task_id ?? ""),
    [billable, setBillable] = useState(s.billable),
    [description, setDescription] = useState(s.description),
    [start, setStart] = useState(
      localTime(s.proposed_started_at ?? s.started_at),
    ),
    [minutes, setMinutes] = useState(
      (s.adjusted_seconds ?? s.inferred_seconds)
        ? String(Math.round((s.adjusted_seconds ?? s.inferred_seconds) / 60))
        : "",
    ),
    [style, setStyle] = useState<DescriptionStyle>("professional"),
    [split, setSplit] = useState(
      localTime(
        new Date(
          (+new Date(s.started_at) + +new Date(s.ended_at)) / 2,
        ).toISOString(),
      ),
    ),
    [other, setOther] = useState("");
  const cache = useQueryClient();
  const [shareAI, setShareAI] = useState(false);
  const ai = useMutation({
    mutationFn: () =>
      post<{
        provider: string;
        suggestions: { description: string }[];
        warnings: string[];
      }>("/api/v1/descriptions", {
        entryIds: [],
        sessionIds: [s.id],
        style,
        useAI: true,
        confirmedSharing: shareAI,
      }),
  });
  const m = useMutation({
    mutationFn: async ({
      action,
      extra = {},
    }: {
      action: string;
      extra?: Record<string, unknown>;
    }) => {
      if (action === "approve")
        return post(`/api/v1/development-sessions/${s.id}/approve`, {
          version: s.version,
          projectId: project,
          taskId: task || null,
          billable,
          description,
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(
            +new Date(start) + Number(minutes) * 60000,
          ).toISOString(),
        });
      return api(`/api/v1/development-sessions/${s.id}`, {
        method: "PATCH",
        data: { version: s.version, action, ...extra },
      });
    },
    onSuccess: () => cache.invalidateQueries(),
  });
  const p = data.projects.find((p) => p.id === project),
    c = data.clients.find((c) => c.id === p?.client_id),
    rate = p?.rate ?? c?.default_rate ?? data.workspace.default_rate;
  const actual = Math.round(Number(minutes) * 60),
    increment = data.workspace.rounding_minutes * 60,
    billed = increment ? Math.ceil(actual / increment) * increment : actual;
  return (
    <article
      className="panel padded mt tracking-card"
      aria-label={`Session ${s.alias || s.identity} ${s.branch}`}
    >
      <div className="section-heading">
        <h3>
          {s.alias || s.identity} · {s.branch || "Unknown branch"}
        </h3>
        <Badge status={s.status} />
      </div>
      <p>
        {s.client_name ?? "Unassigned client"} /{" "}
        {s.project_name ?? "Unassigned project"} ·{" "}
        {new Date(s.started_at).toLocaleString()} –{" "}
        {new Date(s.ended_at).toLocaleString()}
      </p>
      <p>
        <strong>{s.confidence} confidence</strong> ·{" "}
        {s.inferred_seconds
          ? `${hours(s.inferred_seconds)} inferred`
          : "Duration needed"}{" "}
        · human-active time not measured
        {s.status === "approved" && s.adjusted_seconds !== null
          ? ` · ${hours(s.adjusted_seconds)} approved`
          : ""}
      </p>
      <p className="fine-print">{s.reason}</p>
      {s.status === "suggested" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            m.mutate({ action: "approve" });
          }}
        >
          <div className="tracking-fields">
            <ProjectSelect
              data={data}
              value={project}
              onChange={(v) => {
                setProject(v);
                setTask("");
              }}
            />
            <TaskSelect
              data={data}
              projectId={project}
              value={task}
              onChange={setTask}
            />
            <Field label="Start (your device time zone)">
              <input
                type="datetime-local"
                step="1"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="Duration in minutes">
              <input
                type="number"
                min="1"
                max="10080"
                step="1"
                required
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="Enter your estimate"
              />
            </Field>
          </div>
          <label className="check-field">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
            />
            Billable
          </label>
          <p>
            {p ? `${c?.name} / ${p.name}` : "Choose a project to save time"} ·{" "}
            {money(rate)}/hour · USD ·{" "}
            {billable && p?.model === "hourly"
              ? `${money(Math.round((billed * rate) / 3600) || 0, true)} estimated (${data.workspace.rounding_minutes || "no"} minute rounding)`
              : `${p?.model ?? "unassigned"} billing treatment`}
          </p>
          <Field label="Invoice-ready description">
            <textarea
              rows={3}
              required
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <details>
            <summary>Description options</summary>
            <Field label="Description style">
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value as DescriptionStyle)}
              >
                {["concise", "professional", "detailed", "technical"].map(
                  (v) => (
                    <option key={v}>{v}</option>
                  ),
                )}
              </select>
            </Field>
            <p className="fine-print">
              Preview: {describeDevelopment(s.branch, style)}
            </p>
            <Button
              type="button"
              kind="secondary"
              onClick={() =>
                setDescription(describeDevelopment(s.branch, style))
              }
            >
              Use template description
            </Button>
            <p className="fine-print">
              No AI required. Optional AI rewriting of reviewed entries is also
              available in invoice preparation.
            </p>
          </details>
          {data.workspace.ai_enabled && (
            <details>
              <summary>Optional AI description</summary>
              <p className="fine-print">
                Save your draft description first. Only this saved description
                is shared; source files, paths, client details, rates and
                duration are excluded. Review every claim.
              </p>
              <blockquote>{s.description}</blockquote>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={shareAI}
                  onChange={(e) => setShareAI(e.target.checked)}
                />
                Share this saved description with the configured AI provider
              </label>
              <Button
                type="button"
                kind="secondary"
                busy={ai.isPending}
                disabled={!shareAI || description !== s.description}
                onClick={() => ai.mutate()}
              >
                Draft with AI
              </Button>
              <ErrorMessage error={ai.error} />
              {ai.data && (
                <>
                  <p>
                    {ai.data.provider === "template"
                      ? "Deterministic fallback"
                      : "AI draft — review before use"}
                  </p>
                  {ai.data.warnings.map((w) => (
                    <p key={w} className="fine-print">
                      {w}
                    </p>
                  ))}
                  {ai.data.suggestions.map((draft, i) => (
                    <div key={i}>
                      <p>{draft.description}</p>
                      <Button
                        type="button"
                        kind="secondary"
                        onClick={() => setDescription(draft.description)}
                      >
                        Use this draft
                      </Button>
                    </div>
                  ))}
                </>
              )}
            </details>
          )}
          <div className="button-group">
            <Button
              disabled={
                m.isPending || !project || !minutes || !description.trim()
              }
              busy={m.isPending}
            >
              Approve time entry
            </Button>
            <Button
              type="button"
              kind="secondary"
              busy={m.isPending}
              onClick={() =>
                m.mutate({
                  action: "edit",
                  extra: {
                    ...(minutes && start
                      ? {
                          startedAt: new Date(start).toISOString(),
                          durationSeconds: Math.round(Number(minutes) * 60),
                        }
                      : {}),
                    projectId: project || null,
                    taskId: task || null,
                    billable,
                    description,
                  },
                })
              }
            >
              Save draft
            </Button>
            <Button
              type="button"
              kind="ghost"
              busy={m.isPending}
              onClick={() => m.mutate({ action: "discard" })}
            >
              Discard suggestion
            </Button>
          </div>
          <details>
            <summary>Split or merge</summary>
            <Field label="Split at (device time zone)">
              <input
                type="datetime-local"
                step="1"
                value={split}
                onChange={(e) => setSplit(e.target.value)}
              />
            </Field>
            <Button
              type="button"
              kind="secondary"
              disabled={!split}
              busy={m.isPending}
              onClick={() =>
                m.mutate({
                  action: "split",
                  extra: { splitAt: new Date(split).toISOString() },
                })
              }
            >
              Split session
            </Button>
            <Field label="Compatible session">
              <select value={other} onChange={(e) => setOther(e.target.value)}>
                <option value="">Choose another session</option>
                {sessions
                  .filter(
                    (o) =>
                      o.id !== s.id &&
                      o.status === "suggested" &&
                      o.repository_id === s.repository_id &&
                      o.branch === s.branch &&
                      o.project_id === s.project_id &&
                      o.task_id === s.task_id &&
                      o.billable === s.billable,
                  )
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {new Date(o.started_at).toLocaleString()} ·{" "}
                      {hours(o.inferred_seconds)}
                    </option>
                  ))}
              </select>
            </Field>
            <Button
              type="button"
              kind="secondary"
              busy={m.isPending}
              disabled={!other}
              onClick={() =>
                m.mutate({
                  action: "merge",
                  extra: {
                    otherId: other,
                    otherVersion: sessions.find((o) => o.id === other)?.version,
                  },
                })
              }
            >
              Merge sessions
            </Button>
          </details>
        </form>
      ) : (
        <>
          <p>{s.description}</p>
          {s.time_entry_id && (
            <Button kind="secondary" onClick={() => navigate("/time")}>
              Open approved time entries
            </Button>
          )}
        </>
      )}
      <details>
        <summary>Session evidence and timeline</summary>
        <p className="fine-print">
          Estimates bridge consecutive file changes within the configured gap.
          Commit and branch events add no duration. Simultaneous activity
          requires manual estimation. UTC timestamps are retained across
          midnight and time zone changes. The approved billing interval starts
          at your edited start and lasts your edited duration.
        </p>
        <ol className="tracking-timeline">
          {s.evidence.map((e, i) => (
            <li key={i}>
              <time>{new Date(e.at).toLocaleString()}</time> ·{" "}
              {e.kind.replaceAll("_", " ")}
              <p>{e.detail}</p>
            </li>
          ))}
          <li>Time entry suggested</li>
          {s.status !== "suggested" && (
            <li>
              Time entry {s.status}{" "}
              {s.approved_at && new Date(s.approved_at).toLocaleString()}
            </li>
          )}
        </ol>
        <p className="fine-print">
          Source session: {s.id}
          {s.time_entry_id && ` · Entry: ${s.time_entry_id}`}
        </p>
        <Button
          kind="ghost"
          busy={m.isPending}
          onClick={() => m.mutate({ action: "delete" })}
        >
          Delete activity history (keep billing entry)
        </Button>
      </details>
      <ErrorMessage error={m.error} />
    </article>
  );
}
export function DevelopmentPage({ data }: { data: Snapshot }) {
  const q = useSessions(data);
  const local = useQuery<LocalState>({
    queryKey: localKey(data),
    enabled: false,
  });
  const [status, setStatus] = useState("suggested"),
    [project, setProject] = useState(""),
    [client, setClient] = useState(""),
    [repo, setRepo] = useState(""),
    [branch, setBranch] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const sessions = q.data ?? [];
  const filtered = sessions.filter(
    (s) =>
      (!status || s.status === status) &&
      (!project || s.project_id === project) &&
      (!client || s.client_id === client) &&
      (!repo || s.repository_id === repo) &&
      s.branch.toLowerCase().includes(branch.toLowerCase()) &&
      (!from || new Date(s.started_at) >= new Date(`${from}T00:00:00`)) &&
      (!to || new Date(s.started_at) <= new Date(`${to}T23:59:59`)),
  );
  const groups = new Map<string, DevelopmentSession[]>();
  for (const s of filtered) {
    const key = `${fullDay(s.started_at, data.workspace.timezone)} · ${s.project_name ?? "Unassigned"}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return (
    <>
      <PageHeader
        eyebrow="DEVELOPMENT ACTIVITY"
        title="Review the work. Keep the time."
        description="Local observations suggest work; you decide its duration, client and billable scope."
        actions={
          <Button kind="secondary" onClick={() => navigate("/time")}>
            Manual time & timers
          </Button>
        }
      />
      <DevelopmentSummary data={data} />
      <details className="panel padded mt">
        <summary>Repositories & tracking setup</summary>
        <p>
          Create a client and project, connect a repository, then enable
          Assisted tracking. Finish a coding session or wait for the idle
          threshold, review its evidence, and approve the edited entry.
        </p>
        {native && local.data ? (
          <LocalControls data={data} local={local.data} />
        ) : (
          <p>
            The web app can review shared sessions and manage mappings. Local
            Git observation requires the desktop app; GitHub OAuth is not
            required.
          </p>
        )}
        {data.repositories.map((r) => (
          <RepositoryEditor
            key={`${r.id}-${r.version}-${local.data?.repositories.find((l) => l.serverId === r.id)?.mode}`}
            data={data}
            repository={r}
            local={local.data?.repositories.find((l) => l.serverId === r.id)}
          />
        ))}
      </details>
      <section className="panel padded mt">
        <SectionHeading title="Suggested entries & activity timeline" />
        <div className="tracking-fields">
          <Field label="Approval status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="suggested">Needs review</option>
              <option value="approved">Approved</option>
              <option value="discarded">Discarded</option>
            </select>
          </Field>
        </div>
        <details className="tracking-filters">
          <summary>
            Filter by client, project, repository, branch or date
          </summary>
          <div className="tracking-fields">
            <Field label="Filter client">
              <select
                value={client}
                onChange={(e) => setClient(e.target.value)}
              >
                <option value="">All clients</option>
                {data.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Filter project">
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">All projects</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Filter repository">
              <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                <option value="">All repositories</option>
                {data.repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.alias || r.identity}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Filter branch">
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </Field>
            <Field label="From date (device time zone)">
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Through date (device time zone)">
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </div>
        </details>
      </section>
      <ErrorMessage error={q.error} />
      {q.isLoading ? (
        <p>Loading sessions…</p>
      ) : !filtered.length ? (
        <Empty
          title="No sessions in this view"
          detail="Enable Assisted tracking in the desktop app, work in an approved repository, then return here to review. Short or uncertain sessions remain in local tracking setup until you send them for review."
        />
      ) : (
        Array.from(groups, ([label, items]) => (
          <section key={label}>
            <h2 className="mt">{label}</h2>
            {items.map((s) => (
              <SessionCard
                key={`${s.id}-${s.version}`}
                s={s}
                data={data}
                sessions={sessions}
              />
            ))}
          </section>
        ))
      )}
    </>
  );
}
