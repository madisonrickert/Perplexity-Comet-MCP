// Single source of truth for CDP-related deadlines. Each constant carries an
// inline comment explaining the choice — please don't add a new timeout in a
// call site, add it here.

/** How often the connection layer pings the active target to detect dead WebSockets. */
export const HEARTBEAT_MS = 3000;

/** A heartbeat ping must respond within this window or the connection is declared dead. */
export const HEARTBEAT_FAIL_MS = 5000;

/** Server-side ceiling for Runtime.evaluate / Runtime.callFunctionOn. CDP enforces this. */
export const EVAL_OP_MS = 5000;

/** Client-side bound for cheap CDP methods (bringToFront, getTargetInfo, listTargets, etc.). */
export const SHORT_OP_MS = 2000;

/** comet_ask polling cadence between status checks. */
export const STATUS_POLL_INTERVAL_MS = 600;

/** Bound for a single getAgentStatus / state-probe round during polling. */
export const STATUS_POLL_TIMEOUT_MS = 4000;

/**
 * If the response text hasn't changed for this long and the stop button is
 * gone, comet_ask declares the answer complete. Works in concert with
 * isResponseStable() in comet-ai.ts which requires the same text across two
 * consecutive polls.
 */
export const RESPONSE_IDLE_MS = 3000;

/**
 * Minimum response length for the idle/completion exits. Set to 1 (any
 * non-empty text) intentionally — Perplexity can answer "yes"/"no"/"24.x"
 * legitimately. Stability + stop-button-gone are the real completion signals.
 */
export const RESPONSE_MIN_LEN = 1;

/**
 * Failsafe ceiling for "no progress at all" inside a comet_ask polling
 * loop — neither response-text changes nor new step entries. Past this
 * window we declare the agent stuck and return current state. Distinct
 * from RESPONSE_IDLE_MS (which exits on a settled-but-present response);
 * this fires even when no prose has appeared yet, so the loop doesn't
 * burn maxTimeout when the agent stalls before emitting anything.
 */
export const STUCK_TIMEOUT_MS = 60_000;
