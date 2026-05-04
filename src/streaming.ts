// MCP progress-notification helpers.
//
// `comet_ask` runs an internal CDP polling loop that can take minutes. The
// MCP protocol supports `notifications/progress` — out-of-band JSON-RPC
// messages a server emits during a long-running tool call so the client
// can render partial state without round-tripping a separate `comet_poll`
// tool. This module wraps the SDK's notify primitive in a shape that's
// easy to unit-test and easy to no-op when the client didn't request
// progress (no token in `_meta.progressToken`).
//
// Backward compatible by design: if the client doesn't supply a token,
// `createProgressEmitter` returns null and callers skip the emit() calls.

export type ProgressToken = string | number;

/**
 * Shape of an MCP progress notification (JSON-RPC method
 * `notifications/progress`). Loose typing here avoids coupling to the
 * SDK's internal types — what `sendNotification` accepts is a superset.
 */
export interface ProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: ProgressToken;
    progress: number;
    total?: number;
    message?: string;
  };
}

export interface ProgressEmitter {
  emit(args: { progress: number; message?: string; total?: number }): Promise<void>;
}

/**
 * Build an emitter bound to a specific request's `progressToken` and
 * `sendNotification`. Returns null when no token was supplied — callers
 * MUST short-circuit on null rather than calling emit() defensively, so
 * we don't pay even a no-op transport cost on every poll iteration.
 *
 * Errors during notification delivery are swallowed: the tool call's
 * primary outcome (the final response) is more important than any
 * single progress update, and a failed notification should never fail
 * the request.
 */
export function createProgressEmitter(
  progressToken: ProgressToken | undefined,
  sendNotification: (n: ProgressNotification) => Promise<void>,
): ProgressEmitter | null {
  if (progressToken === undefined || progressToken === null) return null;
  return {
    async emit({ progress, message, total }) {
      try {
        await sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
          },
        });
      } catch {
        // Best-effort delivery; never fail the tool call on a notification error.
      }
    },
  };
}

/**
 * Truncation length for the partial-response snippet included in progress
 * messages. Long responses must NOT travel inside every notification —
 * the full text is delivered in the final tool result. 200 chars is
 * enough to confirm the agent is producing relevant output.
 */
const PROGRESS_PARTIAL_RESPONSE_CHARS = 200;

export interface ProgressInputs {
  status: string;
  currentStep?: string;
  response?: string;
  agentBrowsingUrl?: string;
}

/**
 * Format a single-line progress message from the latest poll's agent
 * status. Sections joined with ` | ` so the client can split or render
 * inline. Partial responses are truncated; the full text always lands
 * in the final tool result.
 */
export function formatProgressMessage(input: ProgressInputs): string {
  const parts: string[] = [];
  parts.push(`Status: ${input.status.toUpperCase()}`);
  if (input.currentStep) {
    parts.push(`Step: ${input.currentStep}`);
  }
  if (input.agentBrowsingUrl) {
    parts.push(`Browsing: ${input.agentBrowsingUrl}`);
  }
  if (input.response && input.response.length > 0) {
    const trimmed =
      input.response.length > PROGRESS_PARTIAL_RESPONSE_CHARS
        ? input.response.substring(0, PROGRESS_PARTIAL_RESPONSE_CHARS) + "…"
        : input.response;
    parts.push(`Partial: ${trimmed.replace(/\s+/g, " ").trim()}`);
  }
  return parts.join(" | ");
}
