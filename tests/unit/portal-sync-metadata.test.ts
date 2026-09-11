import test from "node:test";
import assert from "node:assert/strict";
import { resolvePortalConnectionName } from "@/lib/providers/portalSyncMetadata";

test("Portal-synced connections prefer the sponsored label over the account email", () => {
  assert.equal(
    resolvePortalConnectionName("Sponsored by: anhth2", "anhtran.mbox@gmail.com"),
    "Sponsored by: anhth2"
  );
});

test("Portal-synced connections fall back to the account name", () => {
  assert.equal(
    resolvePortalConnectionName(undefined, "anhtran.mbox@gmail.com"),
    "anhtran.mbox@gmail.com"
  );
});
