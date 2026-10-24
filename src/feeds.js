const TIMEOUT_MS = 10_000;

// Whether this page may read a cross-origin response from `url`. Any readable response passes,
// whatever its HTTP status; a network-level error (what a missing CORS header looks like) or
// no response headers within the timeout fails. The body is never read.
export async function checkFeedAccess(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchImpl(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort(); // stop the body download if headers arrived
  }
}
