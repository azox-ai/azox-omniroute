#!/usr/bin/env node
// Profile a dedicated Buildx container, including its build processes and file cache.
// Usage: node scripts/perf/docker-build-profile.mjs BUILDER_CONTAINER OUTPUT_PREFIX -- docker buildx build --progress=rawjson ...
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseCounters(text) {
  return Object.fromEntries(
    text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [key, value] = line.trim().split(/\s+/);
        return [key, Number(value)];
      })
  );
}

// BuildKit reports the digest of a vertex, not an attempt: the same digest can be a cache
// hit on one attempt and a real execution on the next. A re-attempt starts with a
// `started`-only event (no `completed`, no `cached`), so spreading the previous state over
// it kept the abandoned cache hit — the 2026-10-16 warm run then claimed cached=true for an
// app RUN that spent 159 s on real work. Reset to an in-flight state on that transition.
export function applyVertexEvent(previous, event) {
  const reused = Boolean(previous?.completed) && event.completed === undefined && !event.cached;
  const restarted = Boolean(event.started) && reused;
  const vertex = { ...(restarted ? undefined : previous), ...event };
  if (restarted) {
    vertex.cached = false;
    delete vertex.completed;
    delete vertex.error;
  }
  return vertex;
}

export function summarizeVertices(vertices) {
  return [...vertices.values()].map((vertex) => ({
    id: vertex.id,
    name: vertex.name,
    cached: Boolean(vertex.cached),
    seconds:
      vertex.started && vertex.completed
        ? (Date.parse(vertex.completed) - Date.parse(vertex.started)) / 1000
        : null,
    error: vertex.error || null,
  }));
}

export function cgroupDirectory(membership) {
  const entry = membership.split("\n").find((line) => line.startsWith("0::"));
  if (!entry) throw new Error("A host-visible cgroup v2 hierarchy is required");
  const directory = path.join("/sys/fs/cgroup", entry.slice(3));
  // Docker's PID 1 can live under an `init/` leaf while buildkitd and its
  // children belong to the parent container scope. Sampling the leaf reads
  // only docker-init (~1 MiB) and misses the entire build.
  return path.basename(directory) === "init" ? path.dirname(directory) : directory;
}

export function parseProcessStatus(text) {
  const fields = Object.fromEntries(
    text.split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()];
    })
  );
  return {
    name: fields.Name,
    parentPid: Number(fields.PPid),
    rssBytes: Number.parseInt(fields.VmRSS || "0", 10) * 1024,
    anonBytes: Number.parseInt(fields.RssAnon || "0", 10) * 1024,
  };
}

