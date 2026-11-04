#!/usr/bin/env node
// Compare startup preloading on two isolated containers built from the same image.
// Usage: node scripts/perf/docker-runtime-profile.mjs OUTPUT_JSON IMAGE SERVER_JS [ROUNDS]
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { cgroupDirectory, parseCounters } from "./docker-build-profile.mjs";

export function lazyServerSource(source) {
  const setting = '"preloadEntriesOnStart":true';
  if (source.split(setting).length !== 2) {
    throw new Error("Expected one generated preload setting");
  }
  return source.replace(setting, '"preloadEntriesOnStart":false');
}

export function summarizeSamples(samples) {
  return {
    count: samples.length,
    peakCurrentBytes: samples.length ? Math.max(...samples.map((s) => s.current)) : null,
    peakAnonBytes: samples.length ? Math.max(...samples.map((s) => s.anon)) : null,
    final: samples.at(-1) || null,
  };
}

const REQUEST = `const start = performance.now();
const headers = process.env.PERF_COOKIE ? { cookie: process.env.PERF_COOKIE } : {};
if (process.env.PERF_PASSWORD || process.env.PERF_CHAT_PROBE) headers["content-type"] = "application/json";
fetch("http://127.0.0.1:20128" + process.env.PERF_PATH, {
  method: process.env.PERF_PASSWORD || process.env.PERF_CHAT_PROBE ? "POST" : "GET",
  headers,
  redirect: "manual",
  body: process.env.PERF_PASSWORD ? JSON.stringify({ password: process.env.PERF_PASSWORD }) :
    process.env.PERF_CHAT_PROBE ? JSON.stringify({ model: "perf-denied", messages: [{ role: "user", content: "test" }] }) : undefined,
  signal: AbortSignal.timeout(15000),
}).then(async (response) => {
  const bytes = (await response.arrayBuffer()).byteLength;
  console.log(JSON.stringify({ status: response.status, ms: Math.round(performance.now() - start), bytes,
    cookie: response.headers.get("set-cookie")?.split(";")[0] || null }));
}).catch((error) => { console.error(error.message); process.exitCode = 1; });`;

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 25_000 }).trim();
}

const execAsync = promisify(execFile);

