import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const image = process.env.OMNIROUTE_PERF_IMAGE;
const probe = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
assert.equal(process.getuid(), 1000);
for (const name of ["js-tiktoken", "better-sqlite3"]) {
  assert.ok(require.resolve(name).startsWith("/app/node_modules/"), name);
}
const { getEncoding } = require("js-tiktoken");
const tokenizer = getEncoding("cl100k_base");
assert.deepEqual(tokenizer.encode("hello world"), [15339, 1917]);
assert.equal(tokenizer.decode(tokenizer.encode("Tiếng Việt / العربية")), "Tiếng Việt / العربية");
const imported = await import("js-tiktoken");
assert.deepEqual(imported.getEncoding("cl100k_base").encode("hello world"), [15339, 1917]);
const { Tiktoken } = await import("js-tiktoken/lite");
const { default: ranks } = await import("js-tiktoken/ranks/o200k_base");
const workerTokenizer = new Tiktoken(ranks);
assert.equal(workerTokenizer.decode(workerTokenizer.encode("Tiếng Việt / العربية")), "Tiếng Việt / العربية");
const db = require("better-sqlite3") (":memory:");
assert.equal(db.prepare("SELECT 1 AS value").get().value, 1);
db.close();
console.log(JSON.stringify({ tokenizer: true, tokenizerEsm: true, tokenizerWorker: true, sqlite: true, uid: process.getuid() }));
`;

test(
  "standalone tokenizer CJS, ESM and worker subpaths work offline with native SQLite",
  { skip: !image },
  () => {
    assert.match(image, /^llmproxy\/omniroute-perf:[a-z0-9][a-z0-9._-]{0,100}$/);
    const result = execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--pull=never",
        "--network",
        "none",
        "--cpus",
        "1",
        "--memory",
        "1g",
        "--memory-swap",
        "1g",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-",
      ],
      { encoding: "utf8", input: probe, timeout: 60000 }
    );
    assert.deepEqual(JSON.parse(result.trim()), {
      tokenizer: true,
      tokenizerEsm: true,
      tokenizerWorker: true,
      sqlite: true,
      uid: 1000,
    });
  }
);
