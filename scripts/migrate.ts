import { readdir, readFile } from "node:fs/promises";
import { pool } from "../server/db/index.js";
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(72682221)");
    await c.query(
      "CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const exists = await c.query(
        "SELECT 1 FROM schema_migration WHERE name=$1",
        [file],
      );
      if (!exists.rowCount) {
        await c.query(await readFile(`migrations/${file}`, "utf8"));
        await c.query("INSERT INTO schema_migration(name) VALUES($1)", [file]);
        console.log(`Applied ${file}`);
      }
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
if (process.argv[1]?.endsWith("migrate.ts")) {
  await migrate();
  await pool.end();
}
