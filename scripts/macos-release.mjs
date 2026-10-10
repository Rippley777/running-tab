import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  atomicJson,
  exists,
  inventory,
  promote,
  recoverLock,
  recoverPromotion,
  sha256,
} from "./macos-release-store.mjs";

export const IDENTITY = "Developer ID Application: Ally Rippley (YM4H8YJWGU)";
export const TEAM = "YM4H8YJWGU";
export const TARGETS = {
  arm64: "aarch64-apple-darwin",
  x86_64: "x86_64-apple-darwin",
  universal: "universal-apple-darwin",
};
const AUTH = [
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_ID",
  "APPLE_PASSWORD",
];

export function options(args) {
  const result = { arch: "all", check: false, signOnly: false, recover: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--arch") result.arch = args[++i];
    else if (args[i] === "--check") result.check = true;
    else if (args[i] === "--sign-only") result.signOnly = true;
    else if (args[i] === "--recover") result.recover = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (result.arch !== "all" && !TARGETS[result.arch])
    throw new Error("Use --arch arm64|x86_64|universal|all");
  return result;
}

export function credentials(env, required = true) {
  const api = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"];
  const apple = ["APPLE_ID", "APPLE_PASSWORD"];
  if (api.some((key) => env[key])) {
    if (!api.every((key) => env[key]))
      throw new Error(`Incomplete API credentials. Set ${api.join(", ")}.`);
    return {
      kind: "api",
      args: [
        "--issuer",
        env.APPLE_API_ISSUER,
        "--key-id",
        env.APPLE_API_KEY,
        "--key",
        env.APPLE_API_KEY_PATH,
      ],
    };
  }
  if (apple.some((key) => env[key])) {
    if (!apple.every((key) => env[key]))
      throw new Error(
        "Set both APPLE_ID and APPLE_PASSWORD (app-specific password).",
      );
    return {
      kind: "apple-id",
      args: [
        "--apple-id",
        env.APPLE_ID,
        "--password",
        env.APPLE_PASSWORD,
        "--team-id",
        TEAM,
      ],
    };
  }
  if (required)
    throw new Error(
      "Notarization credentials missing. Set APPLE_API_ISSUER, APPLE_API_KEY and APPLE_API_KEY_PATH; see docs/MACOS_RELEASE.md.",
    );
  return null;
}

export function redact(text, env = process.env) {
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        value &&
        /PASSWORD|TOKEN|SECRET|APPLE_API_|APPLE_ID|APPLE_CERTIFICATE/.test(key),
    )
    .flatMap(([, value]) => [value, ...value.split(/\r?\n/).filter(Boolean)])
    .sort((a, b) => b.length - a.length);
  return secrets.reduce(
    (output, value) => output.split(value).join("[REDACTED]"),
    String(text),
  );
}

function runner(root, log) {
  return async (
    program,
    args,
    { env = process.env, label = basename(program) } = {},
  ) => {
    await log.write(`\n[${label}]\n`); // Never log arguments: notarytool can receive a password.
    return new Promise((resolveRun, reject) => {
      const child = spawn(program, args, {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const consume = (stream) => {
        let pending = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) void log.write(`${redact(line, env)}\n`);
        });
        stream.on("end", () => {
          if (pending) void log.write(`${redact(pending, env)}\n`);
        });
      };
      consume(child.stdout);
      consume(child.stderr);
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolveRun(output)
          : reject(
              new Error(
                `${label} failed (${code}). ${redact(output, env).slice(-1800)}`,
              ),
            ),
      );
    });
  };
}

export function verifySignature(details, runtime = true) {
  if (
    !details.includes(`Authority=${IDENTITY}`) ||
    !details.includes(`TeamIdentifier=${TEAM}`)
  )
    throw new Error(
      "Artifact does not have the required Developer ID signature/team.",
    );
  if (!/^Timestamp=.+$/m.test(details))
    throw new Error("Secure signing timestamp is missing.");
  if (runtime && !/flags=.*\bruntime\b/.test(details))
    throw new Error("Hardened Runtime is missing.");
}

