import { EventEmitter } from "events";

/**
 * @typedef {Object} Interceptor
 * @property {(targetUrl: string) => Promise<RequestInterceptionHandler>} handleRequest
 * @property {(event: string, listener: (...args: any[]) => void) => Interceptor} on
 * @property {(event: string, ...args: any[]) => boolean} emit
 *
 *
 * @typedef {Object} RequestInterceptionContext
 * @property {string} targetUrl
 * @property {(packageName: string | undefined, version: string | undefined) => void} blockMalware
 * @property {(packageName: string, version: string, message: string) => void} blockMinimumAgeRequest
 * @property {(modificationFunc: (headers: NodeJS.Dict<string | string[]>) => NodeJS.Dict<string | string[]>) => void} modifyRequestHeaders
 * @property {(modificationFunc: ModifyBodyFunc) => void} modifyBody
 * @property {(predicate: (response: UpstreamResponse) => boolean) => void} bufferResponseIf
 * @property {(response: {statusCode: number, headers: NodeJS.Dict<string>, body: Buffer}) => void} setSyntheticResponse
 * @property {() => RequestInterceptionHandler} build
 *
 *
 * @typedef {Object} RequestInterceptionHandler
 * @property {{statusCode: number, message: string} | undefined} blockResponse
 * @property {{statusCode: number, headers: NodeJS.Dict<string>, body: Buffer} | undefined} syntheticResponse
 * @property {(headers: NodeJS.Dict<string | string[]> | undefined) => NodeJS.Dict<string | string[]> | undefined} modifyRequestHeaders
 * @property {() => boolean} modifiesResponse
 * @property {(response: UpstreamResponse) => boolean} shouldBufferResponse
 * @property {(body: Buffer, headers: NodeJS.Dict<string | string[]> | undefined, request?: UpstreamRequest) => Promise<Buffer>} modifyBody
 *
 * @typedef {Object} UpstreamResponse
 * @property {number} statusCode
 * @property {NodeJS.Dict<string | string[]>} headers
 *
 * @typedef {Object} UpstreamRequest The request as it was forwarded upstream.
 * @property {string} url Including a non-default port, unlike targetUrl.
 * @property {NodeJS.Dict<string | string[]>} headers After modifyRequestHeaders ran.
 *
 * @callback ModifyBodyFunc
 * @param {Buffer} body
 * @param {NodeJS.Dict<string | string[]> | undefined} headers Response headers.
 * @param {UpstreamRequest | undefined} request
 * @returns {Buffer | Promise<Buffer>}
 *
 * @typedef {Object} MalwareBlockedEvent
 * @property {string} packageName
 * @property {string} version
 * @property {string} targetUrl
 * @property {number} timestamp
 *
 * @typedef {Object} MinimumAgeRequestBlockedEvent
 * @property {string} packageName
 * @property {string} version
 * @property {string} targetUrl
 * @property {number} timestamp
 */

/**
 * @param {(requestHandlerBuilder: RequestInterceptionContext) => Promise<void>} requestInterceptionFunc
 * @returns {Interceptor}
 */
export function interceptRequests(requestInterceptionFunc) {
  return buildInterceptor([requestInterceptionFunc]);
}

/**
 * @param {Array<(requestHandlerBuilder: RequestInterceptionContext) => Promise<void>>} requestHandlers
 * @returns {Interceptor}
 */
function buildInterceptor(requestHandlers) {
  const eventEmitter = new EventEmitter();

  return {
    async handleRequest(targetUrl) {
      const requestContext = createRequestContext(targetUrl, eventEmitter);

      for (const handler of requestHandlers) {
        await handler(requestContext);
      }

      return requestContext.build();
    },
    on(event, listener) {
      eventEmitter.on(event, listener);
      return this;
    },
    emit(event, ...args) {
      return eventEmitter.emit(event, ...args);
    },
  };
}

