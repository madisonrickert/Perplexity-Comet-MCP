// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";
import { extractAgentStatus, type AgentStatusResult } from "./page-scripts.js";

/**
 * Minimal CDP-client surface used by `CometAI.getAgentStatus`. Letting
 * callers inject a stand-in (in unit tests) avoids spinning up real
 * CDP infrastructure to exercise the status-extraction logic. Methods
 * outside this set continue to use the module-level `cometClient`.
 */
export type CometAIClient = Pick<typeof cometClient, "safeEvaluate" | "listTabsCategorized">;

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[role="textbox"]',
  '[contenteditable]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  private readonly client: CometAIClient;

  constructor(client: CometAIClient = cometClient) {
    this.client = client;
  }

  async getBrowserBlockState(): Promise<{
    blocked: boolean;
    blockedReason?: "login_required";
    blockedMessage?: string;
  }> {
    const result = await this.client.safeEvaluate(`
      (() => {
        const body = document.body.innerText;
        const hasLoggedOutBrowserText = body.includes("Comet Assistant can't use the browser when logged out");
        const hasUnlockCapabilitiesText = body.includes('Log in to unlock full capabilities');
        const hasSignInAccountText = body.includes('Sign in or create an account');
        const hasVisibleLoginDialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog')].some(el => {
          if (!(el instanceof HTMLElement) || el.offsetParent === null) return false;
          const text = (el.textContent || '').toLowerCase();
          return text.includes('sign in') ||
            text.includes('log in') ||
            text.includes('create an account') ||
            text.includes('continue with google') ||
            text.includes('continue with apple');
        });

        const blocked = hasLoggedOutBrowserText ||
          ((hasUnlockCapabilitiesText || hasSignInAccountText) && hasVisibleLoginDialog);

        return {
          blocked,
          blockedReason: blocked ? 'login_required' : undefined,
          blockedMessage: blocked
            ? 'Comet browser automation is unavailable because the browser is logged out. Sign in to unlock full capabilities.'
            : undefined,
        };
      })()
    `);

    return (result.result.value as {
      blocked: boolean;
      blockedReason?: "login_required";
      blockedMessage?: string;
    }) ?? { blocked: false };
  }

  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    const result = await cometClient.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        if (candidates.length === 0) return null;
        const el = candidates[0];
        if (el.matches('[contenteditable], [role="textbox"]')) return '[contenteditable]';
        if (el.matches('textarea')) return 'textarea';
        return 'input[type="text"]';
      })()
    `);

    return (result.result.value as string | null) ?? null;
  }

  private async waitForInputElement(timeoutMs = 10000, intervalMs = 400): Promise<string | null> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const selector = await this.findInputElement();
      if (selector) {
        return selector;
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    return null;
  }

  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.waitForInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    // Use execCommand for contenteditable elements (works with React/Vue)
    const result = await cometClient.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        const el = candidates[0];
        if (!el) return { success: false };

        el.focus();

        if (el.matches('[contenteditable], [role="textbox"]')) {
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          return { success: true };
        }

        if ('value' in el) {
          el.value = ${JSON.stringify(prompt)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }

        return { success: false };
      })()
    `);

    const typed = (result.result.value as { success: boolean })?.success;
    if (!typed) {
      throw new Error("Failed to type into input element");
    }

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 300));

    // Verify text was typed before attempting submit
    const hasContent = await cometClient.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        const el = candidates[0];
        if (!el) return false;
        if (el.matches('[contenteditable], [role="textbox"]')) return el.innerText.trim().length > 0;
        return 'value' in el && el.value.trim().length > 0;
      })()
    `);

    if (!hasContent.result.value) {
      throw new Error("Prompt text not found in input - typing may have failed");
    }

    // Strategy 1: Simulate Enter key via DOM events (most reliable for contenteditable)
    const enterResult = await cometClient.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        const el = candidates[0];
        if (!el) return { success: false, reason: 'no input element' };

        el.focus();

        // Create and dispatch Enter key events
        const enterEvent = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        });

        el.dispatchEvent(enterEvent);

        // Also dispatch keyup
        const keyupEvent = new KeyboardEvent('keyup', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true
        });
        el.dispatchEvent(keyupEvent);

        return { success: true };
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 800));

    // Check if submission worked
    const submitted = await cometClient.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        const el = candidates[0];
        if (el && el.matches('[contenteditable], [role="textbox"]') && el.innerText.trim().length < 5) return true;
        if (el && 'value' in el && el.value.trim().length < 5) return true;
        // Check for loading indicators
        const hasLoading = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click the submit button directly
    const clickResult = await cometClient.evaluate(`
      (() => {
        // Try specific submit button selectors first
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          'form button[type="button"]:last-of-type',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return { success: true, method: 'selector', selector: sel };
          }
        }

        // Find the submit button by position (usually rightmost button near input)
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        const inputEl = candidates[0];
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          // Search up the DOM tree
          for (let i = 0; i < 5 && parent; i++) {
            const btns = parent.querySelectorAll('button');
            for (const btn of btns) {
              if (btn.disabled || btn.offsetParent === null) continue;

              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              // Skip mode/attach/voice/menu buttons
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('voice') ||
                  ariaLabel.includes('menu') || ariaLabel.includes('more')) {
                continue;
              }

              // Button should be visible and to the right of input
              if (btnRect.width > 0 && btnRect.height > 0) {
                candidates.push({ btn, x: btnRect.right, y: btnRect.top });
              }
            }
            parent = parent.parentElement;
          }

          // Click the rightmost button (usually submit)
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.x - a.x);
            candidates[0].btn.click();
            return { success: true, method: 'position' };
          }
        }

        return { success: false, reason: 'no button found' };
      })()
    `);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Final verification and last resort
    const finalCheck = await cometClient.evaluate(`
      (() => {
        const candidates = [...document.querySelectorAll('textarea, input[type="text"], [role="textbox"], [contenteditable]')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden';
          })
          .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

        const el = candidates[0];
        if (el && el.matches('[contenteditable], [role="textbox"]') && el.innerText.trim().length < 5) return true;
        if (el && 'value' in el && el.value.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasThinking = document.body.innerText.includes('Thinking');
        return hasLoading || hasThinking;
      })()
    `);

    if (!finalCheck.result.value) {
      // Last resort: try form submit
      await cometClient.evaluate(`
        (() => {
          const form = document.querySelector('form');
          if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        })()
      `);
    }
  }

  // Track response stability for completion detection
  private lastResponseText: string = '';
  private stableResponseCount: number = 0;
  private readonly STABILITY_THRESHOLD: number = 2; // Response must be same for 2 checks

  /**
   * Check if response has stabilized (same content for multiple polls)
   */
  isResponseStable(currentResponse: string): boolean {
    if (currentResponse && currentResponse.trim().length > 0) {
      if (currentResponse === this.lastResponseText) {
        this.stableResponseCount++;
      } else {
        this.stableResponseCount = 0;
        this.lastResponseText = currentResponse;
      }
      return this.stableResponseCount >= this.STABILITY_THRESHOLD;
    }
    return false;
  }

  /**
   * Reset stability tracking (call when starting new prompt)
   */
  resetStabilityTracking(): void {
    this.lastResponseText = '';
    this.stableResponseCount = 0;
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed" | "blocked";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
    isStable: boolean;
    blockedReason?: "login_required";
    blockedMessage?: string;
    browserAutomationAvailable: boolean;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await this.client.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await this.client.safeEvaluate(`(${extractAgentStatus.toString()})()`);

    const statusResult = result.result.value as AgentStatusResult;

    // Check response stability
    const isStable = this.isResponseStable(statusResult.response);

    // If response is stable and has content, override status to completed
    if (statusResult.status !== 'blocked' && isStable && statusResult.response.trim().length > 0 && !statusResult.hasStopButton) {
      statusResult.status = 'completed';
    }

    return {
      ...statusResult,
      agentBrowsingUrl,
      isStable,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }
}

export const cometAI = new CometAI();
