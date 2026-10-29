/**
 * Thrown by a body modification that could not do its check. The proxy answers
 * 502 instead of forwarding the response unchecked, so the client fails or
 * retries rather than installing from metadata that was never filtered.
 */
export class FailClosedError extends Error {}
