import { z } from "zod";
import { Id, ISO, ManualEntry } from "./contracts.js";
export const BranchRule = z.object({
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\w./*?-]+$/),
  projectId: Id.nullable(),
  taskId: Id.nullish(),
  billable: z.boolean(),
});
export const RepositorySettings = z.object({
  projectId: Id.nullable(),
  taskId: Id.nullish(),
  billable: z.boolean(),
  trackingEnabled: z.boolean(),
  rules: z.array(BranchRule).max(100),
  version: z.number().int().positive(),
});
export type Rule = z.infer<typeof BranchRule>;
export function resolveMapping(
  branch: string,
  defaults: Omit<Rule, "pattern">,
  rules: Rule[],
) {
  const matches = rules.filter((r) =>
    new RegExp(
      "^" +
        r.pattern
          .split("")
          .map((c) =>
            c === "*"
              ? ".*"
              : c === "?"
                ? "."
                : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("") +
        "$",
    ).test(branch),
  );
  const exact = matches.filter((r) => !/[?*]/.test(r.pattern));
  const candidates = exact.length ? exact : matches;
  // Equal precedence is deliberately ambiguous, even if mappings happen to agree.
  if (candidates.length > 1)
    return {
      projectId: null,
      taskId: null,
      billable: false,
      reason: "Ambiguous branch rules. Reassign before approval.",
    };
  const rule = candidates[0];
  return {
    ...(rule ?? defaults),
    reason: rule
      ? `Branch rule: ${rule.pattern}`
      : "Repository default; confirm this branch's billing context.",
  };
}
export function safeMetadata(text: string) {
  return Array.from(text, (c) =>
    c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c,
  )
    .join("")
    .replace(/(?:sk|pk)_(?:live|test)_[\w]+/g, "[redacted]")
    .replace(/(?:ghp_|github_pat_|sk-)[\w-]+/g, "[redacted]")
    .replace(
      /(?:password|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi,
      "[redacted credential]",
    )
    .replace(/https?:\/\/\S+/gi, "[link omitted]")
    .trim();
}
export type DescriptionStyle =
  "concise" | "professional" | "detailed" | "technical";
export function describeDevelopment(
  branch: string,
  style: DescriptionStyle = "professional",
  note = "",
) {
  if (note.trim()) return safeMetadata(note).slice(0, 2000);
  const subject = safeMetadata(branch)
    .replace(/^(feature|feat|fix|bugfix|refactor|chore|hotfix)\//, "")
    .replace(/[-_]+/g, " ")
    .slice(0, 150);
  if (!subject || ["main", "master", "HEAD"].includes(subject))
    return "Development work — add a note describing the work performed.";
  if (style === "technical")
    return `Development activity on branch ${safeMetadata(branch)}; scope and outcome to be confirmed.`;
  if (style === "concise") return `Work on ${subject}.`;
  if (style === "detailed")
    return `Development work related to ${subject}. Review the session evidence and add confirmed changes or testing details.`;
  return `Worked on ${subject}; review and confirm the scope of work.`;
}
export const SessionEvidence = z.object({
  at: ISO,
  kind: z.enum([
    "file_activity",
    "branch_changed",
    "commit_detected",
    "idle",
    "interrupted",
    "simultaneous",
    "started",
    "completed",
  ]),
  detail: z.string().max(250).default(""),
});
export const SessionUpload = z.object({
  id: Id,
  repositoryId: Id,
  branch: z.string().max(120),
  startedAt: ISO,
  endedAt: ISO,
  inferredSeconds: z.number().int().min(0).max(604800),
  mergeSeconds: z.number().int().min(30).max(7200).default(300),
  evidence: z.array(SessionEvidence).max(500),
});
// Recheck metadata estimates at the trust boundary; timestamps alone never imply hours.
export function supportedSeconds(
  events: z.infer<typeof SessionEvidence>[],
  mergeSeconds: number,
) {
  if (events.some((e) => e.kind === "simultaneous")) return 0;
  const groups = new Map<number, Set<string>>();
  for (const e of events)
    if (
      ["file_activity", "commit_detected", "branch_changed"].includes(e.kind)
    ) {
      const at = +new Date(e.at);
      const group = groups.get(at) ?? new Set<string>();
      group.add(e.kind);
      groups.set(at, group);
    }
  let previous: { at: number; file: boolean } | undefined,
    seconds = 0;
  for (const [at, kinds] of [...groups].sort((a, b) => a[0] - b[0])) {
    const file = kinds.has("file_activity") && !kinds.has("branch_changed");
    const gap = previous ? (at - previous.at) / 1000 : 0;
    if (file && previous?.file && gap > 0 && gap <= mergeSeconds)
      seconds += Math.floor(gap);
    previous = { at, file };
  }
  return seconds;
}
export const SessionApproval = ManualEntry.extend({
  version: z.number().int().positive(),
  description: z.string().trim().min(1).max(2000),
});
export type DevelopmentSession = {
  id: string;
  repository_id: string;
  alias: string;
  identity: string;
  branch: string;
  project_id: string | null;
  task_id: string | null;
  billable: boolean;
  project_name: string | null;
  client_id: string | null;
  client_name: string | null;
  started_at: string;
  ended_at: string;
  inferred_seconds: number;
  observed_seconds: number;
  adjusted_seconds: number | null;
  proposed_started_at: string | null;
  confidence: string;
  reason: string;
  description: string;
  evidence: z.infer<typeof SessionEvidence>[];
  status: string;
  version: number;
  time_entry_id: string | null;
  approved_at: string | null;
};
