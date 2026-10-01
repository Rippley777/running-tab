import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { post } from "../lib/api";
import { Button, Field, ErrorMessage } from "./ui";
import type { Line } from "../../shared/contracts";
type Evidence = { time_entry_id: string | null; description: string | null };
export function DescriptionAssistant({
  sources,
  lines,
  enabled,
  onUse,
}: {
  sources: Evidence[];
  lines: Line[];
  enabled: boolean;
  onUse: (id: string, text: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [useAI, setAI] = useState(false),
    [target, setTarget] = useState(lines[0]?.id ?? "");
  const m = useMutation({
    mutationFn: () =>
      post("/api/v1/descriptions", {
        entryIds: selected,
        useAI,
        confirmedSharing: useAI,
      }),
  });
  const evidence = sources.filter((s) => s.time_entry_id);
  if (!evidence.length) return null;
  return (
    <details className="description-assistant">
      <summary>Help describe this work</summary>
      <p className="fine-print">
        Select the exact reviewed notes to use. Private notes are excluded. No
        amount, rate, or invoice state can be changed here.
      </p>
      <div className="evidence-selection">
        {evidence.slice(0, 30).map((s) => (
          <label className="check-field" key={s.time_entry_id}>
            <input
              type="checkbox"
              checked={selected.includes(s.time_entry_id!)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, s.time_entry_id!]
                    : selected.filter((id) => id !== s.time_entry_id),
                )
              }
            />
            <span>{s.description || "No description"}</span>
          </label>
        ))}
      </div>
      {enabled && (
        <label className="check-field">
          <input
            type="checkbox"
            checked={useAI}
            onChange={(e) => setAI(e.target.checked)}
          />
          Share these selected notes with the configured AI provider
        </label>
      )}
      <Button
        type="button"
        kind="secondary"
        disabled={!selected.length}
        busy={m.isPending}
        onClick={() => m.mutate()}
      >
        {useAI ? "Draft with AI" : "Create template suggestions"}
      </Button>
      <ErrorMessage error={m.error} />
      {m.data && (
        <>
          <p className="fine-print">
            {m.data.provider === "openai"
              ? "AI draft · review every claim"
              : "Deterministic template · no AI used"}
          </p>
          {m.data.warnings.map((w: string) => (
            <p key={w} className="notice">
              {w}
            </p>
          ))}
          <Field label="Apply a suggestion to">
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {lines.map((l, i) => (
                <option key={l.id} value={l.id}>
                  Line {i + 1} · {l.description.slice(0, 55)}
                </option>
              ))}
            </select>
          </Field>
          {m.data.suggestions.map((s: any, n: number) => (
            <Suggestion
              key={n}
              suggestion={s}
              onUse={(text) => onUse(target, text)}
            />
          ))}
        </>
      )}
    </details>
  );
}
function Suggestion({
  suggestion,
  onUse,
}: {
  suggestion: any;
  onUse: (text: string) => void;
}) {
  const [text, setText] = useState(suggestion.description),
    [dismissed, setDismissed] = useState(false);
  return dismissed ? null : (
    <div className="description-suggestion">
      <Field label="Suggested client description">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
      </Field>
      <small>
        Evidence:{" "}
        {suggestion.sourceIds.map((s: string) => s.slice(0, 8)).join(", ")}
      </small>
      {suggestion.warnings.map((w: string) => (
        <p className="fine-print" key={w}>
          {w}
        </p>
      ))}
      <div className="button-group">
        <Button
          type="button"
          kind="secondary"
          disabled={!text.trim()}
          onClick={() => onUse(text)}
        >
          Use this description
        </Button>
        <Button type="button" kind="ghost" onClick={() => setDismissed(true)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}
