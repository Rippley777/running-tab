// A private, isolated fixture server; never sends mail or accesses payment providers.
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const main = process.env.DATABASE_URL;
if (!main) throw new Error("DATABASE_URL is required");
const target = new URL(process.env.TEST_DATABASE_URL ?? main);
if (!process.env.TEST_DATABASE_URL) target.pathname = "/runningtab_test";
if (
  target.toString() === new URL(main).toString() ||
  !target.pathname.endsWith("_test")
)
  throw new Error(
    "Browser tests require a separate _test database. Run npm test to initialize it.",
  );
process.env.DATABASE_URL = target.toString();
process.env.NODE_ENV = "test";
process.env.APP_URL = "http://localhost:3141";
process.env.API_PORT = "3141";
process.env.BILLING_MODE = "demo";
process.env.DEMO_ENABLED = "false";
delete process.env.OPENAI_API_KEY;
delete process.env.AI_MODEL;
const { migrate } = await import("../../scripts/migrate.js");
await migrate();
const { db, sql, pool } = await import("../../server/db/index.js");
const { createWorkspace } = await import("../../server/domain/catalog.js");
const { issueDevice } = await import("../../server/auth.js");
const userId = `browser-${randomUUID()}`,
  email = `${userId}@example.test`;
await db.execute(
  sql`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${userId},'Developer',${email},true)`,
);
const w = await createWorkspace(
  { id: userId, email },
  {
    name: "Development acceptance",
    businessEmail: email,
    timezone: "America/Chicago",
    defaultRate: 7500,
  },
);
const credential = await issueDevice(
  {
    userId,
    workspaceId: w.id,
    verifiedAt: new Date(),
    scopes: ["read", "write", "financial"],
  },
  "Isolated browser test",
  "desktop",
);
await mkdir(".local", { recursive: true });
await writeFile(
  ".local/development-e2e.json",
  JSON.stringify({ token: credential.token, workspaceId: w.id }),
  { mode: 0o600 },
);
const { createApp } = await import("../../server/app.js");
const app = await createApp();
await app.listen({ host: "127.0.0.1", port: 3141 });
const stop = async () => {
  await app.close();
  await db.execute(
    sql`UPDATE device_credential SET revoked_at=now() WHERE id=${credential.id}`,
  );
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
