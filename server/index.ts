import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/index.js";
await pool.query("SELECT 1 FROM schema_migration LIMIT 1").catch(() => {
  throw new Error(
    "PostgreSQL is unavailable or unmigrated. Start PostgreSQL and run npm run db:migrate.",
  );
});
const app = await createApp();
await app.listen({
  port: config.API_PORT,
  host: config.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1",
});
console.log(
  `Running Tab API ready at http://127.0.0.1:${config.API_PORT} (${config.BILLING_MODE}; live payments disabled)`,
);
const stop = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
