import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { decodeBody } from "../../decodeBody.js";
import { FailClosedError } from "../../failClosedError.js";

const FULL_PACKUMENT_TIMEOUT_MS = 60_000;

/**
 * Fetches the full package document (with per-version publish times) for a
 * metadata URL the client requested in abbreviated form. The client's own
 * request headers are reused, so registry authentication carries over.
 *
 * @param {string} url The upstream URL, including a non-default port.
 * @param {NodeJS.Dict<string | string[]> | undefined} requestHeaders
 * @param {number} [timeoutMs]
 * @returns {Promise<Buffer>}
 */
export function fetchFullPackument(
  url,
  requestHeaders,
  timeoutMs = FULL_PACKUMENT_TIMEOUT_MS
) {
  /** @type {NodeJS.Dict<string | string[]>} */
  const headers = {
    ...requestHeaders,
    accept: "application/json",
    "accept-encoding": "gzip, deflate, br",
  };
  // Validators belong to the abbreviated document and must not produce a 304.
  delete headers["if-none-match"];
  delete headers["if-modified-since"];
  delete headers.host;

  /** @type {import("https").RequestOptions} */
  const options = { headers };
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (httpsProxy) {
    options.agent = new HttpsProxyAgent(httpsProxy);
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, options, (response) => {
      /** @type {Buffer[]} */
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", (err) =>
        reject(new FailClosedError(`Full package metadata read failed: ${err.message}`))
      );
      response.on("end", async () => {
        if (response.statusCode !== 200) {
          reject(
            new FailClosedError(
              `Full package metadata request returned ${response.statusCode}`
            )
          );
          return;
        }

        try {
          resolve(
            await decodeBody(
              Buffer.concat(chunks),
              response.headers["content-encoding"]
            )
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          reject(new FailClosedError(`Full package metadata decode failed: ${message}`));
        }
      });
    });

    request.on("error", (err) =>
      reject(new FailClosedError(`Full package metadata request failed: ${err.message}`))
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error(`timed out after ${timeoutMs} ms`))
    );
  });
}
