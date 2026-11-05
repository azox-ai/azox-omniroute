import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/build/docker-image.sh", import.meta.url));

function run(extraEnv = {}, target = "runner-cli") {
  const temp = mkdtempSync(join(tmpdir(), "omni-build-command-"));
  try {
    writeFileSync(
      join(temp, "docker"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'buildx' && args[1] === 'inspect') {
  if (args.includes('--format')) process.exit(99);
  if (process.env.FAKE_CREATE && !args.includes('--bootstrap')) process.exit(1);
  console.log('Name: command-test\\nDriver: docker-container\\nNodes:\\nName: command-test0');
} else if (args[0] === 'buildx' && args[1] === 'create') {
  fs.writeFileSync(process.env.FAKE_CREATE_ARGS, JSON.stringify(args));
} else if (args[0] === 'inspect') {
  if (args.some(a => a.includes('GOMEMLIMIT'))) { console.log(process.env.FAKE_GO_MEMORY || 'bounded'); process.exit(0); }
  console.log(process.env.FAKE_LIMIT || '10737418240 10737418240');
} else if (args[0] === 'exec') {
  const file = args.at(-1);
  if (file.endsWith('.toml')) console.log('[worker.oci]\\nmax-parallelism = 1');
  else if (file.endsWith('memory.events')) console.log('oom 0\\noom_kill 0');
  else console.log('1234');
} else if (args[0] === 'buildx' && args[1] === 'build') {
  fs.writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args));
  process.exit(Number(process.env.FAKE_EXIT || 0));
} else process.exit(99);
`,
      { mode: 0o755 }
    );
    const result = spawnSync("bash", [script, "omniroute:test", target, "command-test"], {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        BUILD_LOG_DIR: join(temp, "logs"),
        FAKE_ARGS: join(temp, "args.json"),
        FAKE_CREATE_ARGS: join(temp, "create-args.json"),
        OMNIROUTE_DOCKER_MEMORY_GB: "10",
        OMNIROUTE_BUILD_MEMORY_MB: "6144",
        ...extraEnv,
      },
    });
    let args = [];
    try {
      args = JSON.parse(readFileSync(join(temp, "args.json"), "utf8"));
    } catch {}
    const createArgs = existsSync(join(temp, "create-args.json"))
      ? JSON.parse(readFileSync(join(temp, "create-args.json"), "utf8"))
      : [];
    return { ...result, args, createArgs };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("bounded command builds the requested full image with webpack and diagnostics", () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  for (const arg of [
    "--load",
    "--metadata-file",
    "runner-cli",
    "OMNIROUTE_USE_TURBOPACK=0",
    "OMNIROUTE_BUILD_LOW_MEMORY=1",
    "OMNIROUTE_BUILD_MEMORY_MB=6144",
    "OMNIROUTE_BUILD_WORKERS=2",
  ]) {
    assert.ok(result.args.includes(arg), arg);
  }
});

test("default profile fits a 6 GiB builder with 2 GiB reserved outside the V8 heap", () => {
  const result = run({
    OMNIROUTE_DOCKER_MEMORY_GB: "",
    OMNIROUTE_BUILD_MEMORY_MB: "",
    FAKE_LIMIT: "6442450944 6442450944",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.args.includes("OMNIROUTE_BUILD_MEMORY_MB=4096"));
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG OMNIROUTE_BUILD_MEMORY_MB=4096$/m);
});

test("new builders bound the Go runtime footprint alongside the container cap", () => {
  const result = run({ FAKE_CREATE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.createArgs.some((arg) => arg.includes("env.GOMEMLIMIT=512MiB")));
});

test("a builder without the Go memory profile is rejected before compilation", () => {
  const result = run({ FAKE_GO_MEMORY: "missing" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.args, []);
});

test("build failure survives tee and diagnostic cleanup", () => {
  assert.equal(run({ FAKE_EXIT: "17" }).status, 17);
});

test("an existing builder with different limits is rejected before building", () => {
  const result = run({ FAKE_LIMIT: "0 -1" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.args, []);
});

test("oversized heap and unknown target are rejected before building", () => {
  for (const result of [run({ OMNIROUTE_BUILD_MEMORY_MB: "10240" }), run({}, "wrong")]) {
    assert.equal(result.status, 2);
    assert.deepEqual(result.args, []);
  }
});

test("separate worktrees share the builder lock and cancellation terminates the active build", async () => {
  const temp = mkdtempSync(join(tmpdir(), "omni-build-cancel-"));
  const marker = join(temp, "build.pid");
  let child;
  let buildPid;
  try {
    writeFileSync(
      join(temp, "docker"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
if (a[0] === 'buildx' && a[1] === 'inspect') console.log('Name: cancellation-test\\nNodes:\\nName: cancellation-test0');
else if (a[0] === 'inspect') console.log(a.some(v => v.includes('GOMEMLIMIT')) ? 'bounded' : '10737418240 10737418240');
else if (a[0] === 'exec') console.log(a.at(-1).endsWith('.toml') ? '[worker.oci]\\nmax-parallelism = 1' : '0');
else if (a[0] === 'buildx' && a[1] === 'build') {
  fs.writeFileSync(process.env.BUILD_MARKER, String(process.pid));
  setInterval(() => {}, 1000);
} else process.exit(99);
`,
      { mode: 0o755 }
    );
    const commands = ["first", "second"].map((name) => {
      const root = join(temp, name);
      mkdirSync(join(root, "scripts/build"), { recursive: true });
      const copy = join(root, "scripts/build/docker-image.sh");
      copyFileSync(script, copy);
      return {
        args: [copy, "omniroute:test", "runner-base", `cancel-test-${process.pid}`],
        options: {
          env: {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            BUILD_MARKER: marker,
            BUILD_LOG_DIR: join(root, "logs"),
            OMNIROUTE_DOCKER_MEMORY_GB: "10",
            OMNIROUTE_BUILD_MEMORY_MB: "6144",
          },
          stdio: "ignore",
        },
      };
    });
    child = spawn("bash", commands[0].args, commands[0].options);
    const finished = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(50);
    assert.ok(existsSync(marker), "fake build must start before cancellation");
    buildPid = Number(readFileSync(marker, "utf8"));
    const competing = spawnSync("bash", commands[1].args, {
      ...commands[1].options,
      timeout: 3000,
    });
    assert.equal(competing.status, 1, "another checkout must not enter the same builder");
    child.kill("SIGTERM");
    assert.equal(await Promise.race([finished, delay(5000).then(() => "timeout")]), 143);
    for (let i = 0; i < 40 && existsSync(`/proc/${buildPid}`); i++) await delay(50);
    assert.ok(
      !existsSync(`/proc/${buildPid}`) ||
        readFileSync(`/proc/${buildPid}/stat`, "utf8").split(") ")[1].startsWith("Z"),
      "build client must no longer be running"
    );
    assert.ok(existsSync(join(temp, "first/logs/memory-events-after.txt")));
  } finally {
    child?.kill("SIGKILL");
    if (buildPid) {
      try {
        process.kill(buildPid, "SIGKILL");
      } catch {}
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
