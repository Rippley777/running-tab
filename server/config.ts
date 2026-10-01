import { z } from "zod";
const Env = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.url(),
  API_PORT: z.coerce.number().default(3001),
  BETTER_AUTH_SECRET: z.string().min(32),
  BILLING_MODE: z.enum(["demo", "stripe_test"]).default("demo"),
  DEMO_ENABLED: z.enum(["true", "false"]).default("false"),
});
export const config = Env.parse(process.env);
if (
  config.NODE_ENV === "production" &&
  (config.DEMO_ENABLED === "true" ||
    config.BETTER_AUTH_SECRET.startsWith("replace-"))
)
  throw new Error(
    "Production refuses demo sign-in or the example auth secret.",
  );
if (
  config.BILLING_MODE === "stripe_test" &&
  !process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
)
  throw new Error(
    "Stripe sandbox mode requires sk_test_ credentials. Live payment operation is disabled.",
  );
if (config.NODE_ENV === "production" && !config.APP_URL.startsWith("https://"))
  throw new Error("Production requires an explicit HTTPS canonical URL.");
export const demoEnabled =
  config.DEMO_ENABLED === "true" && config.NODE_ENV !== "production";
