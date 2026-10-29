import { describe, it, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import zlib from "node:zlib";
import { FailClosedError } from "../../failClosedError.js";

describe("fetchFullPackument", async () => {
  let requests = [];
  let response;

  class FakeProxyAgent {
    constructor(url) {
      this.url = url;
    }
  }

  mock.module("https", {
    defaultExport: {
      get: (url, options, callback) => {
        if (response === "throw") {
          throw new TypeError("Invalid URL");
        }
        const requestListeners = {};
        requests.push({ url, options });
        setImmediate(() => {
          if (response === "hang") {
            return;
          }
          if (response instanceof Error) {
            requestListeners["error"]?.(response);
            return;
          }
          const responseListeners = {};
          callback({
            statusCode: response.statusCode,
            headers: response.headers,
            on: (event, handler) => {
              responseListeners[event] = handler;
            },
          });
          responseListeners["data"]?.(response.body);
          responseListeners["end"]?.();
        });
        return {
          on: (event, handler) => {
            requestListeners[event] = handler;
          },
          setTimeout: (timeoutMs, onTimeout) => {
            requests.at(-1).timeoutMs = timeoutMs;
            if (response === "hang") {
              setImmediate(onTimeout);
            }
          },
          destroy: (err) => requestListeners["error"]?.(err),
        };
      },
    },
  });
  mock.module("https-proxy-agent", {
    namedExports: { HttpsProxyAgent: FakeProxyAgent },
  });

  const { fetchFullPackument } = await import("./fullPackument.js");
  const originalHttpsProxy = process.env.HTTPS_PROXY;

  beforeEach(() => {
    requests = [];
    response = {
      statusCode: 200,
      headers: { "content-encoding": "gzip" },
      body: zlib.gzipSync(Buffer.from('{"name":"pkg"}')),
    };
    delete process.env.HTTPS_PROXY;
  });

  afterEach(() => {
    if (originalHttpsProxy === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = originalHttpsProxy;
    }
  });

  it("requests the full document with the client's credentials", async () => {
    await fetchFullPackument("https://registry.npmjs.org/pkg", {
      accept: "application/vnd.npm.install-v1+json",
      authorization: "Bearer token",
      "if-none-match": '"abbreviated-etag"',
      "if-modified-since": "Tue, 27 Oct 2026 10:00:00 GMT",
    });

    assert.strictEqual(requests[0].url, "https://registry.npmjs.org/pkg");
    assert.deepStrictEqual(requests[0].options.headers, {
      accept: "application/json",
      "accept-encoding": "gzip, deflate, br",
      authorization: "Bearer token",
    });
  });

  it("returns the decoded body", async () => {
    const body = await fetchFullPackument("https://registry.npmjs.org/pkg", {});

    assert.strictEqual(body.toString("utf8"), '{"name":"pkg"}');
  });

  it("goes through the configured upstream HTTPS proxy", async () => {
    process.env.HTTPS_PROXY = "http://corporate-proxy:8080";

    await fetchFullPackument("https://registry.npmjs.org/pkg", {});

    assert.ok(requests[0].options.agent instanceof FakeProxyAgent);
    assert.strictEqual(requests[0].options.agent.url, "http://corporate-proxy:8080");
  });

  it("fails closed when the registry does not return the document", async () => {
    response = { statusCode: 404, headers: {}, body: Buffer.from("{}") };

    await assert.rejects(
      fetchFullPackument("https://registry.npmjs.org/pkg", {}),
      FailClosedError
    );
  });

  it("fails closed when the request errors", async () => {
    response = new Error("ECONNRESET");

    await assert.rejects(
      fetchFullPackument("https://registry.npmjs.org/pkg", {}),
      FailClosedError
    );
  });

  it("fails closed when the registry does not answer in time", async () => {
    response = "hang";

    await assert.rejects(
      fetchFullPackument("https://registry.npmjs.org/pkg", {}, 5),
      (err) => err instanceof FailClosedError && /timed out after 5 ms/.test(err.message)
    );
    assert.strictEqual(requests[0].timeoutMs, 5);
  });

  it("fails closed when the request cannot be created", async () => {
    response = "throw";

    await assert.rejects(
      fetchFullPackument("https://registry.npmjs.org/pkg", {}),
      (err) => err instanceof FailClosedError && /Invalid URL/.test(err.message)
    );
  });
});
