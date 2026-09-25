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

  // Only update if we actually got headers (subscription login only). A header
  // that is present but unparseable is dropped rather than stored: NaN survives
  // the `!= null` check the dashboard filters on, so it would paint a gauge of
  // width NaN instead of falling back to the "no usage data yet" copy.
  applyHeader(state.fiveHour, h5, r5, s5);
  applyHeader(state.sevenDay, h7, r7, s7);
}

function applyHeader(target, utilization, reset, status) {
  if (utilization == null) return;
  const u = parseFloat(utilization);
  if (!Number.isFinite(u)) return;
  const at = parseInt(reset, 10);
  target.utilization = u;
  target.resetAt = Number.isFinite(at) ? at : null;
  target.status = status ?? null;
  state.lastUpdated = Date.now();
}

/**
 * Update state from a Claude Code `rate_limit_event` stream event.
 *
 * Headless Claude Code reports utilization directly in its stream:
 *
 *   rate_limit_info.unifiedWindows.five_hour = { utilization, resetsAt }
 *   rate_limit_info.unifiedWindows.seven_day = { utilization, resetsAt }
 *
 * More dependable than the response headers above, which only appear for
 * subscription logins and not on every response. `resetsAt` is Unix seconds,
 * matching what the header path stores.
 */
export function captureFromRateLimitEvent(info) {
  const windows = info?.unifiedWindows;
  if (!windows) return;

  const apply = (target, w, status) => {
    if (!w || !Number.isFinite(w.utilization)) return;
    target.utilization = w.utilization;
    target.resetAt = Number.isFinite(w.resetsAt) ? w.resetsAt : null;
    target.status = status ?? target.status ?? null;
    state.lastUpdated = Date.now();
  };

  apply(state.fiveHour, windows.five_hour, info.status);
  apply(state.sevenDay, windows.seven_day, info.overageStatus ?? info.status);
}

/**
 * A window whose reset time has passed has already rolled over: the quota is
 * fresh and utilization is back to zero. Nothing tells us that happened —
 * state only moves when a response comes back through the proxy or the agent —
 * so a quiet stretch left the last captured value standing indefinitely and the
 * dashboard kept showing a cap that expired hours ago. Restarting the process
 * cleared the module state, which is the only reason a restart appeared to fix
 * it. Age the windows out at read time instead.
 */
function windowView(w, nowSeconds) {
  if (w.resetAt != null && nowSeconds >= w.resetAt) {
    return { utilization: 0, resetAt: null, status: null };
  }
  return { ...w };
}

/**
 * Get current usage state for the dashboard. `now` is injectable for tests.
 */
export function getUsageState(now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  return {
    fiveHour: windowView(state.fiveHour, nowSeconds),
    sevenDay: windowView(state.sevenDay, nowSeconds),
    lastUpdated: state.lastUpdated,
  };
}

/**
 * Drop all captured usage. Exported for tests.
 */
export function resetUsageState() {
  state.fiveHour = { utilization: null, resetAt: null, status: null };
  state.sevenDay = { utilization: null, resetAt: null, status: null };
  state.lastUpdated = null;
}
