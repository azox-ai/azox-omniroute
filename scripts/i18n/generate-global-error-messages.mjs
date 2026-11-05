#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const localeCode = z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/);
const configSchema = z.object({
  default: localeCode,
  locales: z.array(z.object({ code: localeCode })).min(1),
});
const outputPath = "src/i18n/globalErrorMessages.generated.json";

export function projectGlobalErrorMessages(messages) {
  const globalError = messages?.publicSystem?.globalError;
  const translated =
    globalError && typeof globalError === "object" && !Array.isArray(globalError)
      ? Object.fromEntries(
          Object.entries(globalError).filter(
            ([, value]) => typeof value === "string" && !value.startsWith("__MISSING__:")
          )
        )
      : {};
  return { publicSystem: { globalError: translated } };
}

export function generateGlobalErrorMessages(rootDir = process.cwd(), { check = false } = {}) {
  const config = configSchema.parse(
    JSON.parse(fs.readFileSync(path.join(rootDir, "config/i18n.json"), "utf8"))
  );
  const locales = config.locales.map(({ code }) => code);
  if (
    !locales.includes("en") ||
    !locales.includes(config.default) ||
    new Set(locales).size !== locales.length
  ) {
    throw new Error("Locale config must include English, its default and no duplicate codes");
  }
  const catalog = Object.fromEntries(
    locales.map((locale) => {
      let messages;
      try {
        messages = JSON.parse(
          fs.readFileSync(path.join(rootDir, "src/i18n/messages", `${locale}.json`), "utf8")
        );
      } catch (error) {
        if (locale === "en" || error.code !== "ENOENT") throw error;
        // A missing lazy-loaded locale used to fall back to English in global-error.
        messages = {};
      }
      return [locale, projectGlobalErrorMessages(messages)];
    })
  );
  if (Object.keys(catalog.en.publicSystem.globalError).length === 0) {
    throw new Error("English locale has no global error messages");
  }
  // Only this namespace reaches the last-resort client boundary, not the full catalogs.
  const content = JSON.stringify(catalog, null, 2) + "\n";
  const destination = path.join(rootDir, outputPath);
  let previous;
  try {
    previous = fs.readFileSync(destination, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const changed = previous !== content;
  if (check && changed) {
    throw new Error(
      `${outputPath} is out of date; run node scripts/i18n/generate-global-error-messages.mjs`
    );
  }
  if (changed) fs.writeFileSync(destination, content);
  return { changed, locales: locales.length };
}

export function watchGlobalErrorMessages(
  rootDir = process.cwd(),
  { debounceMs = 150, watchImpl = fs.watch, onError = console.error } = {}
) {
  generateGlobalErrorMessages(rootDir);
  let timer;
  let stopped = false;
  const refresh = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        generateGlobalErrorMessages(rootDir);
      } catch (error) {
        onError("[i18n] Could not refresh global-error messages:", error);
      }
    }, debounceMs);
    timer.unref?.();
  };
  const watch = (directory, accepts) => {
    const watcher = watchImpl(directory, (_event, filename) => {
      if (!filename || accepts(String(filename))) refresh();
    });
    watcher.unref?.();
    watcher.on?.("error", (error) => onError("[i18n] Global-error watcher failed:", error));
    return watcher;
  };
  const messagesWatcher = watch(path.join(rootDir, "src/i18n/messages"), (name) =>
    name.endsWith(".json")
  );
  let configWatcher;
  try {
    configWatcher = watch(path.join(rootDir, "config"), (name) => name === "i18n.json");
  } catch (error) {
    messagesWatcher.close();
    throw error;
  }
  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    messagesWatcher.close();
    configWatcher.close();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = generateGlobalErrorMessages(process.cwd(), {
    check: process.argv.includes("--check"),
  });
  console.log(
    `[i18n] Global-error catalog: ${result.locales} locales, ${result.changed ? "updated" : "unchanged"}`
  );
}
