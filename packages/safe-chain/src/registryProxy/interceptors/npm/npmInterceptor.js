import { getNpmCustomRegistries, skipMinimumPackageAge } from "../../../config/settings.js";
import { isMalwarePackage } from "../../../scanning/audit/index.js";
import { interceptRequests } from "../interceptorBuilder.js";
import {
  isPackageInfoUrl,
  modifyNpmInfoRequestHeaders,
  modifyNpmInfoResponse,
} from "./modifyNpmInfo.js";
import {
  filterPackageMetadata,
  isSuccessStatus,
  needsMetadataFiltering,
} from "./filterPackageMetadata.js";
import { parseNpmPackageUrl } from "./parseNpmPackageUrl.js";
import { openMinimumPackageAgeChecker } from "../minimumPackageAgeChecker.js";
import { getMinimumPackageAgeCutoff } from "../../../scanning/minimumPackageAgeCutoff.js";

const knownJsRegistries = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmjs.com",
];

/**
 * @param {NodeJS.Dict<string | string[]>} headers
 * @returns {NodeJS.Dict<string | string[]>}
 */
function stripConditionalHeaders(headers) {
  delete headers["if-none-match"];
  delete headers["if-modified-since"];
  return headers;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isPublicNpmRegistry(url) {
  return knownJsRegistries.includes(new URL(url).hostname);
}

/**
 * @param {string} url
 * @returns {import("../interceptorBuilder.js").Interceptor | undefined}
 */
export function npmInterceptorForUrl(url) {
  const registry = [...knownJsRegistries, ...getNpmCustomRegistries()].find(
    (reg) => url.includes(reg)
  );

  if (registry) {
    return buildNpmInterceptor(registry);
  }

  return undefined;
}

/**
 * @param {string} registry
 * @returns {import("../interceptorBuilder.js").Interceptor}
 */
function buildNpmInterceptor(registry) {

  return interceptRequests(async (reqContext) => {
    const { packageName, version } = parseNpmPackageUrl(
      reqContext.targetUrl,
      registry
    );

    if (await isMalwarePackage(packageName, version)) {
      reqContext.blockMalware(packageName, version);
      return;
    }

    if (skipMinimumPackageAge()) {
      // Bail out before opening any minimum-age database: when the check is
      // globally disabled there is nothing further to look up.
      return;
    }

    if (isPackageInfoUrl(reqContext.targetUrl)) {
      const checker = await openMinimumPackageAgeChecker();

      if (!isPublicNpmRegistry(reqContext.targetUrl)) {
        // A custom registry may merge upstreams or proxy lazily, so its
        // abbreviated documents and Last-Modified are not trusted to bound
        // publish times. Always request and filter the full document.
        reqContext.modifyRequestHeaders(modifyNpmInfoRequestHeaders);
        reqContext.bufferResponseIf(({ statusCode }) => isSuccessStatus(statusCode));
        reqContext.modifyBody((body, headers) =>
          modifyNpmInfoResponse(body, headers, checker)
        );
        return;
      }

      const cutoff = getMinimumPackageAgeCutoff();
      // A 304 carries no body to filter, so the client would reuse whatever it
      // cached, possibly a document fetched without safe-chain. Always ask for
      // the document itself.
      reqContext.modifyRequestHeaders(stripConditionalHeaders);
      reqContext.bufferResponseIf((response) =>
        needsMetadataFiltering(response, cutoff)
      );
      reqContext.modifyBody((body, headers, request) =>
        filterPackageMetadata({ body, headers, request, checker, cutoff })
      );
      return;
    }

    // For tarball requests the metadata check above is skipped, so we check the
    // new packages list as a fallback (covers e.g. frozen-lockfile installs).
    if (packageName && version) {
      const checker = await openMinimumPackageAgeChecker();

      if (
        !checker.isPackageExempt(packageName) &&
        checker.isTooNewByFeed(packageName, version)
      ) {
        reqContext.blockMinimumAgeRequest(
          packageName,
          version,
          `Forbidden - blocked by safe-chain direct download minimum package age (${packageName}@${version})`
        );
      }
    }
  });
}
