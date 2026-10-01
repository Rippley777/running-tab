import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Play,
  Pause,
  Square,
  ArrowRightLeft,
  Clock3,
  ArrowUpRight,
} from "lucide-react";
import type { Snapshot, Timer } from "../../shared/contracts";
import { TimerResponse } from "../../shared/contracts";
import { post, navigate } from "../lib/api";
import { duration } from "../lib/format";
import { Button, ErrorMessage } from "./ui";
export function useElapsed(timer: Timer | null, serverTime: string) {
  const [now, setNow] = useState(() => +new Date(serverTime));
  useEffect(() => {
    const offset = +new Date(serverTime) - Date.now();
    const id = setInterval(() => setNow(Date.now() + offset), 1000);
    return () => clearInterval(id);
  }, [serverTime]);
  return timer
    ? timer.accumulated_seconds +
        (timer.state === "running" && timer.segment_started_at
          ? Math.max(
              0,
              Math.floor((now - +new Date(timer.segment_started_at)) / 1000),
            )
          : 0)
    : 0;
}
export function useTimer(_data: Snapshot) {
  const q = useQueryClient();
  return useMutation({
    mutationFn: async (payload: unknown) =>
      TimerResponse.parse(await post("/api/v1/timer", payload)),
    onSuccess: () => q.invalidateQueries({ queryKey: ["workspace"] }),
  });
}
export function TimerCard({ data }: { data: Snapshot }) {
  const timer = data.timer;
  const elapsed = useElapsed(timer, data.serverTime);
  const m = useTimer(data);
  const [project, setProject] = useState(
    timer?.project_id ??
      data.projects.find((p) => p.status === "active")?.id ??
      "",
  );
  const [description, setDescription] = useState(""),
    [task, setTask] = useState(""),
    [billable, setBillable] = useState(true);
  return (
    <section
      className={`timer-card ${timer ? "running" : ""}`}
      aria-label="Work timer"
    >
      <div className="timer-card-top">
        <span className="eyebrow">
          <span
            className={`live-dot ${timer?.state === "running" ? "live" : ""}`}
          />
          {timer?.state === "running"
            ? "ON THE CLOCK"
            : timer
              ? "TAKE A BREATHER"
              : "MAKE TIME FOR GOOD WORK"}
        </span>
        <span className="keyboard-hint">⌘ ⇧ T</span>
      </div>
      <div className="timer-main">
        <div className="timer-context">
          <span className="client-kicker">
            {timer?.client_name ?? "A little focus goes a long way."}
          </span>
          <h2>{timer?.project_name ?? "What are you working on?"}</h2>
          {timer ? (
            <p>
              {timer.description ||
                "Add a description when you review this work."}
            </p>
          ) : (
            <input
              className="timer-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Give this session a little context…"
              aria-label="Timer description"
            />
          )}
        </div>
        <div className="timer-face">
          <span className="timer-digits">{duration(elapsed)}</span>
          <span className="timer-state">
            {timer?.state === "running"
              ? "Keeps time across devices"
              : timer
                ? "Paused · your time is safe"
                : "Ready when you are"}
          </span>
        </div>
      </div>
      <div className="timer-card-bottom">
        <select
          aria-label="Timer project"
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setTask("");
          }}
        >
          <option value="" disabled>
            Select a project
          </option>
          {data.projects
            .filter((p) => p.status === "active")
            .map((p) => (
              <option value={p.id} key={p.id}>
                {p.client_name} / {p.name}
              </option>
            ))}
        </select>
        <div className="button-group">
          {timer && project !== timer.project_id && (
            <Button
              kind="secondary"
              busy={m.isPending}
              onClick={() =>
                m.mutate({
                  action: "switch",
                  projectId: project,
                  description,
                  billable,
                  taskId: task || null,
                  version: timer.version,
                })
              }
            >
              <ArrowRightLeft size={15} />
              Switch
            </Button>
          )}
          {timer ? (
            <>
              <Button
                kind="secondary"
                busy={m.isPending}
                aria-label={
                  timer.state === "running" ? "Pause timer" : "Resume timer"
                }
                onClick={() =>
                  m.mutate({
                    action: timer.state === "running" ? "pause" : "resume",
                    version: timer.version,
                  })
                }
              >
                {timer.state === "running" ? (
                  <Pause size={15} />
                ) : (
                  <Play size={15} />
                )}
              </Button>
              <Button
                busy={m.isPending}
                onClick={() =>
                  m.mutate({ action: "stop", version: timer.version })
                }
              >
                <Square size={12} fill="currentColor" />
                Stop timer
              </Button>
            </>
          ) : (
            <Button
              busy={m.isPending}
              disabled={!project}
              onClick={() =>
                m.mutate({
                  action: "start",
                  projectId: project,
                  description,
                  billable,
                  taskId: task || null,
                })
              }
            >
              <Play size={14} fill="currentColor" />
              Start timer
            </Button>
          )}
        </div>
      </div>
      {!timer && (
        <div className="timer-options">
          <label className="check-field">
            <input
              type="checkbox"
              checked={billable}
              onChange={(e) => setBillable(e.target.checked)}
            />
            Billable work
          </label>
          {data.tasks.some((t) => t.project_id === project) && (
            <select
              aria-label="Timer task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            >
              <option value="">No task</option>
              {data.tasks
                .filter((t) => t.project_id === project && !t.completed_at)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
          )}
        </div>
      )}
      {elapsed > 12 * 3600 && (
        <button className="timer-warning" onClick={() => navigate("/time")}>
          <Clock3 size={14} />A long session. Take a moment to check the end
          time.
          <ArrowUpRight size={14} />
        </button>
      )}
      <ErrorMessage error={m.error} />
    </section>
  );
}
export function TimerRail({ data }: { data: Snapshot }) {
  const elapsed = useElapsed(data.timer, data.serverTime);
  const m = useTimer(data);
  const t = data.timer;
  if (!t)
    return (
      <div className="timer-rail">
        <span className="live-dot" />
        <span>No timer running</span>
        <button className="text-button" onClick={() => navigate("/today")}>
          Start something
          <Play size={12} />
        </button>
      </div>
    );
  return (
    <div className="timer-rail">
      <span className={`live-dot ${t.state === "running" ? "live" : ""}`} />
      <div className="rail-context">
        <strong>{t.project_name}</strong>
        <span>{t.client_name}</span>
      </div>
      <b className="mono">{duration(elapsed)}</b>
      <button
        className="icon-button"
        disabled={m.isPending}
        aria-label={t.state === "running" ? "Pause timer" : "Resume timer"}
        onClick={() =>
          m.mutate({
            action: t.state === "running" ? "pause" : "resume",
            version: t.version,
          })
        }
      >
        {t.state === "running" ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <button
        className="icon-button stop"
        disabled={m.isPending}
        aria-label="Stop timer"
        onClick={() => m.mutate({ action: "stop", version: t.version })}
      >
        <Square size={12} />
      </button>
      {m.error && (
        <span role="alert" className="rail-error">
          {m.error.message}
        </span>
      )}
    </div>
  );
}
