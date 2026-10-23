import test from "node:test";
import assert from "node:assert/strict";
import nextConfig from "../../../next.config.mjs";

function configure(dev) {
  const config = {
    context: process.cwd(),
    cache: { type: "filesystem" },
    plugins: [],
    resolve: {},
  };
  return nextConfig.webpack(config, {
    dev,
    isServer: false,
    defaultLoaders: { babel: {} },
    webpack: { IgnorePlugin: class {} },
  });
}

test("bounded Docker builds release webpack cache instead of retaining the module graph", () => {
  const previous = process.env.OMNIROUTE_BUILD_LOW_MEMORY;
  try {
    process.env.OMNIROUTE_BUILD_LOW_MEMORY = "1";
    assert.equal(configure(false).cache, false);
    assert.deepEqual(configure(true).cache, { type: "filesystem" });
    process.env.OMNIROUTE_BUILD_LOW_MEMORY = "0";
    assert.deepEqual(configure(false).cache, { type: "filesystem" });
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_BUILD_LOW_MEMORY;
    else process.env.OMNIROUTE_BUILD_LOW_MEMORY = previous;
  }
});
