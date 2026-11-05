import { parentPort, workerData } from "node:worker_threads";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = workerData.dataDir;
const core = await import("../../src/lib/db/core.ts");
const portal = await import("../../src/lib/db/portalConnections.ts");
core.getDbInstance();
parentPort.postMessage("ready");
await new Promise((resolve) => parentPort.once("message", resolve));
try {
  portal.upsertPortalManagedConnection(workerData.externalId, workerData.input);
} catch (error) {
  if (!(error instanceof portal.PortalConnectionConflict)) throw error;
} finally {
  core.resetDbInstance();
}
