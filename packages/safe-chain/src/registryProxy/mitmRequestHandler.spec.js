import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";
import zlib from "node:zlib";
import { interceptRequests } from "./interceptors/interceptorBuilder.js";

describe("mitmRequestHandler", async () => {
  let capturedHandler;
  let capturedOptions;
  let upstreamStatusCode;
  let upstreamHeaders;
  let upstreamBody;
  let upstreamError;
  let malwarePackage;
  let newlyReleasedPackage;
  const writeError = mock.fn();

  beforeEach(() => {
    capturedOptions = undefined;
    upstreamStatusCode = 200;
    upstreamHeaders = {
      "content-encoding": "gzip",
      "content-length": "999",
      "transfer-encoding": "chunked",
      etag: '"upstream"',
      "cache-control": "public, max-age=300",
    };
    upstreamBody = zlib.gzipSync(Buffer.from("rewritten body"));
    upstreamError = undefined;
    malwarePackage = false;
    newlyReleasedPackage = false;
    writeError.mock.resetCalls();
  });

  mock.module("https", {
    defaultExport: {
      createServer: (_options, handler) => {
        capturedHandler = handler;
        return {
          on: () => {},
          emit: () => {},
        };
      },
      request: (options, callback) => {
        capturedOptions = options;

        const listeners = {};
        const proxyRes = {
          statusCode: upstreamStatusCode,
          headers: upstreamHeaders,
          on: (event, handler) => {
            listeners[event] = handler;
          },
        };

        callback(proxyRes);

        return {
          on: () => {},
          write: () => {},
          end: () => {
            if (upstreamError) {
              listeners["error"]?.(upstreamError);
              return;
            }
            if (upstreamBody.byteLength > 0) {
              listeners["data"]?.(upstreamBody);
            }
            listeners["end"]?.();
          },
          destroy: () => {},
        };
      },
    },
  });

  mock.module("./certUtils.js", {
    namedExports: {
      generateCertForHost: () => ({
        privateKey: "key",
        certificate: "cert",
      }),
    },
  });

  mock.module("https-proxy-agent", {
    namedExports: {
      HttpsProxyAgent: class {},
    },
  });

  mock.module("../environment/userInteraction.js", {
    namedExports: {
      ui: {
        writeVerbose: () => {},
        writeError,
      },
    },
  });

  mock.module("../config/settings.js", {
    namedExports: {
      ECOSYSTEM_PY: "py",
      getEcoSystem: () => "js",
      getNpmCustomRegistries: () => [],
      getMinimumPackageAgeHours: () => 48,
      getMinimumPackageAgeExclusions: () => [],
      skipMinimumPackageAge: () => false,
    },
  });
  mock.module("../scanning/audit/index.js", {
    namedExports: { isMalwarePackage: async () => malwarePackage },
  });
  mock.module("../scanning/newPackagesListCache.js", {
    namedExports: {
      openNewPackagesDatabase: async () => ({
        isNewlyReleasedPackage: () => newlyReleasedPackage,
      }),
    },
  });
  mock.module("../scanning/safePatchesListCache.js", {
    namedExports: {
      openSafePatchesDatabase: async () => ({ isSafePatch: () => false }),
    },
  });

  const { mitmConnect } = await import("./mitmRequestHandler.js");
  const { npmInterceptorForUrl } = await import("./interceptors/npm/npmInterceptor.js");

  it("sets content-length from the final uncompressed payload after body rewrite", async () => {
    const interceptor = {
      handleRequest: async () => ({
        blockResponse: undefined,
        modifyRequestHeaders: (headers) => headers,
        modifiesResponse: () => true,
        modifyBody: () => Buffer.from("rewritten body"),
      }),
    };

    const req = {
      url: "pypi.org:443",
    };

    const clientSocket = {
      on: () => {},
      write: () => {},
      headersSent: false,
      writable: true,
      end: () => {},
    };

    mitmConnect(req, clientSocket, interceptor);

    const resState = {
      statusCode: undefined,
      headers: undefined,
      body: undefined,
    };

    const res = {
      headersSent: false,
      writeHead: (statusCode, headers) => {
        resState.statusCode = statusCode;
        resState.headers = headers;
      },
      end: (body) => {
        resState.body = body;
      },
    };

    const request = {
      url: "/simple/example/",
      headers: {},
      method: "GET",
      on: (event, handler) => {
        if (event === "end") {
          handler();
        }
      },
    };

    await capturedHandler(request, res);

    assert.equal(capturedOptions.hostname, "pypi.org");
    assert.equal(resState.statusCode, 200);
    assert.equal(resState.headers["transfer-encoding"], undefined);
    assert.equal(
      resState.headers["content-length"],
      String(resState.body.byteLength)
    );
  });

  it("forwards the upstream response verbatim when the interceptor leaves the body unchanged", async () => {
    const interceptor = {
      handleRequest: async () => ({
        blockResponse: undefined,
        modifyRequestHeaders: (headers) => headers,
        modifiesResponse: () => true,
        // Return the same buffer reference we were given (no modification).
        modifyBody: (body) => body,
      }),
    };

    const req = {
      url: "registry.npmjs.org:443",
    };

    const clientSocket = {
      on: () => {},
      write: () => {},
      headersSent: false,
      writable: true,
      end: () => {},
    };

    mitmConnect(req, clientSocket, interceptor);

    const resState = {
      statusCode: undefined,
      headers: undefined,
      body: undefined,
    };

    const res = {
      headersSent: false,
      writeHead: (statusCode, headers) => {
        resState.statusCode = statusCode;
        resState.headers = headers;
      },
      end: (body) => {
        resState.body = body;
      },
    };

    const request = {
      url: "/lodash",
      headers: {},
      method: "GET",
      on: (event, handler) => {
        if (event === "end") {
          handler();
        }
      },
    };

    await capturedHandler(request, res);

    // Caching/encoding headers are preserved so npm and the registry can keep
    // serving the response from cache instead of re-reading on the next install.
    assert.equal(resState.statusCode, 200);
    assert.equal(resState.headers["content-encoding"], "gzip");
    assert.equal(resState.headers["content-length"], "999");
    assert.equal(resState.headers["transfer-encoding"], "chunked");
    // The body is forwarded still-compressed, exactly as received from upstream.
    assert.deepEqual(resState.body, zlib.gzipSync(Buffer.from("rewritten body")));
  });

  async function makeRequest(interceptor, method = "GET", path = "/example") {
    mitmConnect(
      { url: "registry.npmjs.org:443" },
      { on: () => {}, write: () => {} },
      interceptor
    );
    const response = {
      headersSent: false,
      statusCode: undefined,
      headers: undefined,
      body: undefined,
      writeHead(statusCode, headers) {
        this.headersSent = true;
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await capturedHandler(
      {
        url: path,
        headers: {},
        method,
        on(event, handler) {
          if (event === "end") handler();
        },
      },
      response
    );
    return response;
  }

  for (const [method, statusCode, encoding] of [
    ["HEAD", 200, "gzip"],
    ["HEAD", 200, undefined],
    ["GET", 200, "gzip"],
    ["GET", 204, "gzip"],
    ["GET", 304, "gzip"],
  ]) {
    it(`forwards empty ${method} ${statusCode} responses with ${encoding || "no"} encoding without processing or errors`, async () => {
      upstreamStatusCode = statusCode;
      upstreamHeaders["content-encoding"] = encoding;
      delete upstreamHeaders["transfer-encoding"];
      if (statusCode === 204) delete upstreamHeaders["content-length"];
      upstreamBody = Buffer.alloc(0);
      // A body modifier must never synthesize content for a bodiless response.
      const modifyBody = mock.fn(() => Buffer.from("unexpected body"));
      const interceptor = interceptRequests(async (context) => {
        context.modifyBody(modifyBody);
      });

      const response = await makeRequest(interceptor, method);

      assert.equal(capturedOptions.method, method);
      assert.equal(response.statusCode, statusCode);
      assert.strictEqual(response.headers, upstreamHeaders);
      assert.deepEqual(response.body, Buffer.alloc(0));
      assert.equal(modifyBody.mock.callCount(), 0);
      assert.equal(writeError.mock.callCount(), 0);
    });
  }

  it("still filters nonempty gzip responses even when content-length claims zero", async () => {
    upstreamHeaders["content-length"] = "0";
    const modifyBody = mock.fn((body) => {
      assert.equal(body.toString(), "rewritten body");
      return Buffer.from("filtered body");
    });
    const interceptor = interceptRequests(async (context) => {
      context.modifyBody(modifyBody);
    });

    const response = await makeRequest(interceptor);

    assert.equal(modifyBody.mock.callCount(), 1);
    assert.equal(response.body.toString(), "filtered body");
    assert.equal(response.headers["content-length"], "13");
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers["transfer-encoding"], undefined);
    assert.equal(writeError.mock.callCount(), 0);
  });

  it("processes a nonempty gzip stream that decompresses to an empty body", async () => {
    upstreamBody = zlib.gzipSync(Buffer.alloc(0));
    const modifyBody = mock.fn((body) => body);
    const interceptor = interceptRequests(async (context) => {
      context.modifyBody(modifyBody);
    });

    const response = await makeRequest(interceptor);

    assert.equal(modifyBody.mock.callCount(), 1);
    assert.equal(modifyBody.mock.calls[0].arguments[0].byteLength, 0);
    assert.strictEqual(response.headers, upstreamHeaders);
    assert.deepEqual(response.body, upstreamBody);
    assert.equal(writeError.mock.callCount(), 0);
  });

  for (const payload of [
    Buffer.from("invalid gzip"),
    zlib.gzipSync(Buffer.from("metadata")).subarray(0, 10),
  ]) {
    it(`keeps reporting and forwarding malformed nonempty gzip (${payload.byteLength} bytes)`, async () => {
      upstreamBody = payload;
      const modifyBody = mock.fn((body) => body);
      const interceptor = interceptRequests(async (context) => {
        context.modifyBody(modifyBody);
      });

      const response = await makeRequest(interceptor);

      assert.equal(response.statusCode, 200);
      assert.strictEqual(response.headers, upstreamHeaders);
      assert.deepEqual(response.body, payload);
      assert.equal(modifyBody.mock.callCount(), 0);
      assert.equal(writeError.mock.callCount(), 1);
      assert.match(
        writeError.mock.calls[0].arguments[0],
        /Failed to process response body/
      );
    });
  }

  it("still reports an upstream error instead of treating it as a successful empty response", async () => {
    upstreamBody = Buffer.alloc(0);
    upstreamError = new Error("aborted");
    const modifyBody = mock.fn((body) => body);
    const interceptor = interceptRequests(async (context) => {
      context.modifyBody(modifyBody);
    });

    const response = await makeRequest(interceptor);

    assert.equal(response.statusCode, 502);
    assert.equal(response.body, "Bad Gateway");
    assert.equal(modifyBody.mock.callCount(), 0);
    assert.equal(writeError.mock.callCount(), 1);
    assert.match(writeError.mock.calls[0].arguments[0], /Error reading upstream/);
  });

  for (const method of ["HEAD", "GET"]) {
    for (const reason of ["malware", "minimum age"]) {
      it(`blocks ${reason} ${method} requests before contacting upstream`, async () => {
        upstreamBody = Buffer.alloc(0);
        const modifyBody = mock.fn((body) => body);
        const interceptor = interceptRequests(async (context) => {
          if (reason === "malware") {
            context.blockMalware("example", "1.0.0");
          } else {
            context.blockMinimumAgeRequest("example", "1.0.0", "Too new");
          }
          context.modifyBody(modifyBody);
        });
        const blocked = mock.fn();
        interceptor.on(
          reason === "malware" ? "malwareBlocked" : "minimumAgeRequestBlocked",
          blocked
        );

        const response = await makeRequest(interceptor, method);

        assert.equal(response.statusCode, 403);
        assert.equal(capturedOptions, undefined);
        assert.equal(modifyBody.mock.callCount(), 0);
        assert.equal(blocked.mock.callCount(), 1);
        assert.equal(writeError.mock.callCount(), 0);
      });
    }
  }

  it("forwards an npm metadata HEAD response without errors with minimum age enabled", async () => {
    upstreamBody = Buffer.alloc(0);
    delete upstreamHeaders["transfer-encoding"];
    const interceptor = npmInterceptorForUrl("https://registry.npmjs.org/example");

    const response = await makeRequest(interceptor, "HEAD");

    assert.equal(response.statusCode, 200);
    assert.strictEqual(response.headers, upstreamHeaders);
    assert.equal(response.body.byteLength, 0);
    assert.equal(writeError.mock.callCount(), 0);
  });

  it("still removes young versions from gzip npm metadata after an empty HEAD response", async () => {
    const interceptor = npmInterceptorForUrl("https://registry.npmjs.org/example");
    upstreamBody = Buffer.alloc(0);
    await makeRequest(interceptor, "HEAD");

    upstreamHeaders["content-type"] = "application/json";
    upstreamBody = zlib.gzipSync(Buffer.from(JSON.stringify({
      name: "example",
      "dist-tags": { latest: "2.0.0" },
      versions: { "1.0.0": {}, "2.0.0": {} },
      time: {
        "1.0.0": new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
        "2.0.0": new Date().toISOString(),
      },
    })));

    const response = await makeRequest(interceptor);
    const metadata = JSON.parse(response.body.toString());

    assert.deepEqual(Object.keys(metadata.versions), ["1.0.0"]);
    assert.equal(metadata["dist-tags"].latest, "1.0.0");
    assert.equal(metadata.time["2.0.0"], undefined);
    assert.equal(response.headers["content-encoding"], undefined);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["content-length"], String(response.body.byteLength));
    assert.equal(writeError.mock.callCount(), 0);
  });

  for (const method of ["HEAD", "GET"]) {
    for (const reason of ["malware", "minimum age"]) {
      it(`still enforces npm ${reason} blocking for ${method} tarball requests`, async () => {
        malwarePackage = reason === "malware";
        newlyReleasedPackage = reason === "minimum age";
        upstreamBody = Buffer.alloc(0);
        const path = "/example/-/example-1.0.0.tgz";
        const interceptor = npmInterceptorForUrl(`https://registry.npmjs.org${path}`);

        const response = await makeRequest(interceptor, method, path);

        assert.equal(response.statusCode, 403);
        assert.equal(capturedOptions, undefined);
        assert.match(response.body, /Forbidden - blocked by safe-chain/);
        assert.equal(writeError.mock.callCount(), 0);
      });
    }
  }
});
