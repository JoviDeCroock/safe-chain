import { clearCachingHeaders, getHeaderValueAsString } from "../../http-utils.js";
import { fetchFullPackument } from "./fullPackument.js";
import { modifyNpmInfoResponse } from "./modifyNpmInfo.js";

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
 * Whether a metadata response must be buffered for filtering. Last-Modified is
 * when the document last changed, so a document older than the cutoff cannot
 * hold a version published inside the minimum age window.
 * @param {NodeJS.Dict<string | string[]>} responseHeaders
 * @param {Date} cutoff
 * @returns {boolean}
 */
export function needsMetadataFiltering(responseHeaders, cutoff) {
  return !isBeforeCutoff(
    getHeaderValueAsString(responseHeaders, "last-modified"),
    cutoff
  );
}

/**
 * Removes versions inside the minimum age window from a metadata response,
 * while keeping the abbreviated document the client asked for whenever it is
 * already correct.
 *
 * Abbreviated documents carry no per-version publish times. When one changed
 * inside the window, the full document is fetched to filter it, and is served
 * only if a version was removed.
 *
 * @param {{
 *   targetUrl: string,
 *   body: Buffer,
 *   headers: NodeJS.Dict<string | string[]> | undefined,
 *   requestHeaders: NodeJS.Dict<string | string[]> | undefined,
 *   checker: import("../minimumPackageAgeChecker.js").MinimumPackageAgeChecker,
 *   cutoff: Date,
 * }} options
 * @returns {Promise<Buffer>}
 */
export async function filterPackageMetadata({
  targetUrl,
  body,
  headers,
  requestHeaders,
  checker,
  cutoff,
}) {
  if (body.byteLength === 0) {
    return body;
  }

  const metadata = tryParseJson(body);
  if (metadata !== undefined && !metadata?.versions) {
    // Not a package document (an error body or a single-version manifest).
    return body;
  }

  if (metadata?.time) {
    // The client asked for the full document, which can be filtered directly.
    return modifyNpmInfoResponse(body, headers, checker);
  }

  if (isBeforeCutoff(metadata?.modified, cutoff)) {
    return body;
  }

  const fullBody = await fetchFullPackument(targetUrl, requestHeaders);
  const filtered = modifyNpmInfoResponse(
    fullBody,
    { "content-type": "application/json" },
    checker
  );
  if (filtered === fullBody) {
    return body;
  }

  clearCachingHeaders(headers);
  if (headers) {
    headers["content-type"] = "application/json";
  }
  return filtered;
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
