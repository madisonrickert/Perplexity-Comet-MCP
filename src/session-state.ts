// Session state for tracking task progress and preventing stale responses

import { cometAI } from "./comet-ai.js";

/**
 * How long a completed/blocked response stays cached before `comet_poll`
 * stops returning it. Beyond this window, polling reports IDLE so callers
 * don't get an answer to a task they ran much earlier in the session.
 */
export const RESPONSE_CACHE_TTL_MS = 30_000;

export interface SessionState {
  currentTaskId: string | null;
  taskStartTime: number | null;
  lastPrompt: string | null;
  lastResponse: string | null;
  lastResponseTime: number | null;
  /** How the task ended. `null` while in progress. */
  lastTerminalStatus: "completed" | "blocked" | null;
  /** Reason a task was blocked (e.g. login wall). `null` for non-blocked outcomes. */
  lastBlockedReason: string | null;
  steps: string[];
  isActive: boolean;
}

export interface CachedResponse {
  text: string;
  ageSeconds: number;
  terminalStatus: "completed" | "blocked";
  blockedReason: string | null;
}

export const sessionState: SessionState = {
  currentTaskId: null,
  taskStartTime: null,
  lastPrompt: null,
  lastResponse: null,
  lastResponseTime: null,
  lastTerminalStatus: null,
  lastBlockedReason: null,
  steps: [],
  isActive: false,
};

export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function startNewTask(prompt: string): string {
  const taskId = generateTaskId();
  sessionState.currentTaskId = taskId;
  sessionState.taskStartTime = Date.now();
  sessionState.lastPrompt = prompt;
  sessionState.lastResponse = null;
  sessionState.lastResponseTime = null;
  sessionState.lastTerminalStatus = null;
  sessionState.lastBlockedReason = null;
  sessionState.steps = [];
  sessionState.isActive = true;
  cometAI.resetStabilityTracking();
  return taskId;
}

export function completeTask(
  response: string,
  terminalStatus: "completed" | "blocked" = "completed",
  blockedReason: string | null = null,
): void {
  sessionState.lastResponse = response;
  sessionState.lastResponseTime = Date.now();
  sessionState.lastTerminalStatus = terminalStatus;
  sessionState.lastBlockedReason = blockedReason;
  sessionState.isActive = false;
}

export function isSessionStale(): boolean {
  if (!sessionState.taskStartTime) return true;
  // Consider session stale if no activity for 5 minutes
  return Date.now() - sessionState.taskStartTime > 5 * 60 * 1000;
}

/**
 * Read the cached response from a finished task, if it exists and hasn't
 * exceeded RESPONSE_CACHE_TTL_MS. Returns null when there's nothing cached,
 * the session is still active, or the cache is stale.
 *
 * Side effect: when the cache has expired, this clears the response fields
 * so subsequent reads return IDLE without further work. Without that, a long
 * gap between polls would surface an answer the user no longer expected.
 */
export function readCachedResponse(now: number = Date.now()): CachedResponse | null {
  if (sessionState.isActive) return null;
  if (!sessionState.lastResponse || !sessionState.lastResponseTime) return null;
  if (sessionState.lastTerminalStatus !== "completed" && sessionState.lastTerminalStatus !== "blocked") {
    return null;
  }
  const ageMs = now - sessionState.lastResponseTime;
  if (ageMs > RESPONSE_CACHE_TTL_MS) {
    sessionState.lastResponse = null;
    sessionState.lastResponseTime = null;
    sessionState.lastTerminalStatus = null;
    sessionState.lastBlockedReason = null;
    return null;
  }
  return {
    text: sessionState.lastResponse,
    ageSeconds: Math.round(ageMs / 1000),
    terminalStatus: sessionState.lastTerminalStatus,
    blockedReason: sessionState.lastBlockedReason,
  };
}
