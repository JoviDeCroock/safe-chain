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
 * @property {(predicate: (responseHeaders: NodeJS.Dict<string | string[]>) => boolean) => void} bufferResponseIf
 * @property {(response: {statusCode: number, headers: NodeJS.Dict<string>, body: Buffer}) => void} setSyntheticResponse
 * @property {() => RequestInterceptionHandler} build
 *
 *
 * @typedef {Object} RequestInterceptionHandler
 * @property {{statusCode: number, message: string} | undefined} blockResponse
 * @property {{statusCode: number, headers: NodeJS.Dict<string>, body: Buffer} | undefined} syntheticResponse
 * @property {(headers: NodeJS.Dict<string | string[]> | undefined) => NodeJS.Dict<string | string[]> | undefined} modifyRequestHeaders
 * @property {() => boolean} modifiesResponse
 * @property {(responseHeaders: NodeJS.Dict<string | string[]>) => boolean} shouldBufferResponse
 * @property {(body: Buffer, headers: NodeJS.Dict<string | string[]> | undefined, requestHeaders?: NodeJS.Dict<string | string[]>) => Promise<Buffer>} modifyBody
 *
 * @callback ModifyBodyFunc
 * @param {Buffer} body
 * @param {NodeJS.Dict<string | string[]> | undefined} headers Response headers.
 * @param {NodeJS.Dict<string | string[]> | undefined} requestHeaders The request
 *   headers as forwarded upstream, after modifyRequestHeaders ran.
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
  /** @type {Array<(responseHeaders: NodeJS.Dict<string | string[]>) => boolean>} */
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
     * @param {NodeJS.Dict<string | string[]>} [requestHeaders]
     * @returns {Promise<Buffer>}
     */
    async function modifyBody(body, headers, requestHeaders) {
      let modifiedBody = body;

      for (var func of modifyBodyFuncs) {
        modifiedBody = await func(body, headers, requestHeaders);
      }

      return modifiedBody;
    }

    /**
     * Whether the proxy should buffer the response body for modifyBody. An
     * interceptor can rule this out from the response headers alone, so the
     * response streams through instead of being buffered and decoded.
     * @param {NodeJS.Dict<string | string[]>} responseHeaders
     * @returns {boolean}
     */
    function shouldBufferResponse(responseHeaders) {
      return (
        modifyBodyFuncs.length > 0 &&
        bufferPredicates.every((predicate) => predicate(responseHeaders))
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
