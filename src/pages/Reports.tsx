import { useState } from "react";
import { ArrowDownToLine, Info, ArrowUpRight } from "lucide-react";
import type { Snapshot } from "../../shared/contracts";
import { money, hours } from "../lib/format";
import { exportCsv, navigate } from "../lib/api";
import {
  Button,
  PageHeader,
  SectionHeading,
  Modal,
  Link,
} from "../components/ui";
import { Metric, ProjectTable, WeekChart } from "./Work";
export function ReportsPage({ data }: { data: Snapshot }) {
  const [definitions, setDefinitions] = useState(false);
  const m = data.metrics;
  const low = data.projects.filter((p) => p.underquote > 0);
  return (
    <>
      <PageHeader
        eyebrow="KNOW WHAT YOUR WORK EARNS"
        title="The honest numbers."
        description={`${m.from} through ${m.to} (exclusive) · ${data.workspace.timezone}`}
        actions={
          <>
            <Button kind="secondary" onClick={() => setDefinitions(true)}>
              <Info size={15} />
              How it’s calculated
            </Button>
            <Button kind="secondary" onClick={() => exportCsv("payments")}>
              <ArrowDownToLine size={15} />
              Export cash records
            </Button>
          </>
        }
      />
      <div className="metrics-strip">
        <Metric
          label="CASH COLLECTED"
          value={money(m.cash)}
          sub="Confirmed receipts · selected period"
          onClick={() => navigate("/billing")}
        />
        <Metric
          label="INVOICES ISSUED"
          value={money(m.issued_value)}
          sub="Issued totals · selected period"
          onClick={() => navigate("/billing")}
        />
        <Metric
          label="UNBILLED HOURLY VALUE"
          value={money(m.eligible_value)}
          sub="Unallocated work starting in period"
          onClick={() => navigate("/time")}
        />
        <Metric
          label="TIME UTILIZATION"
          value={
            m.utilization === null ? "—" : `${Math.round(m.utilization * 100)}%`
          }
          sub={`${hours(m.billable_seconds)} billable / ${hours(m.actual_seconds)} total`}
          onClick={() => navigate("/time")}
        />
      </div>
      <div className="reports-grid">
        <section className="panel padded">
          <SectionHeading
            title="Where the time went"
            action="Open time records"
            onAction={() => navigate("/time")}
          />
          <WeekChart data={data} />
          <dl className="details-list">
            <div>
              <dt>Billable project effort</dt>
              <dd>{hours(m.billable_seconds)}</dd>
            </div>
            <div>
              <dt>Non-billable effort</dt>
              <dd>{hours(m.actual_seconds - m.billable_seconds)}</dd>
            </div>
            <div>
              <dt>Capacity utilization</dt>
              <dd>
                {m.capacity_utilization === null
                  ? "Weekly capacity needed"
                  : `${Math.round(m.capacity_utilization * 100)}%`}
              </dd>
            </div>
          </dl>
          <p className="fine-print">
            Covered project effort counts toward billable utilization, without
            becoming an hourly invoice.
          </p>
        </section>
        <section className="panel padded">
          <SectionHeading
            title="Follow the money"
            action="Open billing"
            onAction={() => navigate("/billing")}
          />
          <div className="money-flow">
            <div>
              <span>Confirmed cash receipts</span>
              <strong>{money(m.cash, true)}</strong>
            </div>
            <div>
              <span>Recorded refunds</span>
              <strong>−{money(m.refunds, true)}</strong>
            </div>
            <div>
              <span>Known processing fees</span>
              <strong>−{money(m.fees, true)}</strong>
            </div>
            <div className="flow-total">
              <span>Cash after known refunds & fees</span>
              <strong>{money(m.cash - m.refunds - m.fees, true)}</strong>
            </div>
          </div>
          <p className="fine-print">
            Cash can include taxes and prepaid purchases. It is not the same as
            earned service revenue. Unknown provider fees are excluded.
          </p>
          <Button kind="ghost" onClick={() => exportCsv("adjustments")}>
            Export adjustments
            <ArrowUpRight size={14} />
          </Button>
        </section>
      </div>
      {low.map((p) => (
        <div className="insight" key={p.id}>
          <span className="eyebrow">A USEFUL OBSERVATION</span>
          <h2>{p.name} took more of you than planned.</h2>
          <p>
            This {money(p.fee)} project took {hours(p.actual_seconds)}.{" "}
            {p.status === "completed"
              ? `Collected service value works out to ${money(p.realized_rate ?? 0)}/hour.`
              : "The project is still in progress."}{" "}
            Your target is {money(p.target_rate ?? 0)}/hour.
          </p>
          <Link to={`/projects/${p.id}`} className="text-button">
            Look at the work behind it
            <ArrowUpRight size={15} />
          </Link>
        </div>
      ))}
      <section className="panel mt">
        <SectionHeading
          title="Which work is working for you?"
          aside="Project lifetime · all effort"
        />
        <ProjectTable
          projects={data.projects.filter((p) => p.status !== "archived")}
        />
      </section>
      <section className="panel mt padded">
        <SectionHeading
          title="Estimated contribution"
          aside="Project lifetime"
        />
        {data.projects.map((p) => (
          <div className="contribution-row" key={p.id}>
            <Link to={`/projects/${p.id}`}>{p.name}</Link>
            <span>
              {p.cost_rate === null
                ? "Cost rate needed"
                : `${money(p.cost_rate)}/h estimated labor`}
            </span>
            <strong
              className={
                p.contribution !== null && p.contribution < 0
                  ? "warning-text"
                  : ""
              }
            >
              {p.contribution === null ? "—" : money(p.contribution)}
            </strong>
            <span>
              {p.contribution_margin === null
                ? "—"
                : `${Math.round(p.contribution_margin * 100)}%`}
            </span>
          </div>
        ))}
      </section>
      {definitions && (
        <Modal
          wide
          title="Numbers you can explain"
          description="Financial calculations use integer cents and exact rational arithmetic on the server."
          onClose={() => setDefinitions(false)}
        >
          <dl className="formula-list">
            <dt>Collected service value per hour</dt>
            <dd>
              Net collected service amount attributed to completed work ÷ all
              project hours, including non-billable effort. Project lifetime
              scope. Taxes excluded.
            </dd>
            <dt>Projected fixed-price hourly rate</dt>
            <dd>
              Agreed net project fee ÷ estimated total hours at completion. This
              is a projection, not cash or realized revenue.
            </dd>
            <dt>Underquote amount</dt>
            <dd>
              max(0, target hourly rate × actual total project hours − agreed
              net fee).
            </dd>
            <dt>Estimated contribution</dt>
            <dd>
              Applicable collected net service amount − estimated labor cost −
              known attributable processing fees. Unknown costs are not
              invented.
            </dd>
            <dt>Time utilization</dt>
            <dd>
              Billable tracked seconds ÷ all tracked seconds in the selected
              period. Intervals are clipped to the period and split at local
              midnights, including DST.
            </dd>
            <dt>Prepaid utilization</dt>
            <dd>
              Funded purchase value is analytically allocated as hours are
              consumed. Consumption never creates a second cash receipt.
            </dd>
            <dt>Rounding</dt>
            <dd>
              Default: none. If enabled, each entry rounds up to the selected
              increment. Each source amount rounds half-up to the nearest cent,
              then grouped line amounts are added exactly.
            </dd>
          </dl>
        </Modal>
      )}
    </>
  );
}
