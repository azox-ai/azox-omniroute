import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApiBridgeServer } from "../../src/lib/apiBridgeServer.ts";

test("API bridge keeps client and dashboard connection lifecycles separate for SSE", async (t) => {
  const parserErrors: string[] = [];
  const targetConnections: (string | undefined)[] = [];
  let received = 0;
  const dashboard = http.createServer((req, res) => {
    received += 1;
    targetConnections.push(req.headers.connection);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
      });
      res.write("event: response.created\ndata: {}\n\n");
      res.end("event: response.completed\ndata: {}\n\n");
    });
  });
  dashboard.on("clientError", (error, socket) => {
    parserErrors.push((error as NodeJS.ErrnoException).code || "unknown");
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => dashboard.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    dashboard.closeAllConnections();
    dashboard.close();
  });

  const bridge = createApiBridgeServer((dashboard.address() as AddressInfo).port);
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    bridge.closeAllConnections();
    bridge.close();
  });

  const send = () =>
    new Promise<{ status: number | undefined; body: string; connection: string | undefined }>(
      (resolve, reject) => {
        const body = JSON.stringify({ model: "test", stream: true, input: "synthetic" });
        const request = http.request(
          {
            hostname: "127.0.0.1",
            port: (bridge.address() as AddressInfo).port,
            path: "/v1/responses",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              connection: "close",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                body: Buffer.concat(chunks).toString("utf8"),
                connection: response.headers.connection,
              })
            );
          }
        );
        request.on("error", reject);
        request.end(body);
      }
    );

  const responses = [];
  for (let index = 0; index < 4; index += 1) {
    responses.push(await send());
  }
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200],
    JSON.stringify({ received, parserErrors })
  );
  assert.ok(responses.every((response) => response.body.includes("response.completed")));
  assert.ok(responses.every((response) => response.connection === "close"));
  assert.equal(received, 4);
  assert.ok(targetConnections.every((connection) => connection !== "close"));
  assert.deepEqual(parserErrors, []);
});
