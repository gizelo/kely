import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { request as httpsRequest } from "node:https";
import { test } from "node:test";
import { pinnedFetch } from "../src/server/source-acquisition";

test("ongoing source bytes cannot extend the total import deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "text/html" }, destroy() {} });
  let destroyed = false;
  const events = new EventEmitter();
  const request = Object.assign(events, { end() {}, destroy(error: Error) { destroyed = true; events.emit("error", error); } });
  const factory = ((_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
    request.end = () => callback(response);
    return request;
  }) as unknown as typeof httpsRequest;
  const pending = pinnedFetch(new URL("https://example.test"), [{ address: "8.8.8.8", family: 4 }], 512, factory);
  const rejected = assert.rejects(pending, { code: "source_timeout" });
  context.mock.timers.tick(4000);
  response.emit("data", Buffer.from("x"));
  context.mock.timers.tick(1000);
  await rejected;
  assert.equal(destroyed, true);
});
