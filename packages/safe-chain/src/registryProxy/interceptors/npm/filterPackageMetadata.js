import { clearCachingHeaders, getHeaderValueAsString } from "../../http-utils.js";
import { FailClosedError } from "../../failClosedError.js";
import { fetchFullPackument } from "./fullPackument.js";
import { modifyNpmInfoResponse } from "./modifyNpmInfo.js";

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * Whether an HTTP date or ISO timestamp lies before the cutoff. Missing or
 * unparseable values are never treated as old.
 * @param {string | undefined} value
 * @param {Date} cutoff
 * @returns {boolean}
 */
export function isBeforeCutoff(value, cutoff) {
  if (typeof value !== "string") {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && time < cutoff.getTime();
}

/**
 * Whether a metadata response must be buffered for filtering. Only successful
 * responses carry a package document. Last-Modified is when the document last
 * changed, so a document older than the cutoff cannot hold a version published
 * inside the minimum age window.
 * @param {import("../interceptorBuilder.js").UpstreamResponse} response
 * @param {Date} cutoff
 * @returns {boolean}
 */
export function needsMetadataFiltering({ statusCode, headers }, cutoff) {
  return (
    isSuccessStatus(statusCode) &&
    !isBeforeCutoff(getHeaderValueAsString(headers, "last-modified"), cutoff)
  );
}

/**
 * @param {number} statusCode
 * @returns {boolean}
 */
export function isSuccessStatus(statusCode) {
  return statusCode >= 200 && statusCode < 300;
}

/**
 * Removes versions inside the minimum age window from a public npm registry
 * metadata response, while keeping the abbreviated document the client asked
 * for whenever it is already correct.
 *
 * Abbreviated documents carry no per-version publish times. When one changed
 * inside the window, the full document is fetched to filter it. The
 * abbreviated document is kept only if the full one vouches for every version
 * it lists and nothing was removed. The two are cached separately, so the full
 * document can be older than the abbreviated one; then the filtered full
 * document is served instead.
 *
 * Only for registries whose `modified` and Last-Modified are trusted to bound
 * every publish time in the document.
 *
 * @param {{
 *   body: Buffer,
 *   headers: NodeJS.Dict<string | string[]> | undefined,
 *   request: import("../interceptorBuilder.js").UpstreamRequest | undefined,
 *   checker: import("../minimumPackageAgeChecker.js").MinimumPackageAgeChecker,
 *   cutoff: Date,
 * }} options
 * @returns {Promise<Buffer>}
 */
export async function filterPackageMetadata({
  body,
  headers,
  request,
  checker,
  cutoff,
}) {
  const metadata = tryParseJson(body);
  if (!metadata?.versions || typeof metadata.versions !== "object") {
    // Empty, unparseable, an error body or a single-version manifest. The
    // client cannot resolve versions from it, so there is nothing to filter.
    return body;
  }

  if (checker.isPackageExempt(metadata.name)) {
    return body;
  }

  const versions = Object.keys(metadata.versions);
  if (hasTimeFor(metadata, versions)) {
    const filtered = modifyNpmInfoResponse(body, JSON_HEADERS, checker);
    if (filtered !== body) {
      clearCachingHeaders(headers);
    }
    return filtered;
  }

  if (isBeforeCutoff(metadata.modified, cutoff)) {
    return body;
  }

  if (!request) {
    throw new FailClosedError("No upstream request to fetch full package metadata");
  }
  const fullBody = await fetchFullPackument(request.url, request.headers);
  const full = tryParseJson(fullBody);
  if (!full?.versions || !full.time) {
    throw new FailClosedError("Full package metadata is not a package document");
  }

  const filtered = modifyNpmInfoResponse(fullBody, JSON_HEADERS, checker);
  if (filtered === fullBody && hasTimeFor(full, versions)) {
    return body;
  }

  clearCachingHeaders(headers);
  if (headers) {
    headers["content-type"] = "application/json";
  }
  return filtered;
}

/**
 * @param {any} metadata
 * @param {string[]} versions
 * @returns {boolean}
 */
function hasTimeFor(metadata, versions) {
  const time = metadata.time;
  return (
    !!time &&
    typeof time === "object" &&
    versions.every((version) => typeof time[version] === "string")
  );
}

/**
 * @param {Buffer} body
 * @returns {any}
 */
function tryParseJson(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}
