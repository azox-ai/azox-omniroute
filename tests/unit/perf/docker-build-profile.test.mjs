import test from "node:test";
import assert from "node:assert/strict";
import {
  applyVertexEvent,
  cgroupDirectory,
  parseCounters,
  parseProcessStatus,
  summarizeVertices,
} from "../../../scripts/perf/docker-build-profile.mjs";

test("profile reads cgroup v2 memory and event counters", () => {
  assert.deepEqual(parseCounters("anon 1024\nfile 2048\noom_kill 0\n"), {
    anon: 1024,
    file: 2048,
    oom_kill: 0,
  });
});

test("profile reads process RSS in bytes without logging command arguments", () => {
  assert.deepEqual(
    parseProcessStatus("Name:\tnode\nPPid:\t123\nVmRSS:\t2048 kB\nRssAnon:\t1024 kB\n"),
    {
      name: "node",
      parentPid: 123,
      rssBytes: 2097152,
      anonBytes: 1048576,
    }
  );
});

test("profile samples the complete Docker scope, not only docker-init", () => {
  assert.equal(
    cgroupDirectory("0::/system.slice/docker-example.scope/init\n"),
    "/sys/fs/cgroup/system.slice/docker-example.scope"
  );
  assert.equal(
    cgroupDirectory("0::/system.slice/docker-example.scope\n"),
    "/sys/fs/cgroup/system.slice/docker-example.scope"
  );
  assert.throws(() => cgroupDirectory("1:memory:/docker/example"), /cgroup v2/);
});

test("profile distinguishes cached stages and reports complete wall durations", () => {
  const vertices = new Map([
    ["cached", { id: "cached", name: "npm ci", cached: true }],
    [
      "built",
      {
        id: "built",
        name: "npm run build",
        started: "2026-10-16T01:00:00.000Z",
        completed: "2026-10-16T01:00:12.500Z",
      },
    ],
  ]);
  assert.deepEqual(summarizeVertices(vertices), [
    { id: "cached", name: "npm ci", cached: true, seconds: null, error: null },
    { id: "built", name: "npm run build", cached: false, seconds: 12.5, error: null },
  ]);
});

// BuildKit reuses a vertex digest across attempts: the digest is first reported as a
// cache hit and, when the cache entry turns out to be unusable, the very same digest is
// re-executed. The re-attempt events omit `cached`/`completed`, so a plain spread of the
// previous state kept advertising the abandoned cache hit (observed on the 2026-10-16
// warm run: summary said cached=true for an app RUN that took 159 s of real work).
test("profile reports a re-attempted vertex as executed, not as a stale cache hit", () => {
  const digest = "sha256:27d6d4ac9a42460c3e60bb4acc220e94bbb4b95bf227756fa696f638ed5c0505";
  let vertex;
  for (const event of [
    { id: digest, name: "npm run build" },
    {
      id: digest,
      name: "npm run build",
      started: "2026-10-16T07:37:19.384871735Z",
      completed: "2026-10-16T07:37:19.384871735Z",
      cached: true,
    },
    { id: digest, name: "npm run build", started: "2026-10-16T07:37:19.384947685Z" },
    {
      id: digest,
      name: "npm run build",
      started: "2026-10-16T07:37:19.384947685Z",
      completed: "2026-10-16T07:39:58.388890233Z",
    },
  ]) {
    vertex = applyVertexEvent(vertex, event);
  }

  const [summary] = summarizeVertices(new Map([[digest, vertex]]));
  assert.equal(summary.cached, false);
  assert.ok(
    Math.abs(summary.seconds - 159.004) < 0.002,
    `expected the re-attempt duration (159 s), got ${summary.seconds}`
  );
});

test("profile clears the stale completion as soon as a cache hit is re-attempted", () => {
  const digest = "sha256:cfff6b412a7cc9f864fe69bf6cba4208cd6a127b97608b6c7fafc5dccab6b21f";
  let vertex = applyVertexEvent(undefined, {
    id: digest,
    name: "npm run build",
    started: "2026-10-16T07:30:55.374439676Z",
    completed: "2026-10-16T07:30:55.374439676Z",
    cached: true,
  });
  vertex = applyVertexEvent(vertex, {
    id: digest,
    name: "npm run build",
    started: "2026-10-16T07:31:00.000000000Z",
  });

  const [summary] = summarizeVertices(new Map([[digest, vertex]]));
  assert.equal(summary.cached, false);
  assert.equal(summary.seconds, null);
});

test("profile keeps a genuine cache hit across partial updates of the same attempt", () => {
  const digest = "sha256:6d6f8a9ac467594079ef297865f001d51cfbab133129bb96cbace4fe8c5417d7";
  let vertex = applyVertexEvent(undefined, {
    id: digest,
    name: "COPY . ./",
    started: "2026-10-16T07:37:11.000000000Z",
    completed: "2026-10-16T07:37:11.000000000Z",
    cached: true,
  });
  // A log-only event repeats the name without any timing fields: same attempt, no reset.
  vertex = applyVertexEvent(vertex, { id: digest, name: "COPY . ./" });

  const [summary] = summarizeVertices(new Map([[digest, vertex]]));
  assert.equal(summary.cached, true);
  assert.equal(summary.seconds, 0);
});
