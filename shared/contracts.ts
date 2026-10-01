import { z } from "zod";
export const Id = z.uuid();
export const Cents = z.number().int().min(0).max(100_000_000);
export const ISO = z.iso.datetime({ offset: true });
export const TimerAction = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    projectId: Id,
    taskId: Id.nullish(),
    description: z.string().max(2000).default(""),
    billable: z.boolean().default(true),
  }),
  z.object({
    action: z.literal("switch"),
    projectId: Id,
    taskId: Id.nullish(),
    description: z.string().max(2000).default(""),
    billable: z.boolean().default(true),
    version: z.number().int(),
  }),
  z.object({
    action: z.enum(["pause", "resume", "stop"]),
    version: z.number().int(),
  }),
]);
export const ManualEntry = z.object({
  projectId: Id,
  taskId: Id.nullish(),
  description: z.string().max(2000).default(""),
  privateNote: z.string().max(4000).default(""),
  startedAt: ISO,
  endedAt: ISO,
  billable: z.boolean().default(true),
  rateOverride: Cents.optional(),
  acknowledgeOverlap: z.boolean().default(false),
});
export const ClientInput = z.object({
  currency: z.literal("USD").default("USD"),
  name: z.string().trim().min(1).max(120),
  email: z.email(),
  address: z.string().max(2000).default(""),
  defaultRate: Cents.nullish(),
  paymentTerms: z.number().int().min(0).max(365).default(14),
  color: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#9fab9a"),
});
export const ProjectInput = z.object({
  currency: z.literal("USD").default("USD"),
  clientId: Id,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  model: z.enum(["hourly", "fixed", "prepaid", "support"]),
  rate: Cents.nullish(),
  fee: Cents.default(0),
  estimateSeconds: z.number().int().positive().nullish(),
  costRate: Cents.nullish(),
  targetRate: Cents.nullish(),
  color: z
    .string()
    .regex(/^#[a-fA-F0-9]{6}$/)
    .default("#b6ac86"),
});
export const WorkspaceInput = z.object({
  currency: z.literal("USD").default("USD"),
  name: z.string().trim().min(1).max(120),
  businessEmail: z.email(),
  businessAddress: z.string().max(2000).default(""),
  timezone: z.string().refine((s) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: s });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid IANA time zone"),
  defaultRate: Cents,
  costRate: Cents.nullish(),
  targetRate: Cents.nullish(),
  capacitySeconds: z.number().int().positive().nullish(),
  paymentTerms: z.number().int().min(0).max(365).default(14),
  weekStart: z.number().int().min(0).max(6).default(1),
  roundingMinutes: z
    .union([
      z.literal(0),
      z.literal(1),
      z.literal(5),
      z.literal(6),
      z.literal(10),
      z.literal(15),
      z.literal(30),
    ])
    .default(0),
  aiEnabled: z.boolean().default(false),
  digestEnabled: z.boolean().default(false),
});
export const DraftInput = z.object({
  currency: z.literal("USD").default("USD"),
  clientId: Id,
  timeEntryIds: z.array(Id).max(500).default([]),
  milestoneIds: z.array(Id).max(50).default([]),
  periodIds: z.array(Id).max(50).default([]),
  bucketIds: z.array(Id).max(50).default([]),
  groupBy: z.enum(["project", "task", "date"]).default("project"),
});
export const InvoiceEdit = z.object({
  revision: z.number().int().positive(),
  memo: z.string().max(4000),
  dueAt: ISO.optional(),
  poReference: z.string().max(120).default(""),
  discount: Cents.default(0),
  taxBps: z.number().int().min(0).max(10000).default(0),
  lines: z
    .array(
      z.object({ id: Id, description: z.string().trim().min(1).max(2000) }),
    )
    .min(1)
    .max(500),
});
export const ApprovalInput = z.object({
  revision: z.number().int().positive(),
  action: z.enum(["send", "charge"]),
  confirmedTotal: Cents,
});
export const EntryPatch = z.object({
  version: z.number().int(),
  description: z.string().max(2000).optional(),
  reviewed: z.boolean().optional(),
  delete: z.boolean().optional(),
  overageDecision: z.enum(["invoice", "write_off"]).optional(),
  splitSeconds: z.number().int().positive().optional(),
  startedAt: ISO.optional(),
  endedAt: ISO.optional(),
  billable: z.boolean().optional(),
  acknowledgeOverlap: z.boolean().default(false),
});
export const IngestInput = z.object({
  identity: z
    .string()
    .max(250)
    .regex(/^[\w.-]+\/[\w./-]+$/),
  commits: z
    .array(
      z.object({
        ref: z.string().regex(/^[a-f0-9]{7,64}$/),
        occurredAt: ISO,
        subject: z.string().max(250).optional(),
        branch: z.string().max(120).optional(),
      }),
    )
    .max(100),
});
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
  }),
});
export const TimerSchema = z
  .object({
    id: Id,
    project_id: Id,
    project_name: z.string(),
    client_name: z.string(),
    state: z.enum(["running", "paused"]),
    started_at: z.string(),
    segment_started_at: z.string().nullable(),
    accumulated_seconds: z.number().int(),
    description: z.string(),
    version: z.number().int(),
    billable: z.boolean(),
  })
  .passthrough();