async function request(container, route, cookie, password) {
  const args = ["exec", "-e", `PERF_PATH=${route}`];
  if (cookie) args.push("-e", `PERF_COOKIE=${cookie}`);
  if (password) args.push("-e", `PERF_PASSWORD=${password}`);
  if (route === "/api/v1/chat/completions") args.push("-e", "PERF_CHAT_PROBE=1");
  args.push(container, "node", "-e", REQUEST);
  const { stdout } = await execAsync("docker", args, { encoding: "utf8", timeout: 25_000 });
  return JSON.parse(stdout);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(image, preload, serverFile) {
  const name = `omniroute-perf-${preload ? "preload" : "lazy"}-${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const args = [
    "run",
    "--rm",
    "--detach",
    "--name",
    name,
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "4g",
    "--memory-swap",
    "4g",
    "--tmpfs",
    "/app/data:rw,uid=1000,gid=1000,mode=0700,size=256m",
    ...(serverFile
      ? ["--mount", `type=bind,source=${serverFile},target=/app/server.js,readonly`]
      : []),
    "--env",
    "DATA_DIR=/app/data",
    "--env",
    "REQUIRE_API_KEY=true",
    "--env",
    `INITIAL_PASSWORD=${password}`,
    "--env",
    `JWT_SECRET=${randomBytes(32).toString("hex")}`,
    "--env",
    `API_KEY_SECRET=${randomBytes(32).toString("hex")}`,
    image,
  ];
  const started = Date.now();
  const phases = { startup: [], idle: [], first: [], warm: [] };
  let phase = "startup";
  let interval;
  docker(args);
  try {
    const inspect = JSON.parse(docker(["inspect", name]))[0];
    const cgroup = cgroupDirectory(fs.readFileSync(`/proc/${inspect.State.Pid}/cgroup`, "utf8"));
    const sample = () => {
      const stat = parseCounters(fs.readFileSync(path.join(cgroup, "memory.stat"), "utf8"));
      phases[phase].push({
        seconds: (Date.now() - started) / 1000,
        current: Number(fs.readFileSync(path.join(cgroup, "memory.current"), "utf8")),
        anon: stat.anon || 0,
        file: stat.file || 0,
      });
    };
    sample();
    interval = setInterval(sample, 250);
    let health;
    for (let i = 0; i < 120; i++) {
      try {
        health = await request(name, "/api/monitoring/health");
        if (health.status === 200) break;
      } catch {
        // Health endpoint unavailable until startup completes.
      }
      await sleep(1000);
    }
    if (health?.status !== 200) throw new Error(`Container ${name} failed health readiness`);
    const readySeconds = (Date.now() - started) / 1000;
    phase = "idle";
    await sleep(8000);
    phase = "first";
    const login = await request(name, "/api/auth/login", null, password);
    if (login.status !== 200 || !login.cookie) {
      throw new Error(
        `Container ${name} login status ${login.status}, cookie=${Boolean(login.cookie)}`
      );
    }
    const cookie = login.cookie;
    const routes = [
      "/dashboard",
      "/dashboard/providers",
      "/dashboard/models",
      "/api/providers",
      "/api/models",
    ];
    const measure = async (route) => {
      const { status, ms, bytes } = await request(name, route, cookie);
      return { route, status, ms, bytes };
    };
    const first = [];
    for (const route of routes) first.push(await measure(route));
    const denied = await request(name, "/api/v1/chat/completions");
    if (denied.status !== 401)
      throw new Error(`Expected API authentication denial, got ${denied.status}`);
    if (first.some(({ status }) => status !== 200)) {
      throw new Error(`Container ${name} dashboard status: ${first.map((r) => r.status)}`);
    }
    phase = "warm";
    const warm = [];
    for (const route of routes) warm.push(await measure(route));
    await sleep(3000);
    clearInterval(interval);
    const events = parseCounters(fs.readFileSync(path.join(cgroup, "memory.events"), "utf8"));
    const result = {
      preload,
      image: inspect.Image,
      startupSeconds: readySeconds,
      events,
      swapBytes: Number(fs.readFileSync(path.join(cgroup, "memory.swap.current"), "utf8")),
      cgroupPeakBytes: Number(fs.readFileSync(path.join(cgroup, "memory.peak"), "utf8")),
      idle: summarizeSamples(phases.idle),
      phases: Object.fromEntries(
        Object.entries(phases).map(([key, value]) => [key, summarizeSamples(value)])
      ),
      health: { status: health.status, ms: health.ms },
      first,
      warm,
      denied: { status: denied.status },
    };
    return result;
  } finally {
    if (interval) clearInterval(interval);
    docker(["rm", "--force", name]);
  }
}

// Smoke-test an unmodified image with the same offline dashboard/API workload.
export async function profileBuiltImage(image) {
  if (!image) throw new Error("Expected image");
  return run(image, null);
}

export async function profileRuntime(output, image, serverFile, rounds = 1) {
  if (!output || !image || !serverFile || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error("Expected output JSON path, image, server.js path and positive rounds");
  }
  const original = path.resolve(serverFile);
  const patched = path.resolve(`${output}.server-no-preload.js`);
  const variant = lazyServerSource(fs.readFileSync(original, "utf8"));
  if (fs.existsSync(patched)) {
    if (fs.readFileSync(patched, "utf8") !== variant) {
      throw new Error("Existing no-preload artifact differs from expected server.js");
    }
  } else {
    fs.writeFileSync(patched, variant);
  }
  const results = [];
  for (let round = 0; round < rounds; round++) {
    const variants = round % 2 ? [false, true] : [true, false];
    for (const preload of variants) {
      results.push({
        round: round + 1,
        ...(await run(image, preload, preload ? original : patched)),
      });
      fs.writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
      console.log(JSON.stringify(results.at(-1), null, 2));
    }
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await profileRuntime(
    process.argv[2],
    process.argv[3],
    process.argv[4],
    Number(process.argv[5] || 1)
  );
}
