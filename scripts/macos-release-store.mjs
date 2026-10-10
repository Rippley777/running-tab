import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function atomicJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx");
  try {
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

// Read links without following them. This preserves .app framework links and empty folders.
export async function inventory(root, relative = "") {
  const entries = [];
  for (const name of (await readdir(join(root, relative))).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    const path = join(root, file);
    const stat = await lstat(path);
    const base = { file, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink())
      entries.push({ ...base, type: "symlink", target: await readlink(path) });
    else if (stat.isDirectory()) {
      entries.push({ ...base, type: "directory" });
      entries.push(...(await inventory(root, file)));
    } else if (stat.isFile())
      entries.push({
        ...base,
        type: "file",
        size: stat.size,
        sha256: await sha256(path),
      });
    else throw new Error(`Unsupported special file: ${path}`);
  }
  return entries;
}

export async function acquireLock(builds) {
  await mkdir(builds, { recursive: true });
  const path = join(builds, ".release-lock");
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another release owns macos-releases/.release-lock. After a crashed release, run node scripts/macos-release.mjs --recover; never remove a live lock.",
        { cause: error },
      );
    throw error;
  }
  await atomicJson(join(path, "owner.json"), {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  });
  return async () => rm(path, { recursive: true });
}

export async function recoverLock(builds) {
  const path = join(builds, ".release-lock");
  if (!(await exists(path))) return;
  const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
  if (
    owner.host !== hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0
  )
    throw new Error(
      "Cannot prove lock owner is inactive on this host. Inspect macos-releases/.release-lock/owner.json manually.",
    );
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") {
      await rm(path, { recursive: true });
      return;
    }
    throw error;
  }
  throw new Error(
    `Release process ${owner.pid} is still running. Lock retained.`,
  );
}

// A two-rename swap is portable across Windows/POSIX. A durable journal covers the gap.
// On interruption, recover the previous directory rather than trusting a partial promotion.
export async function recoverPromotion(builds) {
  const journal = join(builds, ".promotion.json");
  if (!(await exists(journal))) return;
  const data = JSON.parse(await readFile(journal, "utf8"));
  const previous = resolve(builds, data.previous);
  if (!/^\.previous-[0-9a-f-]+$/.test(data.previous) || previous === builds)
    throw new Error("Invalid promotion journal; manual recovery required.");
  const current = join(builds, "current");
  if (await exists(previous)) {
    if (await exists(current))
      await rename(current, join(builds, `.interrupted-${randomUUID()}`));
    await rename(previous, current);
  } else if (!data.hadCurrent && (await exists(current))) {
    await rename(current, join(builds, `.interrupted-${randomUUID()}`));
  }
  if (await exists(join(current, "manifest.json")))
    await atomicJson(
      join(builds, "release-manifest.json"),
      JSON.parse(await readFile(join(current, "manifest.json"), "utf8")),
    );
  else await rm(join(builds, "release-manifest.json"), { force: true });
  await rm(journal);
}

export async function promote(
  builds,
  staged,
  manifest,
  { renameDirectory = rename, writeJson = atomicJson } = {},
) {
  const current = join(builds, "current");
  const previous = `.previous-${randomUUID()}`;
  const hadCurrent = await exists(current);
  // Record the old root index, including legacy metadata that is not a release manifest.
  const index = join(builds, "release-manifest.json");
  const oldIndex = (await exists(index)) ? await readFile(index) : null;
  await atomicJson(join(builds, ".promotion.json"), { previous, hadCurrent });
  try {
    if (hadCurrent) await renameDirectory(current, join(builds, previous));
    await renameDirectory(staged, current);
    await writeJson(index, manifest);
    // Commit marker: removing the journal means the directory and index are both published.
    await rm(join(builds, ".promotion.json"));
  } catch (error) {
    if (await exists(join(builds, previous))) {
      if (await exists(current))
        await rename(current, join(builds, `.failed-${randomUUID()}`));
      await rename(join(builds, previous), current);
    } else if (!hadCurrent && (await exists(current))) {
      await rename(current, join(builds, `.failed-${randomUUID()}`));
    }
    if (oldIndex) await writeFile(index, oldIndex);
    else await rm(index, { force: true });
    await rm(join(builds, ".promotion.json"), { force: true });
    throw error;
  }
  // Previous builds have already been archived and verified. Cleanup cannot undo success.
  await rm(join(builds, previous), { recursive: true, force: true }).catch(
    (error) => console.warn(`Previous directory retained: ${error.message}`),
  );
}
