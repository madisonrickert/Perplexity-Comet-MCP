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
  lastTerminalStatus: "completed" | "blocked" | "skipped" | null;
  /** Reason a task was blocked (e.g. login wall). `null` for non-blocked outcomes. */
  lastBlockedReason: string | null;
  /** Reason the agent skipped/abandoned (e.g. "answer_skipped"). `null` for non-skipped outcomes. */
  lastSkippedReason: string | null;
  /**
   * Number of `[class*="prose"]` elements present in the DOM at task start.
   * Used as a watermark so getAgentStatus only considers prose blocks
   * generated *after* this task's prompt was sent — without it, the prose
   * left over from a previous task's answer surfaces as the new answer.
   */
  proseBaselineCount: number;
  steps: string[];
  isActive: boolean;
}

export interface CachedResponse {
  text: string;
  ageSeconds: number;
  terminalStatus: "completed" | "blocked" | "skipped";
  blockedReason: string | null;
  skippedReason: string | null;
}

export const sessionState: SessionState = {
  currentTaskId: null,
  taskStartTime: null,
  lastPrompt: null,
  lastResponse: null,
  lastResponseTime: null,
  lastTerminalStatus: null,
  lastBlockedReason: null,
  lastSkippedReason: null,
  proseBaselineCount: 0,
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
  sessionState.lastSkippedReason = null;
  sessionState.proseBaselineCount = 0;
  sessionState.steps = [];
  sessionState.isActive = true;
  cometAI.resetStabilityTracking();
  return taskId;
}

/**
 * Record a task's terminal state. The `reason` parameter is interpreted
 * based on `terminalStatus`: stored as lastBlockedReason for blocked
 * outcomes, lastSkippedReason for skipped outcomes, and ignored for
 * completed outcomes.
 */
export function completeTask(
  response: string,
  terminalStatus: "completed" | "blocked" | "skipped" = "completed",
  reason: string | null = null,
): void {
  sessionState.lastResponse = response;
  sessionState.lastResponseTime = Date.now();
  sessionState.lastTerminalStatus = terminalStatus;
  sessionState.lastBlockedReason = terminalStatus === "blocked" ? reason : null;
  sessionState.lastSkippedReason = terminalStatus === "skipped" ? reason : null;
  sessionState.isActive = false;
}

export function isSessionStale(): boolean {
  if (!sessionState.taskStartTime) return true;
  // Consider session stale if no activity for 5 minutes
  return Date.now() - sessionState.taskStartTime > 5 * 60 * 1000;
}

export interface ActiveTaskCollision {
  currentTaskId: string | null;
  elapsedSec: number;
}

/**
 * Returns information about an in-flight task that would collide with a new
 * comet_ask call, or null if no collision exists. Stale sessions (>5 min)
 * are treated as non-colliding so a forgotten task can't permanently block
 * the tool.
 */
export function getActiveTaskCollision(): ActiveTaskCollision | null {
  if (!sessionState.isActive || isSessionStale()) return null;
  const elapsedSec = sessionState.taskStartTime
    ? Math.round((Date.now() - sessionState.taskStartTime) / 1000)
    : 0;
  return { currentTaskId: sessionState.currentTaskId, elapsedSec };
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
  if (
    sessionState.lastTerminalStatus !== "completed" &&
    sessionState.lastTerminalStatus !== "blocked" &&
    sessionState.lastTerminalStatus !== "skipped"
  ) {
    return null;
  }
  const ageMs = now - sessionState.lastResponseTime;
  if (ageMs > RESPONSE_CACHE_TTL_MS) {
    sessionState.lastResponse = null;
    sessionState.lastResponseTime = null;
    sessionState.lastTerminalStatus = null;
    sessionState.lastBlockedReason = null;
    sessionState.lastSkippedReason = null;
    return null;
  }
  return {
    text: sessionState.lastResponse,
    ageSeconds: Math.round(ageMs / 1000),
    terminalStatus: sessionState.lastTerminalStatus,
    blockedReason: sessionState.lastBlockedReason,
    skippedReason: sessionState.lastSkippedReason,
  };
}