export type Timer = z.infer<typeof TimerSchema>;
export const TimerResponse = z.object({
  timer: TimerSchema.nullable(),
  serverTime: z.string(),
});
export type Model = "hourly" | "fixed" | "prepaid" | "support";
export type Client = {
  id: string;
  name: string;
  email: string;
  address: string;
  color: string;
  default_rate: number | null;
  payment_terms: number | null;
  archived_at: string | null;
  outstanding: number;
  project_count: number;
};
export type Project = {
  id: string;
  client_id: string;
  client_name: string;
  name: string;
  description: string;
  color: string;
  model: Model;
  rate: number | null;
  fee: number;
  status: string;
  actual_seconds: number;
  billable_seconds: number;
  estimate_seconds: number | null;
  cost_rate: number | null;
  target_rate: number | null;
  cash: number;
  service_cash: number;
  eligible_value: number;
  realized_rate: number | null;
  projected_rate: number | null;
  underquote: number;
  contribution: number | null;
  contribution_margin: number | null;
  covered_seconds: number;
};
export type Entry = {
  id: string;
  project_id: string;
  project_name: string;
  client_name: string;
  color: string;
  description: string;
  private_note: string;
  started_at: string;
  ended_at: string;
  actual_seconds: number;
  billed_seconds: number;
  rate: number;
  billable: boolean;
  treatment: string;
  reviewed: boolean;
  covered_seconds: number;
  version: number;
  invoice_id: string | null;
  overlap: boolean;
  task_title: string | null;
};
export type Invoice = {
  id: string;
  client_id: string;
  client_name: string;
  number: string;
  revision: number;
  approval_state: string;
  issuance_state: string;
  collection_state: string;
  subtotal: number;
  discount: number;
  tax_bps: number;
  tax: number;
  total: number;
  paid_amount: number;
  due_at: string;
  created_at: string;
  issued_at: string | null;
  memo: string;
  po_reference: string;
  provider: string;
  provider_url: string | null;
  provider_pdf: string | null;
  business_snapshot: { name: string; email: string; address: string };
  client_snapshot: { name: string; email: string; address: string };
};
export type Line = {
  id: string;
  invoice_id: string;
  project_id: string;
  description: string;
  quantity_seconds: number;
  unit_rate: number;
  amount: number;
  source_kind: string;
  service_start: string | null;
  service_end: string | null;
};
export type Bucket = {
  id: string;
  project_id: string;
  project_name: string;
  client_name: string;
  name: string;
  purchased_seconds: number;
  price: number;
  activated_at: string | null;
  expires_at: string | null;
  balance: number;
  consumed: number;
  invoice_id: string | null;
};
export type Payment = {
  id: string;
  invoice_id: string;
  client_name: string;
  number: string;
  amount: number;
  service_amount: number;
  fee: number | null;
  provider: string;
  received_at: string;
};
export type Workspace = {
  id: string;
  name: string;
  business_email: string;
  business_address: string;
  timezone: string;
  default_rate: number;
  cost_rate: number | null;
  target_rate: number | null;
  capacity_seconds: number | null;
  payment_terms: number;
  rounding_minutes: number;
  ai_enabled: boolean;
  digest_enabled: boolean;
  week_start: number;
  demo: boolean;
};
export type Snapshot = {
  workspace: Workspace;
  user: { name: string; email: string };
  timer: Timer | null;
  serverTime: string;
  clients: Client[];
  projects: Project[];
  entries: Entry[];
  invoices: Invoice[];
  buckets: Bucket[];
  payments: Payment[];
  notifications: {
    id: string;
    title: string;
    detail: string;
    target: string;
    kind: string;
  }[];
  suggestions: {
    id: string;
    project_id: string;
    project_name: string;
    reason: string;
    subject: string | null;
    commit_ref: string;
    status: string;
  }[];
  milestones: {
    id: string;
    project_id: string;
    client_id: string;
    title: string;
    amount: number;
    ready: boolean;
    invoice_id: string | null;
  }[];
  periods: {
    id: string;
    project_id: string;
    client_id: string;
    project_name: string;
    starts_on: string;
    ends_on: string;
    fee: number;
    invoice_id: string | null;
  }[];
  agreements: {
    id: string;
    project_id: string;
    project_name: string;
    fee: number;
    frequency: string;
    anchor: string;
    timezone: string;
    status: string;
    next_dates: string[];
    end_date: string | null;
    next_terms: { fee: number; effective_on: string } | null;
  }[];
  tasks: {
    id: string;
    project_id: string;
    title: string;
    completed_at: string | null;
  }[];
  repositories: {
    id: string;
    project_id: string;
    identity: string;
    alias: string;
  }[];
  account: {
    provider: string;
    ready: boolean;
    account_id: string;
    disconnected_at: string | null;
  } | null;
  operations: {
    id: string;
    invoice_id: string;
    state: string;
    action: string;
    error_code: string | null;
    created_at: string;
  }[];
  closes: {
    id: string;
    starts_on: string;
    ends_on: string;
    step: number;
    notes: string;
  }[];
  metrics: {
    from: string;
    to: string;
    actual_seconds: number;
    billable_seconds: number;
    eligible_value: number;
    issued_value: number;
    outstanding: number;
    cash: number;
    refunds: number;
    fees: number;
    utilization: number | null;
    capacity_utilization: number | null;
    daily: { date: string; billable: number; nonbillable: number }[];
  };
  mode: "demo" | "stripe_test";
};
