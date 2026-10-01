import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { sql, db, pool, rows, type Context } from "../server/db/index.js";
import {
  createWorkspace,
  createClient,
  createProject,
} from "../server/domain/catalog.js";
import { issueDevice } from "../server/auth.js";
if (
  process.env.DEMO_ENABLED !== "true" ||
  process.env.NODE_ENV === "production"
)
  throw new Error("CLI acceptance requires local demo configuration.");
const id = `cli-test-${randomUUID()}`,
  email = `${id}@runningtab.test`;
await db.execute(
  sql`INSERT INTO "user"(id,name,email,"emailVerified") VALUES(${id},'CLI Acceptance',${email},true)`,
);
const w = await createWorkspace(
  { id, email },
  {
    name: "CLI Acceptance Studio",
    businessEmail: email,
    timezone: "UTC",
    defaultRate: 15000,
  },
);
const ctx: Context = {
  workspaceId: w.id,
  userId: id,
  verifiedAt: new Date(),
  scopes: ["read", "write", "financial"],
};
const c = await createClient(ctx, {
    name: "CLI Client",
    email: "cli@client.test",
  }),
  p = await createProject(ctx, {
    clientId: c.id,
    name: "Git fixture",
    model: "hourly",
  });
const credential = await issueDevice(ctx, "Acceptance CLI", "cli");
const cwd = await mkdtemp(path.resolve(".local/cli-fixture-"));
const run = (cmd: string, args: string[], env = process.env) => {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
try {
  run("git", ["init", "--initial-branch=main"]);
  run("git", ["config", "user.email", "fixture@example.test"]);
  run("git", ["config", "user.name", "Local Fixture"]);
  await writeFile(
    path.join(cwd, "fixture.txt"),
    "Synthetic local fixture. Its contents must never be uploaded.\n",
  );
  run("git", ["add", "fixture.txt"]);
  run("git", ["commit", "-m", "Add local fixture"]);
  run("git", [
    "remote",
    "add",
    "origin",
    "https://example.test/studio/context-fixture.git",
  ]);
  const env = {
    ...process.env,
    RUNNING_TAB_TOKEN: credential.token,
    RUNNING_TAB_API_URL: "http://localhost:3001",
    RUNNING_TAB_APP_URL: "http://localhost:1420",
  };
  const cli = (args: string[]) =>
    run(path.resolve("target/debug/tab"), args, env);
  assert.equal(JSON.parse(cli(["status"])).timer, null);
  assert.ok(JSON.parse(cli(["projects"])).some((x: any) => x.id === p.id));
  cli(["link", "--project", p.id, "--yes"]);
  const preview = JSON.parse(cli(["context", "--since", "2026-01-01"]));
  assert.equal(preview.identity, "example.test/studio/context-fixture");
  assert.equal(preview.commits.length, 1);
  assert.equal(preview.commits[0].subject, undefined);
  assert.ok(!JSON.stringify(preview).includes(cwd));
  cli([
    "context",
    "--since",
    "2026-01-01",
    "--include-subjects",
    "--upload",
    "--yes",
  ]);
  cli(["start", "--description", "Intentional CLI work"]);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  cli(["stop"]);
  assert.equal(JSON.parse(cli(["status"])).timer, null);
  assert.equal(
    (await rows(sql`SELECT id FROM time_entry WHERE workspace_id=${w.id}`))
      .length,
    1,
  );
  assert.equal(
    (
      await rows(
        sql`SELECT id FROM activity_evidence WHERE workspace_id=${w.id}`,
      )
    ).length,
    1,
  );
  console.log(
    "CLI acceptance passed: project lookup, explicit link, preview, opt-in upload, start/status/stop. No source code or local path uploaded.",
  );
} finally {
  await db.execute(
    sql`UPDATE device_credential SET revoked_at=now() WHERE id=${credential.id}`,
  );
  await pool.end();
}
