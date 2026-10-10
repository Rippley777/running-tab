import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY,
  TEAM,
  archiveArtifacts,
  assertProduction,
  credentials,
  options,
  redact,
  verifyArchitectures,
  verifySignature,
} from "./macos-release.mjs";
import {
  atomicJson,
  inventory,
  promote,
  recoverPromotion,
} from "./macos-release-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "macos-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("production requires complete credentials, preferring API keys", () => {
  assert.throws(() => credentials({}), /missing/);
  assert.throws(
    () =>
      credentials({
        APPLE_API_KEY: "id",
        APPLE_ID: "email",
        APPLE_PASSWORD: "password",
      }),
    /Incomplete/,
  );
  assert.equal(
    credentials({
      APPLE_API_KEY: "id",
      APPLE_API_ISSUER: "issuer",
      APPLE_API_KEY_PATH: "/outside/repo/key.p8",
    }).kind,
    "api",
  );
  assert.equal(
    credentials({ APPLE_ID: "email", APPLE_PASSWORD: "password" }).kind,
    "apple-id",
  );
});
test("redacts credentials without logging argument vectors", () => {
  assert.equal(
    redact("secret-key-line", {
      APPLE_API_PRIVATE_KEY: "header\nsecret-key-line\nfooter",
    }),
    "[REDACTED]",
  );
  assert.equal(
    redact("password-value api-secret certificate", {
      APPLE_PASSWORD: "password-value",
      APPLE_API_KEY: "api-secret",
      APPLE_CERTIFICATE: "certificate",
    }),
    "[REDACTED] [REDACTED] [REDACTED]",
  );
});
test("signature must have Developer ID, correct team, secure timestamp and runtime", () => {
  const good = `Authority=${IDENTITY}\nTeamIdentifier=${TEAM}\nTimestamp=Oct 2, 2026\nCodeDirectory flags=0x10000(runtime)`;
  verifySignature(good);
  for (const bad of [
    good.replace(TEAM, "OTHER"),
    good.replace("Timestamp=", "Signed Time="),
    good.replace("runtime", "none"),
    "Signature=adhoc",
  ])
    assert.throws(() => verifySignature(bad));
});
test("universal requires both real slices and options fail closed", () => {
  verifyArchitectures("x86_64 arm64\n", "universal");
  assert.throws(() => verifyArchitectures("arm64", "universal"));
  assert.throws(() => options(["--arch", "bogus"]));
  assert.throws(() => options(["--unsigned"]));
  assert.deepEqual(options([]).arch, "all");
});
test("unnotarized candidates cannot be promoted as production", () => {
  const target = {
    signed: true,
    notarized: true,
    stapled: true,
    gatekeeper: true,
    dmg: "app.dmg",
  };
  assertProduction({ targets: [target] });
  for (const field of ["signed", "notarized", "stapled", "gatekeeper", "dmg"])
    assert.throws(() =>
      assertProduction({ targets: [{ ...target, [field]: false }] }),
    );
  assert.throws(() => assertProduction({ targets: [] }));
});
test("archive preserves app contents, modes and symlinks, without caches", async (t) => {
  const root = await fixture(t),
    app = join(root, "Test.app"),
    archive = join(root, "archive");
  await mkdir(join(app, "Contents"), { recursive: true });
  await writeFile(join(app, "Contents/executable"), "binary", { mode: 0o755 });
  await symlink("executable", join(app, "Contents/link"));
  await writeFile(join(root, "compiler-cache"), "do not archive");
  const records = await archiveArtifacts([app, app], archive);
  assert.equal(records.length, 1);
  assert.deepEqual(
    await inventory(app),
    await inventory(join(archive, "0000/Test.app")),
  );
  assert.equal(
    (await readFile(join(archive, "archive-manifest.json"), "utf8")).includes(
      "compiler-cache",
    ),
    false,
  );
});
test("corrupted archive aborts and retains original", async (t) => {
  const root = await fixture(t),
    original = join(root, "old.dmg");
  await writeFile(original, "original");
  await assert.rejects(
    archiveArtifacts(
      [original],
      join(root, "archive"),
      async (source, target, opts) => {
        await cp(source, target, opts);
        await writeFile(target, "corrupt");
      },
    ),
    /verification failed/,
  );
  assert.equal(await readFile(original, "utf8"), "original");
});
test("failed promotion restores previous release and index", async (t) => {
  const root = await fixture(t),
    staged = join(root, "staging");
  await mkdir(join(root, "current"));
  await mkdir(staged);
  await writeFile(join(root, "current/old.dmg"), "old");
  await atomicJson(join(root, "release-manifest.json"), { version: "old" });
  await assert.rejects(
    promote(
      root,
      staged,
      { version: "new" },
      {
        writeJson: async () => {
          throw new Error("disk full");
        },
      },
    ),
    /disk full/,
  );
  assert.equal(await readFile(join(root, "current/old.dmg"), "utf8"), "old");
  assert.deepEqual(
    JSON.parse(await readFile(join(root, "release-manifest.json"), "utf8")),
    { version: "old" },
  );
});
test("interrupted promotion recovers previous directory", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".previous-abcd"));
  await mkdir(join(root, "current"));
  await writeFile(join(root, ".previous-abcd/old.dmg"), "old");
  await atomicJson(join(root, ".promotion.json"), {
    previous: ".previous-abcd",
    hadCurrent: true,
  });
  await recoverPromotion(root);
  assert.equal(await readFile(join(root, "current/old.dmg"), "utf8"), "old");
});
