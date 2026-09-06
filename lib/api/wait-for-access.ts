// Poll the same gate Explore uses (`GET /api/feed` → 402 until hasAccess)
// until the webhook has written the row. Stripe confirmPayment only means
// the card was charged — jumping to /explore before that lands shows the
// access wall, and a later hard refresh "fixes" it.
//
// Timeout is fail-closed on the URL (still hard-navigate to /explore) so
// the member is never stuck on checkout. It is never fail-open on content.

export const ACCESS_POLL_TIMEOUT_MS = 20_000;
export const ACCESS_POLL_INTERVAL_MS = 400;

export function goToExploreAfterPay(): void {
  window.location.assign("/explore");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function waitForEntitled(options?: {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? ACCESS_POLL_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? ACCESS_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    if (options?.signal?.aborted) return false;
    try {
      const res = await fetch("/api/feed?limit=1", {
        cache: "no-store",
        signal: options?.signal,
      });
      if (res.status === 401) return false;
      if (res.ok) return true;
    } catch (err) {
      if (options?.signal?.aborted) return false;
      if (err instanceof DOMException && err.name === "AbortError") return false;
    }
    if (Date.now() + intervalMs > deadline) break;
    try {
      await sleep(intervalMs, options?.signal);
    } catch {
      return false;
    }
  }
  return false;
}
