import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("global-error client boundary never imports full locale catalogs", () => {
  const source = read("src/app/global-error.tsx");
  assert.match(source, /globalErrorMessages\.generated\.json/);
  assert.doesNotMatch(source, /i18n\/messages\//);
  assert.doesNotMatch(source, /\bimport\s*\(/);
  assert.match(source, /process\.env\.NODE_ENV === "development" && error\?\.message/);
});

test("build and dev synchronize the small catalog without npm lifecycle hooks", () => {
  const build = read("scripts/build/build-next-isolated.mjs");
  assert.match(build, /generateGlobalErrorMessages\(projectRoot\)/);
  assert.ok(
    build.indexOf("generateGlobalErrorMessages(projectRoot)") <
      build.indexOf("await runNextBuild()")
  );
  const dev = read("scripts/dev/run-next.mjs");
  assert.match(dev, /dev \? watchGlobalErrorMessages\(\) :/);
  assert.ok(
    dev.indexOf("dev ? watchGlobalErrorMessages()") < dev.indexOf("let nextApp = createNextApp()")
  );
  const manifest = JSON.parse(read("package.json"));
  assert.ok(manifest.files.includes("scripts/i18n/generate-global-error-messages.mjs"));
});