export function verifyArchitectures(output, arch) {
  const actual = output.trim().split(/\s+/).sort();
  const expected = (arch === "universal" ? ["arm64", "x86_64"] : [arch]).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Architecture mismatch: expected ${expected}, got ${actual}`,
    );
}

export function assertProduction(manifest) {
  if (
    !manifest.targets.length ||
    manifest.targets.some(
      (target) =>
        !target.signed ||
        !target.notarized ||
        !target.stapled ||
        !target.gatekeeper ||
        !target.dmg,
    )
  )
    throw new Error(
      "Refusing to promote an incomplete or unnotarized release.",
    );
}

async function candidates(path) {
  if (!(await exists(path))) return [];
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (
      /\.(app|dmg|zip|exe|msi|AppImage|deb|rpm|tar\.gz|tar\.xz)$/i.test(
        entry.name,
      ) &&
      !/^rw\./.test(entry.name)
    )
      result.push(child);
    else if (
      entry.isDirectory() &&
      !["target", "node_modules", "work", "cache", "archive"].includes(
        entry.name,
      )
    )
      result.push(...(await candidates(child)));
    else if (entry.isFile() && /manifest.*\.json$/.test(entry.name))
      result.push(child);
  }
  return result;
}

// Only selected distributables enter history; never copy target/ or compilation caches.
export async function archiveArtifacts(sources, destination, copy = cp) {
  await mkdir(destination, { recursive: true });
  const records = [];
  for (const [index, source] of [...new Set(sources)].entries()) {
    const parent = join(destination, String(index).padStart(4, "0"));
    await mkdir(parent);
    const target = join(parent, basename(source));
    const fingerprint = async (path) =>
      (await lstat(path)).isDirectory()
        ? inventory(path)
        : [
            {
              sha256: await sha256(path),
              mode: (await lstat(path)).mode & 0o777,
            },
          ];
    const before = await fingerprint(source);
    await copy(source, target, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      force: false,
      errorOnExist: true,
    });
    if (
      JSON.stringify(before) !== JSON.stringify(await fingerprint(target)) ||
      JSON.stringify(before) !== JSON.stringify(await fingerprint(source))
    )
      throw new Error(
        `Archive verification failed for ${source}; originals retained.`,
      );
    records.push({
      source,
      archived: `${basename(parent)}/${basename(source)}`,
      entries: before,
    });
  }
  await atomicJson(join(destination, "archive-manifest.json"), {
    verified: true,
    createdAt: new Date().toISOString(),
    records,
  });
  return records;
}

async function preflight(root, opts, run) {
  const errors = [];
  const check = async (name, fn) => {
    try {
      const value = await fn();
      console.log(`  ✓ ${name}`);
      return value;
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
      console.log(`  ✗ ${name}: ${redact(error.message)}`);
      return null;
    }
  };
  const config = await check("Tauri configuration", async () => {
    const data = JSON.parse(
      await readFile(join(root, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const overlay = JSON.parse(
      await readFile(join(root, "src-tauri/tauri.release.conf.json"), "utf8"),
    );
    if (
      overlay.bundle.macOS.signingIdentity !== IDENTITY ||
      !overlay.bundle.macOS.hardenedRuntime
    )
      throw new Error(
        "Release overlay must require Developer ID and Hardened Runtime.",
      );
    return data;
  });
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await check("macOS host", async () => {
    if (process.platform !== "darwin")
      throw new Error(
        "Use a macOS host; existing Windows/Linux commands remain separate.",
      );
  });
  await check("Node and npm", async () => {
    const minimum = Number(pkg.engines?.node?.match(/>=\s*(\d+)/)?.[1] || 20);
    if (Number(process.versions.node.split(".")[0]) < minimum)
      throw new Error(`Node >=${minimum} required by this repository.`);
    await run("npm", ["--version"]);
  });
  await check("Xcode tools", async () => {
    await run("xcode-select", ["-p"]);
    for (const tool of ["clang", "notarytool", "stapler"])
      await run("xcrun", ["--find", tool]);
    await run("hdiutil", ["help"]);
  });
  const cli = join(root, "node_modules/.bin/tauri");
  await check("Installed Tauri 2 CLI", async () => {
    const version = await run(cli, ["--version"]);
    if (!/tauri-cli 2\./.test(version))
      throw new Error(
        "Run npm ci with the committed lockfile; Tauri 2 required.",
      );
  });
  const metadata = await check(
    "Rust/Cargo workspace and versions",
    async () => {
      const output = await run("cargo", [
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--no-deps",
        "--locked",
        "--format-version",
        "1",
      ]);
      const data = JSON.parse(output.slice(output.indexOf("{")));
      const desktop = data.packages.find(
        (p) => resolve(p.manifest_path) === join(root, "src-tauri/Cargo.toml"),
      );
      if (
        !desktop ||
        !config ||
        desktop.version !== config.version ||
        pkg.version !== config.version
      )
        throw new Error(
          "package.json, desktop Cargo package and Tauri versions must match.",
        );
      return { ...data, desktop };
    },
  );
  const arches = opts.arch === "all" ? Object.keys(TARGETS) : [opts.arch];
  await check("Rust macOS targets", async () => {
    const installed = (await run("rustup", ["target", "list", "--installed"]))
      .trim()
      .split(/\s+/);
    const needed = new Set(
      arches.flatMap((arch) =>
        arch === "universal"
          ? [TARGETS.arm64, TARGETS.x86_64]
          : [TARGETS[arch]],
      ),
    );
    const missing = [...needed].filter((target) => !installed.includes(target));
    if (missing.length)
      throw new Error(
        `Run in this repository: rustup target add ${missing.join(" ")}`,
      );
  });
  await check("Developer ID identity", async () => {
    const identities = await run("security", [
      "find-identity",
      "-v",
      "-p",
      "codesigning",
    ]);
    if (!identities.includes(`"${IDENTITY}"`))
      throw new Error(
        `Install the certificate AND its private key in an unlocked signing keychain: ${IDENTITY}`,
      );
    if (
      process.env.APPLE_SIGNING_IDENTITY &&
      process.env.APPLE_SIGNING_IDENTITY !== IDENTITY
    )
      throw new Error(
        "APPLE_SIGNING_IDENTITY conflicts with the required identity.",
      );
    if (process.env.APPLE_TEAM_ID && process.env.APPLE_TEAM_ID !== TEAM)
      throw new Error("APPLE_TEAM_ID conflicts with YM4H8YJWGU.");
  });
  let auth = null;
  if (!opts.signOnly)
    auth = await check("Notarization credentials", async () => {
      const result = credentials(process.env);
      if (result.kind === "api") {
        const key = await readFile(process.env.APPLE_API_KEY_PATH, "utf8");
        if (!key.includes("BEGIN PRIVATE KEY"))
          throw new Error(
            "APPLE_API_KEY_PATH must point to the downloaded App Store Connect .p8 key.",
          );
        if ((await lstat(process.env.APPLE_API_KEY_PATH)).mode & 0o077)
          throw new Error(
            "Private key permissions too broad; run chmod 600 on the .p8 file.",
          );
      }
      // Authentication is checked against Apple; configured strings alone are not success.
      await run(
        "xcrun",
        ["notarytool", "history", ...result.args, "--output-format", "json"],
        { label: "Notary authentication" },
      );
      return result;
    });
  else
    console.log(
      "  ! Signing-only candidate: notarization and Gatekeeper approval will remain pending.",
    );
  if ((await exists(join(root, "brand.json"))) && pkg.scripts?.["brand:sync"])
    await check("Brand metadata", async () => {
      const brand = JSON.parse(
        await readFile(join(root, "brand.json"), "utf8"),
      );
      if (
        brand.name !== config?.productName ||
        brand.version !== config?.version ||
        brand.identifier !== config?.identifier
      )
        throw new Error(
          "Run npm run brand:sync, then reconcile Cargo/package versions.",
        );
    });
  if (errors.length)
    throw new Error(
      `Preflight failed (${errors.length} checks). No builds started.`,
    );
  return { config, metadata, arches, cli, auth };
}

async function verifyApp(app, arch, production, run, config) {
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  verifySignature(await run("codesign", ["-d", "--verbose=4", app]));
  const executable = (
    await run("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleExecutable",
      join(app, "Contents/Info.plist"),
    ])
  ).trim();
  if (basename(executable) !== executable)
    throw new Error("Invalid bundle executable.");
  for (const [key, expected] of [
    ["CFBundleIdentifier", config.identifier],
    ["CFBundleShortVersionString", config.version],
  ]) {
    const actual = (
      await run("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        join(app, "Contents/Info.plist"),
      ])
    ).trim();
    if (actual !== expected)
      throw new Error(
        `Bundle ${key} mismatch: expected ${expected}, got ${actual}`,
      );
  }
  verifyArchitectures(
    await run("lipo", ["-archs", join(app, "Contents/MacOS", executable)]),
    arch,
  );
  if (production) {
    await run("xcrun", ["stapler", "validate", app]);
    await run("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  }
}

async function verifyDmg(
  dmg,
  expectedApp,
  arch,
  production,
  run,
  output,
  config,
) {
  await run("hdiutil", ["verify", dmg]);
  await run("codesign", ["--verify", "--strict", "--verbose=2", dmg]);
  verifySignature(await run("codesign", ["-d", "--verbose=4", dmg]), false);
  if (production) {
    await run("xcrun", ["stapler", "validate", dmg]);
    await run("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmg,
    ]);
  }
  const mount = join(output, `.mount-${randomUUID()}`);
  await mkdir(mount);
  try {
    await run("hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mount,
      dmg,
    ]);
    const embedded = join(mount, basename(expectedApp));
    await verifyApp(embedded, arch, production, run, config);
    // Compare signed contents, including the stapled ticket, with the loose application.
    if (
      JSON.stringify(await inventory(embedded)) !==
      JSON.stringify(await inventory(expectedApp))
    )
      throw new Error("DMG contents do not match the verified application.");
  } finally {
    // Never remove a mounted directory; a failed detach retains it for manual recovery.
    await run("hdiutil", ["detach", mount]);
    await rm(mount, { recursive: true });
  }
}

export async function main(
  args = process.argv.slice(2),
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const opts = options(args);
  const output = join(root, "macos-releases");
  if (opts.recover) {
    await recoverLock(output);
    const unlock = await acquireLock(output);
    try {
      await recoverPromotion(output);
    } finally {
      await unlock();
    }
    return;
  }
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  await mkdir(join(output, "logs"), { recursive: true });
  const logPath = join(output, "logs", `${id}.log`);
  const handle = await open(logPath, "wx", 0o600);
  let writes = Promise.resolve();
  const log = {
    write(text) {
      writes = writes.then(() => handle.write(text));
      return writes;
    },
    async close() {
      await writes;
      await handle.close();
    },
  };
  const run = runner(root, log);
  console.log(
    `${basename(root)}: ${opts.check ? "preflight" : opts.signOnly ? "signing-only candidate" : "production release"}; log ${logPath}`,
  );
  let unlock;
  try {
    const { config, metadata, arches, cli, auth } = await preflight(
      root,
      opts,
      run,
    );
    if (opts.check) return;
    unlock = await acquireLock(output);
    for (const legacy of [
      "builds/.release-lock",
      "builds/.release.lock",
      "releases/.release-lock.json",
    ]) {
      if (await exists(join(root, legacy)))
        throw new Error(
          `Legacy release lock exists: ${legacy}. Finish or recover that release before proceeding.`,
        );
    }
    await recoverPromotion(output);
    const targetDir = metadata.target_directory;
    // Discover artifacts once BEFORE any compilation, including legacy native outputs.
    const sources = [];
    for (const current of [
      "macos-releases/current",
      "builds/current",
      "releases/current",
    ])
      sources.push(...(await candidates(join(root, current))));
    const profiles = [join(targetDir, "release"), join(targetDir, "debug")];
    if (await exists(targetDir))
      for (const entry of await readdir(targetDir, { withFileTypes: true })) {
        if (entry.isDirectory() && /-(apple|pc|unknown)-/.test(entry.name))
          profiles.push(
            join(targetDir, entry.name, "release"),
            join(targetDir, entry.name, "debug"),
          );
      }
    for (const profile of profiles) {
      sources.push(...(await candidates(join(profile, "bundle"))));
      for (const binary of metadata.desktop.targets.filter((target) =>
        target.kind.includes("bin"),
      ))
        for (const ext of ["", ".exe"]) {
          const path = join(profile, binary.name + ext);
          if (await exists(path)) sources.push(path);
        }
    }
    const history = join(output, "archive", id);
    const archived = await archiveArtifacts(
      sources,
      history,
      async (source, target) => {
        await run("/usr/bin/ditto", ["--rsrc", "--extattr", source, target], {
          label: "Preserve previous artifact",
        });
      },
    );
    console.log(
      `  Archived and verified ${archived.length} previous artifacts: ${history}`,
    );
    const staged = join(output, "staging", id);
    await mkdir(staged, { recursive: true });
    const manifest = {
      schema: 1,
      product: config.productName,
      version: config.version,
      identifier: config.identifier,
      createdAt: new Date().toISOString(),
      identity: IDENTITY,
      mode: opts.signOnly ? "signed-candidate" : "production",
      targets: [],
    };
    const env = {
      ...process.env,
      APPLE_SIGNING_IDENTITY: IDENTITY,
      APPLE_TEAM_ID: TEAM,
      CARGO_TARGET_DIR: targetDir,
      CI: "true",
    };
    if (opts.signOnly) for (const key of AUTH) delete env[key];
    else if (auth.kind === "api") {
      delete env.APPLE_ID;
      delete env.APPLE_PASSWORD;
    }
    for (const arch of arches) {
      const triple = TARGETS[arch];
      console.log(
        `  ${arch}: compiling and signing${opts.signOnly ? "" : ", notarizing application"}…`,
      );
      const bundle = join(targetDir, triple, "release/bundle");
      // Archives were verified above; remove only the selected old bundle output.
      await rm(bundle, { recursive: true, force: true });
      await run(
        cli,
        [
          "build",
          "--target",
          triple,
          "--bundles",
          "app,dmg",
          "--config",
          "src-tauri/tauri.release.conf.json",
          "--",
          "--locked",
        ],
        { env, label: `Tauri ${arch}` },
      );
      const apps = (await candidates(join(bundle, "macos"))).filter((path) =>
        path.endsWith(".app"),
      );
      const dmgs = (await candidates(join(bundle, "dmg"))).filter((path) =>
        path.endsWith(".dmg"),
      );
      if (apps.length !== 1 || dmgs.length !== 1)
        throw new Error(`Expected one .app and one .dmg for ${arch}.`);
      const app = apps[0],
        dmg = dmgs[0];
      await verifyApp(app, arch, !opts.signOnly, run, config);
      let submission = null;
      if (!opts.signOnly) {
        console.log(`  ${arch}: notarizing and stapling DMG…`);
        const response = await run(
          "xcrun",
          [
            "notarytool",
            "submit",
            dmg,
            ...auth.args,
            "--wait",
            "--output-format",
            "json",
          ],
          { label: "DMG notarization" },
        );
        const receipt = JSON.parse(response);
        if (receipt.status !== "Accepted")
          throw new Error(
            `Apple rejected DMG notarization (${receipt.status}); inspect the submission in notarytool history.`,
          );
        submission = receipt.id;
        await run("xcrun", ["stapler", "staple", dmg]);
      }
      await verifyDmg(dmg, app, arch, !opts.signOnly, run, output, config);
      const destination = join(staged, arch);
      await mkdir(destination);
      const copiedApp = join(destination, basename(app));
      await run("/usr/bin/ditto", ["--rsrc", "--extattr", app, copiedApp], {
        label: "Preserve signed application",
      });
      await verifyApp(copiedApp, arch, !opts.signOnly, run, config);
      if (
        JSON.stringify(await inventory(app)) !==
        JSON.stringify(await inventory(copiedApp))
      )
        throw new Error("Staged application copy failed verification.");
      const filename = `${config.productName.replace(/[^a-zA-Z0-9]+/g, "")}_${config.version}_${arch}.dmg`;
      await cp(dmg, join(destination, filename));
      if ((await sha256(dmg)) !== (await sha256(join(destination, filename))))
        throw new Error("Staged DMG copy failed verification.");
      manifest.targets.push({
        arch,
        triple,
        signed: true,
        notarized: !opts.signOnly,
        stapled: !opts.signOnly,
        gatekeeper: !opts.signOnly,
        dmg: `${arch}/${filename}`,
        app: `${arch}/${basename(app)}`,
        submission,
        files: await inventory(destination),
      });
      await atomicJson(join(staged, "manifest.json"), manifest);
      console.log(
        `  ✓ ${arch}: signature, timestamp, Hardened Runtime, architecture and DMG verified${opts.signOnly ? "; notarization pending" : "; notarization and Gatekeeper passed"}`,
      );
    }
    if (opts.signOnly) {
      const candidate = join(output, "candidates", id);
      await mkdir(dirname(candidate), { recursive: true });
      await rename(staged, candidate);
      console.log(
        `Signed candidate only: ${candidate}. Production current was not replaced.`,
      );
    } else {
      assertProduction(manifest);
      await promote(output, staged, manifest);
      console.log(`Production release ready: ${join(output, "current")}`);
    }
  } finally {
    if (unlock) await unlock();
    await log.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(redact(error.message));
    process.exitCode = 1;
  });
