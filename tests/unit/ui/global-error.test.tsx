import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GlobalError from "@/app/global-error";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "@/i18n/config";
import catalog from "@/i18n/globalErrorMessages.generated.json";

// Locale coverage needs the real provider, not the suite's English-only default mock.
vi.unmock("next-intl");

const english = catalog.en.publicSystem.globalError;
const secret = "private upstream stack /app/src/secret.ts:42";

beforeEach(() => {
  document.cookie = `${LOCALE_COOKIE}=; Max-Age=0; path=/`;
});

afterEach(() => {
  cleanup();
  document.cookie = `${LOCALE_COOKIE}=; Max-Age=0; path=/`;
  vi.unstubAllEnvs();
});

function mount(reset = vi.fn()) {
  return render(<GlobalError error={new Error(secret)} reset={reset} />, {
    container: document,
    baseElement: document.documentElement,
  });
}

describe("last-resort error boundary with projected locale catalog", () => {
  it.each(["en", "vi", "ar"] as const)(
    "renders %s offline with retry and status link",
    async (locale) => {
      document.cookie = `${LOCALE_COOKIE}=${locale}; path=/`;
      const reset = vi.fn();
      mount(reset);
      const messages = { ...english, ...catalog[locale].publicSystem.globalError };
      await waitFor(() => {
        expect(document.documentElement.lang).toBe(locale);
        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(messages.title);
      });
      expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("assertive");
      fireEvent.click(screen.getByRole("button", { name: messages.retryAriaLabel }));
      expect(reset).toHaveBeenCalledOnce();
      expect(
        screen.getByRole("link", { name: messages.statusAriaLabel }).getAttribute("href")
      ).toBe("/status");
      expect(document.documentElement.textContent).not.toContain(secret);
    }
  );

  it.each([undefined, "unsupported", "../../secrets"])(
    "invalid/missing cookie %s falls back to English",
    async (locale) => {
      if (locale) document.cookie = `${LOCALE_COOKIE}=${locale}; path=/`;
      mount();
      await waitFor(() => expect(document.documentElement.lang).toBe(DEFAULT_LOCALE));
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(english.title);
    }
  );

  it("falls back per key for missing, invalid or placeholder translations", async () => {
    const messages = catalog.vi.publicSystem.globalError as Record<string, unknown>;
    const original = { ...messages };
    messages.title = "__MISSING__:Private placeholder";
    messages.retryAriaLabel = 123;
    delete messages.statusAriaLabel;
    try {
      document.cookie = `${LOCALE_COOKIE}=vi; path=/`;
      mount();
      await waitFor(() => expect(document.documentElement.lang).toBe("vi"));
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(english.title);
      expect(screen.getByRole("button", { name: english.retryAriaLabel })).toBeTruthy();
      expect(screen.getByRole("link", { name: english.statusAriaLabel })).toBeTruthy();
      expect(document.documentElement.textContent).not.toContain("__MISSING__:");
    } finally {
      Object.assign(messages, original);
    }
  });

  it("never exposes raw error in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    mount();
    expect(document.documentElement.textContent).not.toContain(secret);
    expect(screen.queryByLabelText(english.detailsAriaLabel)).toBeNull();
  });

  it("retains details only in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    mount();
    expect(screen.getByLabelText(english.detailsAriaLabel).textContent).toBe(secret);
  });
});
