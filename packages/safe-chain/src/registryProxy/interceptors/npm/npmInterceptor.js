import { getNpmCustomRegistries, skipMinimumPackageAge } from "../../../config/settings.js";
import { isMalwarePackage } from "../../../scanning/audit/index.js";
import { interceptRequests } from "../interceptorBuilder.js";
import { isPackageInfoUrl } from "./modifyNpmInfo.js";
import {
  filterPackageMetadata,
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
      const cutoff = getMinimumPackageAgeCutoff();
      reqContext.bufferResponseIf((headers) =>
        needsMetadataFiltering(headers, cutoff)
      );
      reqContext.modifyBody((body, headers, requestHeaders) =>
        filterPackageMetadata({
          targetUrl: reqContext.targetUrl,
          body,
          headers,
          requestHeaders,
          checker,
          cutoff,
        })
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