/**
 * @param {string} targetUrl
 * @param {import('events').EventEmitter} eventEmitter
 * @returns {RequestInterceptionContext}
 */
function createRequestContext(targetUrl, eventEmitter) {
  /** @type {{statusCode: number, message: string} | undefined}  */
  let blockResponse = undefined;
  /** @type {{statusCode: number, headers: NodeJS.Dict<string>, body: Buffer} | undefined} */
  let syntheticResponse = undefined;
  /** @type {Array<(headers: NodeJS.Dict<string | string[]>) => NodeJS.Dict<string | string[]>>} */
  let reqheaderModificationFuncs = [];
  /** @type {Array<ModifyBodyFunc>} */
  let modifyBodyFuncs = [];
  /** @type {Array<(response: UpstreamResponse) => boolean>} */
  let bufferPredicates = [];

  /**
   * @param {string | undefined} packageName
   * @param {string | undefined} version
   */
  function blockMalwareSetup(packageName, version) {
    blockResponse = createBlockResponse("Forbidden - blocked by safe-chain");

    // Emit the malwareBlocked event
    eventEmitter.emit("malwareBlocked", {
      packageName,
      version,
      targetUrl,
      timestamp: Date.now(),
    });
  }

  /**
   * @param {string} message
   */
  function blockMinimumAgeRequestSetup(
    /** @type {string} */ packageName,
    /** @type {string} */ version,
    /** @type {string} */ message
  ) {
    blockResponse = createBlockResponse(message);
    eventEmitter.emit("minimumAgeRequestBlocked", {
      packageName,
      version,
      targetUrl,
      timestamp: Date.now(),
    });
  }

  /**
   * @param {string} message
   * @returns {{statusCode: number, message: string}}
   */
  function createBlockResponse(message) {
    return {
      statusCode: 403,
      message,
    };
  }

  /** @returns {RequestInterceptionHandler} */
  function build() {
    /**
     * @param {NodeJS.Dict<string | string[]> | undefined} headers
     * @returns {NodeJS.Dict<string | string[]> | undefined}
     */
    function modifyRequestHeaders(headers) {
      if (headers) {
        for (const func of reqheaderModificationFuncs) {
          func(headers);
        }
      }

      return headers;
    }

    /**
     * @param {Buffer} body
     * @param {NodeJS.Dict<string | string[]> | undefined} headers
     * @param {UpstreamRequest} [request]
     * @returns {Promise<Buffer>}
     */
    async function modifyBody(body, headers, request) {
      let modifiedBody = body;

      for (var func of modifyBodyFuncs) {
        modifiedBody = await func(body, headers, request);
      }

      return modifiedBody;
    }

    /**
     * Whether the proxy should buffer the response body for modifyBody. An
     * interceptor can rule this out from the status and headers alone, so the
     * response streams through instead of being buffered and decoded.
     * @param {UpstreamResponse} response
     * @returns {boolean}
     */
    function shouldBufferResponse(response) {
      return (
        modifyBodyFuncs.length > 0 &&
        bufferPredicates.every((predicate) => predicate(response))
      );
    }

    // These functions are invoked in the proxy, allowing to apply the configured modifications
    return {
      blockResponse,
      syntheticResponse,
      modifyRequestHeaders: modifyRequestHeaders,
      modifiesResponse: () => modifyBodyFuncs.length > 0,
      shouldBufferResponse,
      modifyBody,
    };
  }

  // These functions are used to setup the modifications
  return {
    targetUrl,
    blockMalware: blockMalwareSetup,
    blockMinimumAgeRequest: blockMinimumAgeRequestSetup,
    modifyRequestHeaders: (func) => reqheaderModificationFuncs.push(func),
    modifyBody: (func) => modifyBodyFuncs.push(func),
    bufferResponseIf: (predicate) => bufferPredicates.push(predicate),
    setSyntheticResponse: (response) => { syntheticResponse = response; },
    build,
  };
}
