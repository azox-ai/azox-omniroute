import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
const stages = new Map();
let current;
for (const instruction of dockerfile
  .replace(/\\\n\s*/g, " ")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))) {
  const from = /^FROM\s+(\S+)\s+AS\s+(\S+)/i.exec(instruction);
  if (from) {
    current = { parent: from[1], instructions: [] };
    stages.set(from[2], current);
  } else if (current) {
    current.instructions.push(instruction);
  }
}

function ancestors(name) {
  const result = [];
  while (stages.has(name)) {
    assert.ok(!result.includes(name), `circular Docker stage dependency: ${name}`);
    result.push(name);
    name = stages.get(name).parent;
  }
  return result;
}

test("Docker disables webpack cache only in the build stage with an opt-in override", () => {
  const builder = stages.get("builder").instructions;
  assert.ok(builder.includes("ARG OMNIROUTE_BUILD_WEBPACK_CACHE=0"));
  assert.ok(
    builder.includes('ENV OMNIROUTE_BUILD_WEBPACK_CACHE="${OMNIROUTE_BUILD_WEBPACK_CACHE}"')
  );
  for (const name of ancestors("runner-cli")) {
    assert.ok(
      !stages
        .get(name)
        .instructions.some((line) => /^(ARG|ENV) OMNIROUTE_BUILD_WEBPACK_CACHE/.test(line)),
      `${name} must not inherit the build-only cache flag`
    );
  }
});

test("CLI installation depends only on runtime configuration, not application output", () => {
  const cliTools = stages.get("cli-tools");
  assert.ok(cliTools, "install CLI dependencies in a separate stage");
  const dependencies = ancestors("cli-tools");
  assert.ok(dependencies.includes("base"), "CLI stage must retain patched npm and OS base");
  assert.ok(!dependencies.includes("runner-base"));
  assert.ok(!dependencies.includes("builder"));
  for (const dependency of dependencies) {
    assert.ok(
      !stages.get(dependency).instructions.some((line) => /^COPY\b/i.test(line)),
      `${dependency} must not COPY source before installing CLI dependencies`
    );
  }
  assert.ok(
    cliTools.instructions.some((line) => /^RUN\b.*apt-get install\b.*docker\.io\b/.test(line)),
    "CLI stage must install system tools"
  );
  assert.ok(
    cliTools.instructions.some((line) => /^RUN\b.*npm install -g\b.*@openai\/codex\b/.test(line)),
    "CLI stage must install global CLI tools"
  );
});

test("CLI image inherits runtime settings and copies application once after tools", () => {
  const configuration = stages.get("runner-config");
  const runner = stages.get("runner-cli");
  assert.ok(configuration, "share runtime settings without a source COPY");
  assert.ok(runner, "runner-cli stage must exist");
  assert.equal(runner.parent, "cli-tools");
  assert.ok(ancestors("runner-cli").includes("runner-config"));
  for (const setting of [
    /ENV NODE_ENV=production/,
    /ENV DATA_DIR=\/app\/data/,
    /ENTRYPOINT \["\/app\/check-permissions\.sh"\]/,
    /HEALTHCHECK --interval=30s/,
    /CMD \["node", "dev\/run-standalone\.mjs"\]/,
  ]) {
    assert.ok(
      configuration.instructions.some((line) => setting.test(line)),
      `${setting} missing`
    );
  }
  const appCopies = runner.instructions.filter((line) =>
    /^COPY\b.*--from=runner-base\b.*\/app\/?\s+\.\/?$/.test(line)
  );
  assert.equal(appCopies.length, 1, "copy complete app once into CLI image");
  assert.match(appCopies[0], /--chown=node:node\b/, "preserve non-root ownership");
  assert.ok(!runner.instructions.some((line) => /^RUN\b.*chown\s+-R\b/.test(line)));
  assert.equal(runner.instructions.at(-1), "USER node");
});
