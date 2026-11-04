/**
 * #13990 — the published image stored the app twice. The `runner-base` stage
 * COPY'd the standalone build as root and then ran `RUN chown -R node:node /app`.
 * On an overlay filesystem a chown rewrites every touched file into a new
 * layer, duplicating the standalone tree in the image.
 *
 * Fix: every COPY into /app in `runner-base` carries `--chown=node:node`, so the
 * files are written with the right owner in their own layer, and the recursive
 * chown is gone. `/app` itself (created root-owned by `WORKDIR /app` in the
 * `base` stage) and `/app/data` still get a non-recursive chown in the shared
 * `runner-config` stage so both runtime images can write without a volume.
 *
 * Image size needs measurement on a built image; this guards the mechanism
 * so the duplicate layer does not creep back in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf-8");
const lines = dockerfile.split("\n");

/** Non-comment instruction lines of a named stage (FROM to next FROM). */
function stage(name: string): string[] {
  const start = lines.findIndex(
    (line) => /^FROM\s+\S+\s+AS\s+(\S+)/i.exec(line.trim())?.[1] === name
  );
  assert.ok(start >= 0, `Dockerfile must declare a \`${name}\` stage`);
  const after = lines.slice(start + 1).findIndex((line) => /^FROM\s+/i.test(line.trim()));
  const end = after === -1 ? lines.length : start + 1 + after;
  return lines.slice(start, end).filter((line) => !line.trim().startsWith("#"));
}

test("#13990 runner-base copies the app with --chown=node:node instead of a second chown layer", () => {
  const runnerBase = stage("runner-base");

  const copiesFromBuilder = runnerBase.filter((l) => /^COPY\b.*--from=builder\b/.test(l));
  assert.ok(
    copiesFromBuilder.length >= 3,
    "runner-base must COPY the standalone build, better-sqlite3 and healthcheck.mjs from the builder"
  );
  for (const line of copiesFromBuilder) {
    assert.match(line, /--chown=node:node\b/, `COPY must set node ownership at copy time: ${line}`);
  }

  assert.ok(
    !runnerBase.some((l) => /^RUN\b.*chown\s+-R\b/.test(l)),
    "runner-base must not run a recursive chown: it rewrites the whole standalone tree into a duplicate layer"
  );
});

test("#13990 both runners inherit writable /app and /app/data", () => {
  const runnerConfig = stage("runner-config");
  assert.ok(
    runnerConfig.some((line) =>
      /^RUN\b.*mkdir -p \/app\/data\s*&&\s*chown node:node \/app \/app\/data\b/.test(line)
    ),
    "runner-config must create /app/data and chown /app and /app/data (non-recursively) to node"
  );
});
