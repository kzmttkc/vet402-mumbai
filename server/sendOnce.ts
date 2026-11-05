const REQUEST_TIMEOUT_MS = 30_000

/**
 * Sends one HTTP request, exactly once. It never retries on its own: a dropped connection
 * or a timeout throws, and what to do next is the caller's decision. Retrying a paid
 * request by accident could put a second payment on the same answer.
 *
 * Connections are not reused (`keepalive: false`, `Connection: close`), because an HTTP client
 * may quietly replay a request when a reused connection turns out to be dead.
 * Redirects are refused, so a catalog URL cannot bounce the agent to another address.
 */
export function sendOnce(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: init.method,
    headers: { ...init.headers, Connection: 'close' },
    body: init.body,
    redirect: 'error',
    keepalive: false,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}
