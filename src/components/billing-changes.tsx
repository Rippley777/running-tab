import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { parseMoney, money, hours } from "../lib/format";
import { Button, Modal, Field, ErrorMessage } from "./ui";
export function BillingChangeForm({
  kind,
  record,
  onClose,
}: {
  kind: "milestone" | "bucket" | "agreement";
  record: any;
  onClose: () => void;
}) {
  const cache = useQueryClient(),
    [key] = useState(() => crypto.randomUUID()),
    [error, setError] = useState<unknown>();
  const m = useMutation({
    mutationFn: (data: unknown) =>
      post(
        `/api/v1/${kind === "milestone" ? "milestones" : kind === "bucket" ? "buckets" : "agreements"}/${record.id}/${kind === "milestone" ? "split" : kind === "bucket" ? "adjust" : "terms"}`,
        data,
        key,
      ),
    onSuccess: async () => {
      await cache.invalidateQueries();
      onClose();
    },
  });
  return (
    <Modal
      title={
        kind === "milestone"
          ? "Divide this milestone"
          : kind === "bucket"
            ? "Adjust funded hours"
            : "Change future support terms"
      }
      description={
        kind === "milestone"
          ? `The original milestone keeps the remainder of ${money(record.amount, true)}. The agreed project total stays fixed.`
          : kind === "bucket"
            ? `Current balance: ${hours(record.balance)}. This adds an auditable ledger entry; it never records cash or creates a charge.`
            : "The fee changes from the next billing date after today. Existing and missed earlier periods retain their terms. No proration."
      }
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            m.mutate(
              kind === "milestone"
                ? {
                    title: String(f.get("title")),
                    amount: parseMoney(String(f.get("amount"))),
                  }
                : kind === "bucket"
                  ? {
                      seconds: Math.round(Number(f.get("hours")) * 3600),
                      reason: String(f.get("reason")),
                    }
                  : {
                      fee: parseMoney(String(f.get("amount"))),
                      endDate: String(f.get("end")) || null,
                    },
            );
          } catch (err) {
            setError(err);
          }
        }}
      >
        {kind === "milestone" && (
          <Field label="New milestone name">
            <input name="title" required maxLength={200} />
          </Field>
        )}
        {kind === "bucket" ? (
          <>
            <Field
              label="Hours to add or remove"
              hint="Use a negative number to remove unused coverage."
            >
              <input
                name="hours"
                type="number"
                step="0.25"
                min="-1000"
                max="1000"
                required
              />
            </Field>
            <Field label="Reason for this adjustment">
              <textarea
                name="reason"
                required
                minLength={5}
                maxLength={500}
                rows={3}
              />
            </Field>
            <p className="fine-print">
              Additional complimentary hours do not create new service revenue.
              Adjustments require a recent sign-in.
            </p>
          </>
        ) : (
          <Field
            label={
              kind === "milestone"
                ? "New milestone amount · USD"
                : "New period fee · USD"
            }
          >
            <input
              name="amount"
              required
              inputMode="decimal"
              pattern="[0-9]+(\.[0-9]{1,2})?"
              defaultValue={
                kind === "agreement" ? (record.fee / 100).toFixed(2) : ""
              }
            />
          </Field>
        )}
        {kind === "agreement" && (
          <Field label="Stop generating periods on · optional">
            <input
              type="date"
              name="end"
              defaultValue={record.end_date?.slice(0, 10) ?? ""}
            />
          </Field>
        )}
        <ErrorMessage error={m.error ?? error} />
        <footer className="form-footer">
          <Button kind="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={m.isPending}>
            {kind === "milestone"
              ? "Create milestone"
              : kind === "bucket"
                ? "Record adjustment"
                : "Schedule these terms"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
