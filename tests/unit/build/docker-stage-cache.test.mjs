import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
const stages = new Map();
for (const match of dockerfile.matchAll(
  /^FROM (\S+) AS (\S+)\n([\s\S]*?)(?=^FROM |$(?![\s\S]))/gm
)) {
  stages.set(match[2], { parent: match[1], body: match[3] });
}

function dependencies(name, seen = new Set()) {
  if (seen.has(name) || !stages.has(name)) return seen;
  seen.add(name);
  const { parent, body } = stages.get(name);
  dependencies(parent, seen);
  for (const match of body.matchAll(/^COPY .*--from=(\S+)/gm)) dependencies(match[1], seen);
  return seen;
}

test("CLI installation is cached independently of the application build", () => {
  const install = [...stages].find(([, stage]) => stage.body.includes("npm install -g --no-audit"));
  assert.ok(install);
  const ancestors = dependencies(install[0]);
  assert.ok(!ancestors.has("builder"), "source changes must not invalidate CLI installation");
  assert.ok(!ancestors.has("runner-base"), "CLI dependencies must precede application assembly");
  assert.ok(dependencies("runner-cli").has(install[0]));
  assert.ok(dependencies("runner-cli").has("builder"), "CLI image must still contain the app");
});

test("dependency install is reusable without compiling the app", () => {
  assert.ok(stages.get("deps")?.body.includes("npm ci"));
  assert.ok(!stages.get("deps").body.includes("COPY . ./"));
  assert.equal(stages.get("builder").parent, "deps");
});
