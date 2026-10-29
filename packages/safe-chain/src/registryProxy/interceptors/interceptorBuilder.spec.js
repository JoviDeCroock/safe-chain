import { describe, it } from "node:test";
import assert from "node:assert";
import { interceptRequests } from "./interceptorBuilder.js";

describe("interceptorBuilder", () => {
  /**
   * @param {(context: import("./interceptorBuilder.js").RequestInterceptionContext) => void} setup
   */
  function handlerFor(setup) {
    return interceptRequests(async (context) => setup(context)).handleRequest(
      "https://registry.npmjs.org/pkg"
    );
  }

  describe("shouldBufferResponse", () => {
    it("is false when nothing modifies the body", async () => {
      const handler = await handlerFor(() => {});

      assert.strictEqual(handler.shouldBufferResponse({ statusCode: 200, headers: {} }), false);
    });

    it("is true when the body is modified and no predicate is set", async () => {
      const handler = await handlerFor((context) => {
        context.modifyBody((body) => body);
      });

      assert.strictEqual(handler.shouldBufferResponse({ statusCode: 200, headers: {} }), true);
    });

    it("follows the bufferResponseIf predicate for the upstream response", async () => {
      const handler = await handlerFor((context) => {
        context.modifyBody((body) => body);
        context.bufferResponseIf(
          ({ statusCode, headers }) =>
            statusCode === 200 && headers["x-buffer"] === "yes"
        );
      });

      const shouldBuffer = (statusCode, buffer) =>
        handler.shouldBufferResponse({ statusCode, headers: { "x-buffer": buffer } });
      assert.strictEqual(shouldBuffer(200, "yes"), true);
      assert.strictEqual(shouldBuffer(200, "no"), false);
      assert.strictEqual(shouldBuffer(304, "yes"), false);
    });
  });

  describe("modifyBody", () => {
    it("awaits asynchronous body modifications", async () => {
      const handler = await handlerFor((context) => {
        context.modifyBody(async () => Buffer.from("async result"));
      });

      const result = await handler.modifyBody(Buffer.from("original"), {});

      assert.strictEqual(result.toString(), "async result");
    });

    it("passes the forwarded request to body modifications", async () => {
      let seenRequest;
      const handler = await handlerFor((context) => {
        context.modifyBody((body, _headers, request) => {
          seenRequest = request;
          return body;
        });
      });
      const request = {
        url: "https://registry.npmjs.org/pkg",
        headers: { authorization: "Bearer token" },
      };

      await handler.modifyBody(Buffer.from("original"), {}, request);

      assert.deepStrictEqual(seenRequest, request);
    });
  });
});
