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
      fetchFullPackument: async (url, requestHeaders) => {
        fullPackumentCalls.push({ url, requestHeaders });
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
  const { FailClosedError } = await import("../../failClosedError.js");

  const cutoff = new Date(Date.now() - 48 * 3600 * 1000);
  const hoursAgo = (hours) =>
    new Date(Date.now() - hours * 3600 * 1000).toISOString();
  let exemptPackages = new Set();
  const checker = {
    isPackageExempt: (name) => exemptPackages.has(name),
    isTooNewByFeed: () => false,
    isTooNewByReleaseDate: (_name, _version, timestamp) =>
      new Date(timestamp) > cutoff,
  };
  const url = "https://registry.npmjs.org:443/pkg";

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
      body,
      headers,
      request: { url, headers: requestHeaders },
      checker,
      cutoff,
    });
  }

  const json = (value) => Buffer.from(JSON.stringify(value));
  const versionsOf = (result) =>
    Object.keys(JSON.parse(result.toString("utf8")).versions);

  beforeEach(() => {
    fullPackumentBody = undefined;
    fullPackumentCalls = [];
    exemptPackages = new Set();
  });

  describe("needsMetadataFiltering", () => {
    it("is false when the document was last modified before the cutoff", () => {
      const lastModified = new Date(Date.now() - 72 * 3600 * 1000).toUTCString();

      assert.strictEqual(
        needsMetadataFiltering(
          { statusCode: 200, headers: { "last-modified": lastModified } },
          cutoff
        ),
        false
      );
    });

    it("is true when the document was modified inside the window", () => {
      const lastModified = new Date(Date.now() - 3600 * 1000).toUTCString();

      assert.strictEqual(
        needsMetadataFiltering(
          { statusCode: 200, headers: { "last-modified": lastModified } },
          cutoff
        ),
        true
      );
    });

    it("is true when Last-Modified is missing or unparseable", () => {
      assert.strictEqual(
        needsMetadataFiltering({ statusCode: 200, headers: {} }, cutoff),
        true
      );
      assert.strictEqual(
        needsMetadataFiltering(
          { statusCode: 200, headers: { "last-modified": "yesterday" } },
          cutoff
        ),
        true
      );
    });

    it("is false for responses that are not successful", () => {
      for (const statusCode of [304, 404, 500]) {
        assert.strictEqual(
          needsMetadataFiltering({ statusCode, headers: {} }, cutoff),
          false
        );
      }
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
    assert.deepStrictEqual(fullPackumentCalls, [{ url, requestHeaders }]);
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

  it("forwards a body that cannot be parsed untouched", async () => {
    const body = Buffer.from("not json");

    const result = await run(body);

    assert.strictEqual(result, body);
    assert.strictEqual(fullPackumentCalls.length, 0);
  });

  it("filters an abbreviated document that carries publish times for every version", async () => {
    // Verdaccio includes `time` in abbreviated documents.
    const headers = {
      "content-type": "application/vnd.npm.install-v1+json",
      etag: '"abc"',
    };

    const result = await run(json(full(1)), headers);

    assert.deepStrictEqual(versionsOf(result), ["1.0.0"]);
    assert.strictEqual(fullPackumentCalls.length, 0);
    assert.strictEqual(headers.etag, undefined);
  });

  it("fetches the full document when publish times do not cover every version", async () => {
    fullPackumentBody = full(1);
    const partial = abbreviated(hoursAgo(1));
    partial.time = { "1.0.0": hoursAgo(1000) };

    const result = await run(json(partial));

    assert.strictEqual(fullPackumentCalls.length, 1);
    assert.deepStrictEqual(versionsOf(result), ["1.0.0"]);
  });

  it("serves the full document when it predates a version the abbreviated one lists", async () => {
    fullPackumentBody = full(72);
    const newer = abbreviated(hoursAgo(1));
    newer.versions["3.0.0"] = {};
    const headers = {
      "content-type": "application/vnd.npm.install-v1+json",
      etag: '"abc"',
    };

    const result = await run(json(newer), headers);

    assert.deepStrictEqual(versionsOf(result), ["1.0.0", "2.0.0"]);
    assert.strictEqual(headers["content-type"], "application/json");
    assert.strictEqual(headers.etag, undefined);
  });

  it("keeps exempt packages without fetching", async () => {
    exemptPackages.add("pkg");
    const body = json(abbreviated(hoursAgo(1)));

    const result = await run(body);

    assert.strictEqual(result, body);
    assert.strictEqual(fullPackumentCalls.length, 0);
  });

  it("fails closed when the full document is not a package document", async () => {
    fullPackumentBody = { error: "Not found" };

    await assert.rejects(run(json(abbreviated(hoursAgo(1)))), FailClosedError);
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
