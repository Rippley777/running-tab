import pg from "pg";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const url = new URL(process.env.DATABASE_URL!),
  name = `runningtab_seedcheck_${Date.now()}`;
const admin = new pg.Pool({ connectionString: url.toString() });
await admin.query(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
const env = {
  ...process.env,
  DATABASE_URL: url.toString(),
  NODE_ENV: "development",
  BILLING_MODE: "demo",
  DEMO_ENABLED: "true",
};
let database: pg.Pool | undefined;
try {
  for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    process.stdout.write(result.stdout);
  }
  database = new pg.Pool({ connectionString: url.toString() });
  const counts = (
    await database.query(
      "SELECT (SELECT count(*) FROM client)::int clients,(SELECT count(*) FROM project)::int projects,(SELECT count(*) FROM time_entry)::int entries,(SELECT count(*) FROM invoice)::int invoices",
    )
  ).rows[0];
  assert.equal(counts.clients, 5);
  assert.equal(counts.projects, 8);
  assert.ok(counts.entries >= 40);
  const mismatches = (
    await database.query(
      "SELECT i.id FROM invoice i WHERE i.paid_amount<>(SELECT COALESCE(sum(p.amount),0) FROM payment p WHERE p.invoice_id=i.id)",
    )
  ).rows;
  assert.equal(mismatches.length, 0);
  const negative = (
    await database.query(
      "SELECT bucket_id FROM retainer_ledger_entry GROUP BY bucket_id HAVING sum(seconds)<0",
    )
  ).rows;
  assert.equal(negative.length, 0);
  console.log("Fresh migrated seed reconciles:", counts);
} finally {
  await database?.end();
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}
