import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert";

describe("filterPackageMetadata", async () => {
  let fullPackumentBody;
  let fullPackumentCalls = [];

  mock.module("../../../config/settings.js", {
    namedExports: {
      getMinimumPackageAgeHours: () => 48,
    },
  });
  mock.module("../../../environment/userInteraction.js", {
    namedExports: {
      ui: { writeVerbose: () => {}, writeWarning: () => {} },
    },
  });
  mock.module("./fullPackument.js", {
    namedExports: {
      fetchFullPackument: async (targetUrl, requestHeaders) => {
        fullPackumentCalls.push({ targetUrl, requestHeaders });
        if (fullPackumentBody instanceof Error) {
          throw fullPackumentBody;
        }
        return Buffer.from(JSON.stringify(fullPackumentBody));
      },
    },
  });

  const { filterPackageMetadata, needsMetadataFiltering } = await import(
    "./filterPackageMetadata.js"
  );

  const cutoff = new Date(Date.now() - 48 * 3600 * 1000);
  const hoursAgo = (hours) =>
    new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const checker = {
    isPackageExempt: () => false,
    isTooNewByFeed: () => false,
    isTooNewByReleaseDate: (_name, _version, timestamp) =>
      new Date(timestamp) > cutoff,
  };
  const targetUrl = "https://registry.npmjs.org/pkg";

  function abbreviated(modified) {
    return {
      name: "pkg",
      modified,
      "dist-tags": { latest: "2.0.0" },
      versions: { "1.0.0": {}, "2.0.0": {} },
    };
  }

  function full(newestPublishedHoursAgo) {
    return {
      name: "pkg",
      "dist-tags": { latest: "2.0.0" },
      versions: { "1.0.0": {}, "2.0.0": {} },
      time: {
        created: hoursAgo(1000),
        modified: hoursAgo(newestPublishedHoursAgo),
        "1.0.0": hoursAgo(1000),
        "2.0.0": hoursAgo(newestPublishedHoursAgo),
      },
    };
  }

  function run(body, headers = {}, requestHeaders = {}) {
    return filterPackageMetadata({
      targetUrl,
      body,
      headers,
      requestHeaders,
      checker,
      cutoff,
    });
  }

  beforeEach(() => {
    fullPackumentBody = undefined;
    fullPackumentCalls = [];
  });

  describe("needsMetadataFiltering", () => {
    it("is false when the document was last modified before the cutoff", () => {
      const lastModified = new Date(Date.now() - 72 * 3600 * 1000).toUTCString();

      assert.strictEqual(
        needsMetadataFiltering({ "last-modified": lastModified }, cutoff),
        false
      );
    });

    it("is true when the document was modified inside the window", () => {
      const lastModified = new Date(Date.now() - 3600 * 1000).toUTCString();

      assert.strictEqual(
        needsMetadataFiltering({ "last-modified": lastModified }, cutoff),
        true
      );
    });

    it("is true when Last-Modified is missing or unparseable", () => {
      assert.strictEqual(needsMetadataFiltering({}, cutoff), true);
      assert.strictEqual(
        needsMetadataFiltering({ "last-modified": "yesterday" }, cutoff),
        true
      );
    });
  });

  it("keeps an abbreviated document modified before the cutoff without fetching", async () => {
    const body = Buffer.from(JSON.stringify(abbreviated(hoursAgo(72))));

    const result = await run(body);

    assert.strictEqual(result, body);
    assert.strictEqual(fullPackumentCalls.length, 0);
  });

  it("serves the filtered full document when a recent version is removed", async () => {
    fullPackumentBody = full(1);
    const headers = {
      "content-type": "application/vnd.npm.install-v1+json",
      etag: '"abc"',
      "last-modified": new Date().toUTCString(),
      "cache-control": "max-age=300",
    };
    const requestHeaders = { authorization: "Bearer token" };

    const result = await run(
      Buffer.from(JSON.stringify(abbreviated(hoursAgo(1)))),
      headers,
      requestHeaders
    );

    const served = JSON.parse(result.toString("utf8"));
    assert.deepStrictEqual(Object.keys(served.versions), ["1.0.0"]);
    assert.strictEqual(served["dist-tags"].latest, "1.0.0");
    assert.deepStrictEqual(fullPackumentCalls, [{ targetUrl, requestHeaders }]);
    assert.strictEqual(headers["content-type"], "application/json");
    assert.strictEqual(headers.etag, undefined);
    assert.strictEqual(headers["last-modified"], undefined);
    assert.strictEqual(headers["cache-control"], undefined);
  });

  it("keeps the abbreviated document when the full document has nothing to remove", async () => {
    fullPackumentBody = full(72);
    const headers = { etag: '"abc"' };
    const body = Buffer.from(JSON.stringify(abbreviated(hoursAgo(1))));

    const result = await run(body, headers);

    assert.strictEqual(result, body);
    assert.strictEqual(fullPackumentCalls.length, 1);
    assert.strictEqual(headers.etag, '"abc"');
  });

  it("filters a full document the client requested without fetching it again", async () => {
    const result = await run(Buffer.from(JSON.stringify(full(1))), {
      "content-type": "application/json",
    });

    assert.deepStrictEqual(
      Object.keys(JSON.parse(result.toString("utf8")).versions),
      ["1.0.0"]
    );
    assert.strictEqual(fullPackumentCalls.length, 0);
  });

  it("fetches the full document when the body cannot be parsed", async () => {
    fullPackumentBody = full(1);

    const result = await run(Buffer.from("not json"));

    assert.strictEqual(fullPackumentCalls.length, 1);
    assert.deepStrictEqual(
      Object.keys(JSON.parse(result.toString("utf8")).versions),
      ["1.0.0"]
    );
  });

  it("leaves bodies that are not package documents untouched", async () => {
    const body = Buffer.from(JSON.stringify({ error: "Not found" }));

    const result = await run(body);

    assert.strictEqual(result, body);
    assert.strictEqual(fullPackumentCalls.length, 0);
  });

  it("propagates a failed full document fetch", async () => {
    fullPackumentBody = new Error("registry unreachable");

    await assert.rejects(
      run(Buffer.from(JSON.stringify(abbreviated(hoursAgo(1))))),
      /registry unreachable/
    );
  });
});
