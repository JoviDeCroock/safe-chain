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

      assert.strictEqual(handler.shouldBufferResponse({}), false);
    });

    it("is true when the body is modified and no predicate is set", async () => {
      const handler = await handlerFor((context) => {
        context.modifyBody((body) => body);
      });

      assert.strictEqual(handler.shouldBufferResponse({}), true);
    });

    it("follows the bufferResponseIf predicate for the response headers", async () => {
      const handler = await handlerFor((context) => {
        context.modifyBody((body) => body);
        context.bufferResponseIf((headers) => headers["x-buffer"] === "yes");
      });

      assert.strictEqual(handler.shouldBufferResponse({ "x-buffer": "yes" }), true);
      assert.strictEqual(handler.shouldBufferResponse({ "x-buffer": "no" }), false);
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

    it("passes the forwarded request headers to body modifications", async () => {
      let seenRequestHeaders;
      const handler = await handlerFor((context) => {
        context.modifyBody((body, _headers, requestHeaders) => {
          seenRequestHeaders = requestHeaders;
          return body;
        });
      });

      await handler.modifyBody(Buffer.from("original"), {}, {
        authorization: "Bearer token",
      });

      assert.deepStrictEqual(seenRequestHeaders, {
        authorization: "Bearer token",
      });
    });
  });
});
