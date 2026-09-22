/**
 * In-memory usage state captured from Anthropic's `anthropic-ratelimit-unified-*`
 * response headers. Updated on every proxied response.
 *
 * Headers (subscription/Pro/Max logins only):
 *   anthropic-ratelimit-unified-5h-utilization   0..1 fraction
 *   anthropic-ratelimit-unified-5h-reset         Unix epoch seconds
 *   anthropic-ratelimit-unified-5h-status        "allowed" | ?
 *   anthropic-ratelimit-unified-7d-utilization    0..1 fraction
 *   anthropic-ratelimit-unified-7d-reset         Unix epoch seconds
 *   anthropic-ratelimit-unified-7d-status        "allowed" | ?
 */

const state = {
  fiveHour: { utilization: null, resetAt: null, status: null },
  sevenDay: { utilization: null, resetAt: null, status: null },
  lastUpdated: null,
};

/**
 * Extract unified rate-limit headers from an HTTP response and update state.
 */
export function captureFromHeaders(headers) {
  const get = (name) => {
    const val = headers[name];
    return Array.isArray(val) ? val[0] : val;
  };

  const h5 = get("anthropic-ratelimit-unified-5h-utilization");
  const r5 = get("anthropic-ratelimit-unified-5h-reset");
  const s5 = get("anthropic-ratelimit-unified-5h-status");
  const h7 = get("anthropic-ratelimit-unified-7d-utilization");
  const r7 = get("anthropic-ratelimit-unified-7d-reset");
  const s7 = get("anthropic-ratelimit-unified-7d-status");

  // Only update if we actually got headers (subscription login only)
  if (h5 != null) {
    state.fiveHour.utilization = parseFloat(h5);
    state.fiveHour.resetAt = r5 ? parseInt(r5, 10) : null;
    state.fiveHour.status = s5 ?? null;
    state.lastUpdated = Date.now();
  }
  if (h7 != null) {
    state.sevenDay.utilization = parseFloat(h7);
    state.sevenDay.resetAt = r7 ? parseInt(r7, 10) : null;
    state.sevenDay.status = s7 ?? null;
    state.lastUpdated = Date.now();
  }
}

/**
 * Get current usage state for the dashboard.
 */
export function getUsageState() {
  return { ...state };
}
