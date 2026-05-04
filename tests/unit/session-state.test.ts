import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  sessionState,
  startNewTask,
  completeTask,
  isSessionStale,
  generateTaskId,
  readCachedResponse,
  RESPONSE_CACHE_TTL_MS,
  getActiveTaskCollision,
  countTabsOpenedSinceBaseline,
} from "../../src/session-state.js";

function resetSessionState(): void {
  sessionState.currentTaskId = null;
  sessionState.taskStartTime = null;
  sessionState.lastPrompt = null;
  sessionState.lastResponse = null;
  sessionState.lastResponseTime = null;
  sessionState.lastTerminalStatus = null;
  sessionState.lastBlockedReason = null;
  sessionState.lastSkippedReason = null;
  sessionState.proseBaselineCount = 0;
  sessionState.tabBaselineExternalIds = [];
  sessionState.steps = [];
  sessionState.isActive = false;
}

beforeEach(() => {
  resetSessionState();
});

describe("generateTaskId", () => {
  it("returns a string in the form task_<digits>_<base36>", () => {
    const id = generateTaskId();
    expect(id).toMatch(/^task_\d+_[0-9a-z]+$/);
  });

  it("returns unique ids across rapid successive calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId());
    }
    expect(ids.size).toBe(100);
  });
});

describe("startNewTask", () => {
  it("populates session state for a fresh task", () => {
    const before = Date.now();
    const taskId = startNewTask("hello");
    const after = Date.now();

    expect(sessionState.currentTaskId).toBe(taskId);
    expect(sessionState.lastPrompt).toBe("hello");
    expect(sessionState.isActive).toBe(true);
    expect(sessionState.steps).toEqual([]);
    expect(sessionState.taskStartTime).toBeGreaterThanOrEqual(before);
    expect(sessionState.taskStartTime).toBeLessThanOrEqual(after);
  });

  it("clears prior lastResponse / lastResponseTime / steps from a previous task", () => {
    sessionState.lastResponse = "previous answer";
    sessionState.lastResponseTime = 12345;
    sessionState.steps = ["old step 1", "old step 2"];

    startNewTask("a fresh prompt");

    expect(sessionState.lastResponse).toBeNull();
    expect(sessionState.lastResponseTime).toBeNull();
    expect(sessionState.steps).toEqual([]);
  });

  it("clears prior lastTerminalStatus and lastBlockedReason from a previous task", () => {
    sessionState.lastTerminalStatus = "blocked";
    sessionState.lastBlockedReason = "login_required";

    startNewTask("a fresh prompt");

    expect(sessionState.lastTerminalStatus).toBeNull();
    expect(sessionState.lastBlockedReason).toBeNull();
  });

  it("resets proseBaselineCount to 0 for a fresh task", () => {
    sessionState.proseBaselineCount = 7;

    startNewTask("a fresh prompt");

    // The handler is responsible for updating this to the live DOM count
    // immediately after; startNewTask itself starts from a clean baseline.
    expect(sessionState.proseBaselineCount).toBe(0);
  });

  it("returns a task id that matches the format from generateTaskId", () => {
    const taskId = startNewTask("any");
    expect(taskId).toMatch(/^task_\d+_[0-9a-z]+$/);
  });
});

describe("completeTask", () => {
  it("writes lastResponse, stamps lastResponseTime, sets isActive=false", () => {
    startNewTask("a prompt");
    expect(sessionState.isActive).toBe(true);

    const before = Date.now();
    completeTask("the answer");
    const after = Date.now();

    expect(sessionState.lastResponse).toBe("the answer");
    expect(sessionState.isActive).toBe(false);
    expect(sessionState.lastResponseTime).toBeGreaterThanOrEqual(before);
    expect(sessionState.lastResponseTime).toBeLessThanOrEqual(after);
  });

  it("defaults to terminalStatus 'completed' with null blockedReason", () => {
    startNewTask("a prompt");
    completeTask("the answer");
    expect(sessionState.lastTerminalStatus).toBe("completed");
    expect(sessionState.lastBlockedReason).toBeNull();
  });

  it("records 'blocked' terminalStatus and an explicit blockedReason when supplied", () => {
    startNewTask("a prompt");
    completeTask("[error message]", "blocked", "login_required");
    expect(sessionState.lastTerminalStatus).toBe("blocked");
    expect(sessionState.lastBlockedReason).toBe("login_required");
    expect(sessionState.isActive).toBe(false);
    expect(sessionState.lastResponse).toBe("[error message]");
  });

  it("records 'skipped' terminalStatus and stores the reason in lastSkippedReason", () => {
    startNewTask("a prompt");
    completeTask("[skipped message]", "skipped", "answer_skipped");

    expect(sessionState.lastTerminalStatus).toBe("skipped");
    expect(sessionState.lastSkippedReason).toBe("answer_skipped");
    // skipped reasons are kept separate from blocked reasons so callers
    // displaying one don't leak the other.
    expect(sessionState.lastBlockedReason).toBeNull();
    expect(sessionState.isActive).toBe(false);
  });
});

