import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateGlobalErrorMessages,
  projectGlobalErrorMessages,
  watchGlobalErrorMessages,
} from "../../scripts/i18n/generate-global-error-messages.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const generatedPath = "src/i18n/globalErrorMessages.generated.json";

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(path.join(root, "_artifacts", "global-error-catalog-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, "config"));
  mkdirSync(path.join(directory, "src/i18n/messages"), { recursive: true });
  writeFileSync(
    path.join(directory, "config/i18n.json"),
    JSON.stringify({ default: "en", locales: [{ code: "en" }, { code: "vi" }, { code: "ar" }] })
  );
  for (const [code, data] of Object.entries({
    en: { title: "Error", retryAriaLabel: "Retry" },
    vi: { title: "Lỗi", retryAriaLabel: "__MISSING__:Retry", invalid: 123 },
    ar: { title: "خطأ" },
  })) {
    writeFileSync(
      path.join(directory, `src/i18n/messages/${code}.json`),
      JSON.stringify({
        publicSystem: { globalError: data },
        irrelevant: { huge: "x".repeat(1000) },
      })
    );
  }
  return directory;
}

test("projects only translated global-error strings; missing/invalid keys use English at render", (t) => {
  const directory = fixture(t);
  const english = JSON.parse(
    readFileSync(path.join(directory, "src/i18n/messages/en.json"), "utf8")
  );
  assert.deepEqual(projectGlobalErrorMessages(english), {
    publicSystem: { globalError: { title: "Error", retryAriaLabel: "Retry" } },
  });
  const result = generateGlobalErrorMessages(directory);
  assert.deepEqual(result, { changed: true, locales: 3 });
  const catalog = JSON.parse(readFileSync(path.join(directory, generatedPath), "utf8"));
  assert.deepEqual(Object.keys(catalog), ["en", "vi", "ar"]);
  assert.deepEqual(catalog.vi.publicSystem.globalError, { title: "Lỗi" });
  assert.deepEqual(catalog.ar.publicSystem.globalError, { title: "خطأ" });
  assert.deepEqual(catalog.en.publicSystem.globalError, {
    title: "Error",
    retryAriaLabel: "Retry",
  });
  assert.equal(JSON.stringify(catalog).includes("irrelevant"), false);
  assert.equal(JSON.stringify(catalog).includes("__MISSING__:"), false);
});

test("catalog is deterministic, write-if-changed, and check rejects stale output", (t) => {
  const directory = fixture(t);
  const output = path.join(directory, generatedPath);
  assert.throws(() => generateGlobalErrorMessages(directory, { check: true }), /out of date/);
  generateGlobalErrorMessages(directory);
  const original = readFileSync(output, "utf8");
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(output, old, old);
  assert.deepEqual(generateGlobalErrorMessages(directory), { changed: false, locales: 3 });
  assert.equal(statSync(output).mtimeMs, old.getTime());
  assert.deepEqual(generateGlobalErrorMessages(directory, { check: true }), {
    changed: false,
    locales: 3,
  });
  const vi = path.join(directory, "src/i18n/messages/vi.json");
  writeFileSync(vi, readFileSync(vi, "utf8").replace("Lỗi", "Đã lỗi"));
  assert.throws(() => generateGlobalErrorMessages(directory, { check: true }), /out of date/);
  assert.deepEqual(generateGlobalErrorMessages(directory), { changed: true, locales: 3 });
  assert.notEqual(readFileSync(output, "utf8"), original);
});

test("missing non-English catalog retains locale with English fallback; English is required", (t) => {
  const directory = fixture(t);
  rmSync(path.join(directory, "src/i18n/messages/ar.json"));
  generateGlobalErrorMessages(directory);
  const catalog = JSON.parse(readFileSync(path.join(directory, generatedPath), "utf8"));
  assert.deepEqual(catalog.ar.publicSystem.globalError, {});
  rmSync(path.join(directory, "src/i18n/messages/en.json"));
  assert.throws(() => generateGlobalErrorMessages(directory), /ENOENT/);
});

test("watch refreshes locale edits and stops all listeners", async (t) => {
  const directory = fixture(t);
  const listeners: {
    directory: string;
    onChange: (event: string, filename: string) => void;
    closed: boolean;
  }[] = [];
  const stop = watchGlobalErrorMessages(directory, {
    debounceMs: 1,
    watchImpl(folder, onChange) {
      const listener = { directory: folder, onChange, closed: false };
      listeners.push(listener);
      return { close: () => (listener.closed = true) };
    },
  });
  t.after(stop);
  assert.equal(listeners.length, 2);
  const vi = path.join(directory, "src/i18n/messages/vi.json");
  writeFileSync(vi, readFileSync(vi, "utf8").replace("Lỗi", "Thử lại"));
  listeners[0].onChange("change", "vi.json");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const catalog = JSON.parse(readFileSync(path.join(directory, generatedPath), "utf8"));
  assert.equal(catalog.vi.publicSystem.globalError.title, "Thử lại");
  stop();
  assert.ok(listeners.every((listener) => listener.closed));
});

test("shipped generated catalog matches all configured locales and no unrelated namespaces", () => {
  assert.deepEqual(generateGlobalErrorMessages(root, { check: true }), {
    changed: false,
    locales: JSON.parse(readFileSync(path.join(root, "config/i18n.json"), "utf8")).locales.length,
  });
  const catalog = JSON.parse(readFileSync(path.join(root, generatedPath), "utf8"));
  const locales = Object.keys(catalog);
  assert.equal(
    locales.length,
    JSON.parse(readFileSync(path.join(root, "config/i18n.json"), "utf8")).locales.length
  );
  for (const locale of locales) {
    assert.deepEqual(Object.keys(catalog[locale]), ["publicSystem"]);
    assert.deepEqual(Object.keys(catalog[locale].publicSystem), ["globalError"]);
  }
});

test("projection rejects arrays, malformed namespaces and placeholders without mutation", () => {
  for (const value of [
    undefined,
    null,
    42,
    [],
    {},
    { publicSystem: [] },
    { publicSystem: { globalError: [] } },
  ]) {
    assert.deepEqual(projectGlobalErrorMessages(value), { publicSystem: { globalError: {} } });
  }
  const source = {
    publicSystem: {
      globalError: {
        title: "Title",
        empty: "",
        bad: 42,
        object: {},
        placeholder: "__MISSING__:Title",
      },
    },
  };
  const before = JSON.stringify(source);
  assert.deepEqual(projectGlobalErrorMessages(source), {
    publicSystem: { globalError: { title: "Title", empty: "" } },
  });
  assert.equal(JSON.stringify(source), before);
});

test("invalid locale configuration cannot read paths outside catalogs", (t) => {
  const directory = fixture(t);
  const config = path.join(directory, "config/i18n.json");
  for (const data of [
    { default: "en", locales: [{ code: "../../outside" }] },
    { default: "en", locales: [{ code: "en" }, { code: "en" }] },
    { default: "vi", locales: [{ code: "en" }] },
    { default: "vi", locales: [{ code: "vi" }] },
  ]) {
    writeFileSync(config, JSON.stringify(data));
    assert.throws(() => generateGlobalErrorMessages(directory));
  }
});

test("English remains required even when configured default is another locale", (t) => {
  const directory = fixture(t);
  const configPath = path.join(directory, "config/i18n.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.default = "vi";
  writeFileSync(configPath, JSON.stringify(config));
  generateGlobalErrorMessages(directory);
  rmSync(path.join(directory, "src/i18n/messages/en.json"));
  assert.throws(() => generateGlobalErrorMessages(directory), /ENOENT/);
});

test("malformed source JSON fails generation instead of silently shipping stale translations", (t) => {
  const directory = fixture(t);
  generateGlobalErrorMessages(directory);
  const before = readFileSync(path.join(directory, generatedPath), "utf8");
  writeFileSync(path.join(directory, "src/i18n/messages/vi.json"), "{");
  assert.throws(() => generateGlobalErrorMessages(directory), SyntaxError);
  assert.equal(readFileSync(path.join(directory, generatedPath), "utf8"), before);
});
