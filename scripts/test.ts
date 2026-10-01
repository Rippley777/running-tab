import pg from "pg";
import { spawnSync } from "node:child_process";
const main = process.env.DATABASE_URL;
if (!main) throw new Error("DATABASE_URL is required.");
const target = new URL(process.env.TEST_DATABASE_URL ?? main);
if (!process.env.TEST_DATABASE_URL) target.pathname = "/runningtab_test";
if (target.toString() === new URL(main).toString())
  throw new Error("Tests must use a separate PostgreSQL database.");
if (!/^[a-zA-Z0-9_]+$/.test(target.pathname.slice(1)))
  throw new Error("Invalid test database name.");
const admin = new pg.Pool({ connectionString: main });
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [
  target.pathname.slice(1),
]);
if (!exists.rowCount)
  await admin.query(`CREATE DATABASE "${target.pathname.slice(1)}"`);
await admin.end();
process.env.DATABASE_URL = target.toString();
process.env.NODE_ENV = "test";
// Domain tests never call the paid AI service, even with a configured dev .env.
delete process.env.OPENAI_API_KEY;
delete process.env.AI_MODEL;
const { migrate } = await import("./migrate.js");
const { pool } = await import("../server/db/index.js");
await migrate();
await pool.end();
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