describe("readCachedResponse", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when there is no cached response", () => {
    expect(readCachedResponse()).toBeNull();
  });

  it("returns null while the session is still active", () => {
    startNewTask("a prompt");
    sessionState.lastResponse = "intermediate text";
    sessionState.lastResponseTime = Date.now();
    sessionState.lastTerminalStatus = "completed";
    expect(readCachedResponse()).toBeNull();
  });

  it("returns the cached response when TTL has not elapsed", () => {
    startNewTask("a prompt");
    completeTask("the answer");
    vi.advanceTimersByTime(RESPONSE_CACHE_TTL_MS - 1000);
    const cached = readCachedResponse();
    expect(cached).not.toBeNull();
    expect(cached!.text).toBe("the answer");
    expect(cached!.terminalStatus).toBe("completed");
    expect(cached!.ageSeconds).toBe(Math.round((RESPONSE_CACHE_TTL_MS - 1000) / 1000));
  });

  it("returns null and evicts the cache once TTL has elapsed", () => {
    startNewTask("a prompt");
    completeTask("the answer");
    vi.advanceTimersByTime(RESPONSE_CACHE_TTL_MS + 1000);
    expect(readCachedResponse()).toBeNull();
    // Eviction is a side effect that prevents subsequent polls from seeing
    // the same answer surface back through other code paths.
    expect(sessionState.lastResponse).toBeNull();
    expect(sessionState.lastResponseTime).toBeNull();
    expect(sessionState.lastTerminalStatus).toBeNull();
    expect(sessionState.lastBlockedReason).toBeNull();
  });

  it("preserves blocked terminalStatus and blockedReason within TTL", () => {
    startNewTask("a prompt");
    completeTask("[blocked message]", "blocked", "login_required");
    vi.advanceTimersByTime(5000);
    const cached = readCachedResponse();
    expect(cached).not.toBeNull();
    expect(cached!.terminalStatus).toBe("blocked");
    expect(cached!.blockedReason).toBe("login_required");
  });
});

describe("countTabsOpenedSinceBaseline", () => {
  it("returns 0 when current tabs match the baseline exactly", () => {
    sessionState.tabBaselineExternalIds = ["A", "B"];
    expect(countTabsOpenedSinceBaseline(["A", "B"])).toBe(0);
  });

  it("returns the number of new tab IDs that didn't exist at task start", () => {
    sessionState.tabBaselineExternalIds = ["A"];
    expect(countTabsOpenedSinceBaseline(["A", "B", "C"])).toBe(2);
  });

  it("does not count tabs that disappeared (only spawn delta matters here)", () => {
    sessionState.tabBaselineExternalIds = ["A", "B"];
    // Tab A was closed; the remaining tab matches baseline. No new tabs.
    expect(countTabsOpenedSinceBaseline(["B"])).toBe(0);
  });

  it("treats every current tab as new when baseline is empty", () => {
    sessionState.tabBaselineExternalIds = [];
    expect(countTabsOpenedSinceBaseline(["X", "Y", "Z"])).toBe(3);
  });

  it("clears the baseline when startNewTask runs (tabsOpened resets per task)", () => {
    sessionState.tabBaselineExternalIds = ["A", "B", "C"];
    startNewTask("a fresh prompt");
    expect(sessionState.tabBaselineExternalIds).toEqual([]);
  });
});

describe("getActiveTaskCollision", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when no task is active", () => {
    expect(getActiveTaskCollision()).toBeNull();
  });

  it("returns task id and elapsedSec while a task is active and fresh", () => {
    const taskId = startNewTask("a prompt");
    vi.advanceTimersByTime(7 * 1000);

    const collision = getActiveTaskCollision();
    expect(collision).not.toBeNull();
    expect(collision!.currentTaskId).toBe(taskId);
    expect(collision!.elapsedSec).toBe(7);
  });

  it("returns null after completeTask runs", () => {
    startNewTask("a prompt");
    completeTask("the answer");

    expect(getActiveTaskCollision()).toBeNull();
  });

  it("returns null once the active task has gone stale (>5 min)", () => {
    startNewTask("an old prompt");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // A forgotten/abandoned task shouldn't permanently block new comet_ask
    // calls — the staleness check lets the next call proceed.
    expect(getActiveTaskCollision()).toBeNull();
  });
});

describe("isSessionStale", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns true when taskStartTime is null", () => {
    sessionState.taskStartTime = null;
    expect(isSessionStale()).toBe(true);
  });

  it("returns false at 4:59 after task start", () => {
    startNewTask("a prompt");
    vi.advanceTimersByTime(4 * 60 * 1000 + 59 * 1000);
    expect(isSessionStale()).toBe(false);
  });

  it("returns true at 5:01 after task start", () => {
    startNewTask("a prompt");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    expect(isSessionStale()).toBe(true);
  });
});