function readProcesses(cgroup) {
  const processes = [];
  const visit = (directory) => {
    try {
      for (const pid of fs
        .readFileSync(path.join(directory, "cgroup.procs"), "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)) {
        try {
          processes.push({
            pid: Number(pid),
            ...parseProcessStatus(fs.readFileSync(`/proc/${pid}/status`, "utf8")),
          });
        } catch (error) {
          if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
        }
      }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(path.join(directory, entry.name));
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
  visit(cgroup);
  return processes.sort((a, b) => b.rssBytes - a.rssBytes);
}

export async function profile(args) {
  const [container, prefix, separator, command, ...commandArgs] = args;
  if (!container || !prefix || separator !== "--" || !command) {
    throw new Error("Expected BUILDER_CONTAINER OUTPUT_PREFIX -- COMMAND [ARGS...]");
  }
  const inspection = JSON.parse(
    execFileSync("docker", ["inspect", container], { encoding: "utf8" })
  )[0];
  const limits = inspection.HostConfig;
  if (!limits.Memory || limits.MemorySwap !== limits.Memory || !limits.CpuQuota) {
    throw new Error("Use a dedicated builder with explicit RAM/CPU limits and no swap");
  }
  const cgroup = cgroupDirectory(fs.readFileSync(`/proc/${inspection.State.Pid}/cgroup`, "utf8"));
  const read = (name) => fs.readFileSync(path.join(cgroup, name), "utf8").trim();
  if (Number(read("memory.max")) !== limits.Memory) {
    throw new Error("Profiler cgroup does not match the builder's memory limit");
  }
  const snapshot = () => {
    const memory = parseCounters(read("memory.stat"));
    return {
      current: Number(read("memory.current")),
      anon: memory.anon || 0,
      file: memory.file || 0,
      kernel: memory.kernel || 0,
      swap: Number(read("memory.swap.current")),
      lifetimePeak: Number(read("memory.peak")),
      events: parseCounters(read("memory.events")),
      cpu: parseCounters(read("cpu.stat")),
    };
  };
  const start = snapshot();
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const samples = fs.createWriteStream(`${prefix}.samples.jsonl`);
  const raw = fs.createWriteStream(`${prefix}.build.jsonl`);
  const log = fs.createWriteStream(`${prefix}.build.log`);
  const vertices = new Map();
  const peaks = { current: 0, anon: 0, file: 0, kernel: 0, swap: 0 };
  const started = Date.now();
  let count = 0;
  let processes = [];
  const processPeaks = new Map();
  const sample = () => {
    const state = snapshot();
    if (count % 4 === 0) {
      processes = readProcesses(cgroup);
      for (const process of processes) {
        const previous = processPeaks.get(process.pid);
        if (!previous || process.rssBytes > previous.rssBytes)
          processPeaks.set(process.pid, process);
      }
    }
    for (const key of Object.keys(peaks)) peaks[key] = Math.max(peaks[key], state[key]);
    samples.write(
      JSON.stringify({
        elapsedSeconds: (Date.now() - started) / 1000,
        ...state,
        processes,
        active: [...vertices.values()].filter((v) => v.started && !v.completed).map((v) => v.name),
        hostLoad: fs.readFileSync("/proc/loadavg", "utf8").trim(),
      }) + "\n"
    );
    if (count++ % 120 === 0) {
      console.log(
        `[profile] ${((Date.now() - started) / 1000).toFixed(0)}s memory=${(state.current / 1048576).toFixed(0)}MiB anon=${(state.anon / 1048576).toFixed(0)}MiB`
      );
    }
  };
  sample();
  const timer = setInterval(sample, 250);
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  let pending = "";
  const consume = (line) => {
    try {
      const event = JSON.parse(line);
      // Buildx rawjson reports one vertex/log/status per line (not SolveStatus batches).
      if (event.vertexes) {
        for (const vertex of event.vertexes)
          vertices.set(vertex.digest, {
            ...applyVertexEvent(vertices.get(vertex.digest), vertex),
            id: vertex.digest,
          });
      } else if (event.name && event.id) {
        const old = vertices.get(event.id);
        const vertex = applyVertexEvent(old, event);
        vertices.set(event.id, vertex);
        if (event.completed && old?.completed !== event.completed)
          console.log(`[step] ${event.cached ? "cached" : "done"} ${vertex.name}`);
      }
      if (event.data) log.write(Buffer.from(event.data, "base64"));
      for (const entry of event.logs || [])
        if (entry.data) log.write(Buffer.from(entry.data, "base64"));
    } catch {
      log.write(line + "\n");
    }
  };
  child.stderr.on("data", (data) => {
    raw.write(data);
    pending += data.toString();
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      consume(pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
  });
  child.stdout.on("data", (data) => log.write(data));
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    clearInterval(timer);
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  });
  if (pending) consume(pending);
  sample();
  const end = snapshot();
  samples.end();
  raw.end();
  log.end();
  const summary = {
    command: [command, ...commandArgs],
    builderImage: inspection.Image,
    limits: {
      memory: limits.Memory,
      memorySwap: limits.MemorySwap,
      cpuQuota: limits.CpuQuota,
      cpuPeriod: limits.CpuPeriod,
    },
    wallSeconds: (Date.now() - started) / 1000,
    ...result,
    sampleIntervalMs: 250,
    sampledPeaksBytes: peaks,
    processPeaks: [...processPeaks.values()].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, 20),
    cgroupStart: start,
    cgroupEnd: end,
    vertices: summarizeVertices(vertices),
  };
  fs.writeFileSync(`${prefix}.summary.json`, JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = result.code ?? 1;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await profile(process.argv.slice(2));
}
