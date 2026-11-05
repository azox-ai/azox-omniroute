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
  const previous = process.env.OMNIROUTE_WEBPACK_BUILD_CACHE;
  try {
    delete process.env.OMNIROUTE_WEBPACK_BUILD_CACHE;
    assert.equal(configure(false).cache, false);
    process.env.OMNIROUTE_WEBPACK_BUILD_CACHE = "1";
    assert.deepEqual(configure(true).cache, { type: "filesystem" });

    assert.deepEqual(configure(false).cache, { type: "filesystem" });
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_WEBPACK_BUILD_CACHE;
    else process.env.OMNIROUTE_WEBPACK_BUILD_CACHE = previous;
  }
});
