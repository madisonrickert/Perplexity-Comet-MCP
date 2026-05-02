#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";
import {
  sessionState,
  startNewTask,
  completeTask,
  isSessionStale,
} from "./session-state.js";
import { readProseState, type ProseState } from "./page-scripts.js";

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: {
      type: "object",
      properties: {
        allowRestart: {
          type: "boolean",
          description: "If true, allows Comet to be restarted when it is already running without a debug port. Default: false.",
        },
        userDataDir: {
          type: "string",
          description: "Optional persistent user data directory to use when launching a debuggable Comet profile.",
        },
      },
    },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
        properties: {
          prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
          context: { type: "string", description: "Optional context to include (e.g., file contents, codebase info, marketing guidelines). This will be prefixed to the prompt to give Comet full context." },
          newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
          timeout: { type: "number", description: "Max wait time in ms (default: 120000 = 2min)" },
          tabPolicy: {
            type: "string",
            enum: ["preserve", "cleanup", "cleanup_on_blocked"],
            description: "How to handle browsing tabs opened during this ask. 'preserve' keeps them, 'cleanup' closes them on exit, and 'cleanup_on_blocked' closes them only if the task ends blocked. Default: preserve.",
          },
        },
        required: ["prompt"],
      },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_tabs",
    description: "View and manage browser tabs. Shows all open tabs with their purpose, domain, and status. Helps coordinate multi-tab workflows without creating duplicate tabs.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "switch", "close"],
          description: "Action to perform: 'list' (default) shows all tabs, 'switch' activates a tab, 'close' closes a tab",
        },
        domain: {
          type: "string",
          description: "For switch/close: domain to match (e.g., 'github.com')",
        },
        tabId: {
          type: "string",
          description: "For switch/close: specific tab ID",
        },
      },
    },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_upload",
    description: "Upload a file to a file input on the current page. Use this to attach images, documents, or other files to forms, posts, or upload dialogs. The file must exist on the local filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Absolute path to the file to upload (e.g., '/home/user/image.png' or 'C:\\Users\\user\\image.png')",
        },
        selector: {
          type: "string",
          description: "Optional CSS selector for the file input element. If not provided, auto-detects the first file input on the page.",
        },
        checkOnly: {
          type: "boolean",
          description: "If true, only checks if file inputs exist on the page without uploading",
        },
      },
      required: ["filePath"],
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.5.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        const allowRestart = (args?.allowRestart as boolean) ?? false;
        const userDataDir = args?.userDataDir as string | undefined;
        const startResult = await cometClient.startComet(9223, { allowRestart, userDataDir });

        if (startResult.status === 'running_no_debug_port') {
          return {
            content: [{ type: "text", text: startResult.message }],
            isError: true,
          };
        }

        // Get all tabs - DON'T clean up tabs, as closing them can crash Comet
        const targets = await cometClient.listTargets();
        const freshTargets = targets; // Use the same list, no cleanup

        // Prefer connecting to existing Perplexity tab, or any page tab
        const perplexityTab = freshTargets.find(t => t.type === 'page' && t.url.includes('perplexity.ai'));
        const anyPage = perplexityTab || freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);

          // Only navigate to Perplexity if not already there
          if (!anyPage.url.includes('perplexity.ai')) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          return { content: [{ type: "text", text: `${startResult.message}\nConnected to Perplexity` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult.message}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const context = args?.context as string | undefined;
        const maxTimeout = (args?.timeout as number) || 120000; // Max 2 minutes safety net
        const newChat = (args?.newChat as boolean) || false;
        const tabPolicy = ((args?.tabPolicy as string) || 'preserve') as 'preserve' | 'cleanup' | 'cleanup_on_blocked';

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // If context is provided, prepend it to the prompt
        if (context && context.trim().length > 0) {
          // Format context as a clear prefix
          const contextPrefix = `Context for this task:\n\`\`\`\n${context.trim()}\n\`\`\`\n\nBased on the above context, `;
          prompt = contextPrefix + prompt;
        }

        // Start new task session - resets state and prevents stale poll responses
        const taskId = startNewTask(prompt);

        // CRITICAL: Pre-operation connection check for one-shot reliability
        try {
          await cometClient.preOperationCheck();
        } catch (preCheckError) {
          // If pre-check fails, try to recover
          try {
            const startResult = await cometClient.startComet(9223);
            if (startResult.status === 'running_no_debug_port') {
              return {
                content: [{
                  type: "text",
                  text: `Error: ${startResult.message}`,
                }],
                isError: true,
              };
            }
            const targets = await cometClient.listTargets();
            const page = targets.find(t => t.type === 'page');
            if (page) await cometClient.connect(page.id);
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : 'Failed to establish connection to Comet browser'}`,
              }],
              isError: true,
            };
          }
        }

        // Normalize prompt - convert markdown/bullets to natural text
        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')  // Remove bullet points
          .replace(/\n+/g, ' ')         // Collapse newlines to spaces
          .replace(/\s+/g, ' ')         // Collapse multiple spaces
          .trim();

        // Transform prompt to trigger agentic browsing when needed
        // Detect if prompt requires browser actions (URLs, action verbs, website references)
        const hasUrl = /https?:\/\/[^\s]+/.test(prompt);
        const hasWebsiteRef = /\b(go to|visit|navigate|open|browse|check|look at|read from|click|fill|submit|login|sign in|download from)\b/i.test(prompt);
        const hasSiteNames = /\b(\.com|\.org|\.io|\.net|\.ai|website|webpage|page|site)\b/i.test(prompt);
        const needsAgenticBrowsing = hasUrl || hasWebsiteRef || hasSiteNames;

        // If prompt needs browser action but doesn't have agentic language, add it
        if (needsAgenticBrowsing) {
          const alreadyAgentic = /^(use your browser|using your browser|open a browser|navigate to|browse to)/i.test(prompt);
          if (!alreadyAgentic) {
            // Transform to agentic prompt
            if (hasUrl) {
              // Extract URL and restructure prompt
              const urlMatch = prompt.match(/https?:\/\/[^\s]+/);
              if (urlMatch) {
                const url = urlMatch[0];
                const restOfPrompt = prompt.replace(url, '').trim();
                prompt = `Use your browser to navigate to ${url} and ${restOfPrompt || 'tell me what you find there'}`;
              }
            } else {
              // Add agentic prefix for site references
              prompt = `Use your browser to ${prompt.toLowerCase().startsWith('go') ? '' : 'go and '}${prompt}`;
            }
          }
        }

        let newChatTabId: string | null = null;

        // Close any agent-browsing tabs left over from prior sessions before
        // snapshotting the baseline, so they don't get frozen into it.
        const allTabsNow = await cometClient.getTabContexts();
        for (const tab of allTabsNow) {
          if (tab.purpose === 'agent-browsing') {
            await cometClient.closeTab(tab.id).catch(() => {});
          }
        }

        const baselineExternalTabIds = new Set(
          (await cometClient.getTabContexts())
            .filter(tab => tab.purpose !== 'main')
            .map(tab => tab.id)
        );
        let blockedReason: string | null = null;
        let blockedMessage: string | null = null;

        if (newChat) {
          await cometClient.ensureConnection();
          const newTabTarget = await cometClient.newTab('about:blank');
          newChatTabId = newTabTarget.id;
          await cometClient.connect(newTabTarget.id);
          await cometClient.navigate('https://www.perplexity.ai/', true);
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          // Not newChat - just ensure we're on Perplexity
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.main) {
            await cometClient.connect(tabs.main.id);
          }

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        const closeNewChatTab = async () => {
          if (newChatTabId) {
            try { await cometClient.closeTab(newChatTabId); } catch { /* ignore */ }
            newChatTabId = null;
          }
        };

        const closeNewExternalTabs = async () => {
          if (!needsAgenticBrowsing || tabPolicy === 'preserve') {
            return;
          }

          if (tabPolicy === 'cleanup_on_blocked' && !blockedReason) {
            return;
          }

          try {
            const currentTabs = await cometClient.getTabContexts();
            for (const tab of currentTabs) {
              if (tab.purpose === 'main') {
                continue;
              }

              if (!baselineExternalTabIds.has(tab.id)) {
                try {
                  await cometClient.closeTab(tab.id);
                } catch {
                  /* ignore */
                }
              }
            }
          } catch {
            /* ignore */
          }
        };

        try {
          // startNewTask already resets stability tracking; no need to duplicate.
          // Capture old response state BEFORE sending prompt (for follow-up detection)
          const oldStateResult = await cometClient.evaluate(`(${readProseState.toString()})()`);
          const oldState = oldStateResult.result.value as ProseState;

          await cometAI.sendPrompt(prompt);

          const startTime = Date.now();
          const stepsCollected: string[] = [];
          let sawNewResponse = newChat ? true : false;
          let lastActivityTime = Date.now();
          let previousResponse = '';
          const POLL_INTERVAL = 600;
          const IDLE_TIMEOUT = 3000;
          let consecutiveErrors = 0;
          const MAX_CONSECUTIVE_ERRORS = 5;
          let lastKnownResponse = '';
          let lastKnownHasStopButton = true;
          let statusPollInFlight: Promise<Awaited<ReturnType<typeof cometAI.getAgentStatus>>> | null = null;

          const formatBlockedMessage = (partialResponse?: string) => {
            const blockedText = [
              'Status: BLOCKED',
              `Reason: ${(blockedReason || 'unknown').toUpperCase()}`,
              '',
              blockedMessage || 'Comet browser automation is unavailable.',
              'Sign in to Perplexity/Comet in the browser session, then retry the task.',
            ];

            if (partialResponse) {
              blockedText.push('', 'Partial assistant output:', partialResponse);
            }

            return blockedText.join('\n');
          };

          const detectBrowserBlocked = async () => {
            if (!needsAgenticBrowsing) {
              return false;
            }

            try {
              const browserBlockState = await Promise.race([
                cometAI.getBrowserBlockState(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('blocked_check_timeout')), 2000))
              ]);

              if (browserBlockState?.blocked) {
                blockedReason = browserBlockState.blockedReason || 'login_required';
                blockedMessage = browserBlockState.blockedMessage || 'Comet browser automation is unavailable because the browser is logged out. Sign in to unlock full capabilities.';
                return true;
              }
            } catch {
              return Boolean(blockedReason);
            }

            return false;
          };

          const settleSuccessResponse = async (response: string) => {
            if (!needsAgenticBrowsing) {
              return { blocked: false as const };
            }

            const settleDeadline = Date.now() + 5000;
            while (Date.now() < settleDeadline) {
              await new Promise(resolve => setTimeout(resolve, 500));

              if (await detectBrowserBlocked()) {
                const message = formatBlockedMessage(response || lastKnownResponse || undefined);
                return { blocked: true as const, message };
              }
            }

            return { blocked: false as const };
          };

          const completeWithSettledResponse = async (response: string) => {
            await closeNewExternalTabs();
            const settled = await settleSuccessResponse(response);
            if (settled.blocked) {
              completeTask(settled.message, 'blocked', blockedReason);
              return { content: [{ type: "text", text: settled.message }] };
            }

            completeTask(response);
            return { content: [{ type: "text", text: response }] };
          };

          while (Date.now() - startTime < maxTimeout) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

            const elapsed = Date.now() - startTime;
            if (needsAgenticBrowsing && blockedReason) {
              const message = formatBlockedMessage(lastKnownResponse || undefined);
              completeTask(message, 'blocked', blockedReason);
              return { content: [{ type: "text", text: message }] };
            }

            if (elapsed > 8000 && lastKnownResponse.length > 0 && !lastKnownHasStopButton && !(needsAgenticBrowsing && blockedReason)) {
              return await completeWithSettledResponse(lastKnownResponse);
            }

            try {
              const isOnPerplexity = await Promise.race([
                cometClient.isOnPerplexityTab(),
                new Promise<boolean>(resolve => setTimeout(() => resolve(true), 2000))
              ]);
              if (!isOnPerplexity) {
                const switched = await Promise.race([
                  cometClient.ensureOnPerplexityTab(),
                  new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))
                ]);
                if (!switched) {
                  consecutiveErrors++;
                  continue;
                }
              }

              const currentStateResult = await Promise.race([
                cometClient.withAutoReconnect(async () => {
                  return await cometClient.evaluate(`
                    (() => {
                      const proseEls = document.querySelectorAll('[class*="prose"]');
                      const lastProse = proseEls[proseEls.length - 1];
                      return {
                        count: proseEls.length,
                        lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
                      };
                    })()
                  `);
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('state_timeout')), 3000))
              ]);
              const currentState = currentStateResult.result.value as { count: number; lastText: string };

              if (!sawNewResponse) {
                if (currentState.count > oldState.count ||
                    (currentState.lastText && currentState.lastText !== oldState.lastText)) {
                  sawNewResponse = true;
                }
              }

              let status: Awaited<ReturnType<typeof cometAI.getAgentStatus>>;
              try {
                if (!statusPollInFlight) {
                  statusPollInFlight = cometAI.getAgentStatus().finally(() => {
                    statusPollInFlight = null;
                  });
                }

                status = await Promise.race([
                  statusPollInFlight,
                  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('status_timeout')), 4000))
                ]);
              } catch (statusError) {
                if (String(statusError).includes('status_timeout')) {
                  try {
                    const directResult = await Promise.race([
                      cometClient.evaluate(`
                        (() => {
                          const els = [...document.querySelectorAll('[class*="prose"]')];
                          return els.map(e => e.innerText.trim()).filter(t => t.length > 20).join('\\n\\n');
                        })()
                      `),
                      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('direct_timeout')), 1500))
                    ]);
                    const text = (directResult?.result?.value as string | undefined) || '';
                    if (text && text.length > 0) {
                      lastKnownResponse = text;
                      lastKnownHasStopButton = false;
                    }
                    await detectBrowserBlocked();
                  } catch { /* ignore */ }
                  continue;
                }
                throw statusError;
              }

              consecutiveErrors = 0;

              if (status.response && status.response.length > 0) {
                lastKnownResponse = status.response;
                lastKnownHasStopButton = status.hasStopButton;
              }

              if (status.response !== previousResponse) {
                lastActivityTime = Date.now();
                previousResponse = status.response;
              }

              for (const step of status.steps) {
                if (!stepsCollected.includes(step)) {
                  stepsCollected.push(step);
                  lastActivityTime = Date.now();
                }
              }

              sessionState.steps = stepsCollected;

              if (needsAgenticBrowsing && status.status === 'blocked') {
                blockedReason = status.blockedReason || blockedReason || 'login_required';
                blockedMessage = status.blockedMessage || blockedMessage || 'Comet browser automation is unavailable because the browser is logged out. Sign in to unlock full capabilities.';
                const message = formatBlockedMessage(status.response || lastKnownResponse || undefined);
                completeTask(message, 'blocked', blockedReason);
                return { content: [{ type: "text", text: message }] };
              }

              if (status.status === 'completed' && sawNewResponse && status.response) {
                return await completeWithSettledResponse(status.response);
              }

              if (status.isStable && sawNewResponse && status.response && !status.hasStopButton) {
                return await completeWithSettledResponse(status.response);
              }

              const idleTime = Date.now() - lastActivityTime;
              if (idleTime > IDLE_TIMEOUT && sawNewResponse && status.response &&
                  status.response.length > 0 && !status.hasStopButton) {
                return await completeWithSettledResponse(status.response);
              }

            } catch {
              consecutiveErrors++;

              try {
                const recovered = await cometClient.ensureOnPerplexityTab();
                if (recovered) {
                  consecutiveErrors = Math.max(0, consecutiveErrors - 1);
                  continue;
                }
              } catch {
                /* empty */
              }

              if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                try {
                  await cometClient.ensureConnection();
                  await cometClient.ensureOnPerplexityTab();
                  consecutiveErrors = 0;
                } catch {
                  break;
                }
              }
              continue;
            }
          }

          if (needsAgenticBrowsing && blockedReason) {
            const message = formatBlockedMessage(lastKnownResponse || undefined);
            completeTask(message, 'blocked', blockedReason);
            return { content: [{ type: "text", text: message }] };
          }

          if (lastKnownResponse.length > 0) {
            return await completeWithSettledResponse(lastKnownResponse);
          }

          // Max timeout reached without detecting completion. Surface a "still
          // in progress" hint with the steps collected so far so the caller
          // can decide whether to comet_poll or comet_stop.
          let inProgressMsg = `Task may still be in progress (max timeout reached).\n`;
          inProgressMsg += `Status: WORKING\n`;
          if (stepsCollected.length > 0) {
            inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
          }
          inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

          sessionState.steps = stepsCollected;
          return { content: [{ type: "text", text: inProgressMsg }] };
        } finally {
          await closeNewExternalTabs();
          await closeNewChatTab();
        }
      }

      case "comet_poll": {
        // Check if there's an active task session
        if (!sessionState.isActive && !sessionState.currentTaskId) {
          return { content: [{ type: "text", text: "Status: IDLE\nNo active task. Use comet_ask to start a new task." }] };
        }

        // Check for stale session (no activity for 5+ minutes)
        if (isSessionStale() && !sessionState.isActive) {
          return { content: [{ type: "text", text: "Status: IDLE\nPrevious task session expired. Use comet_ask to start a new task." }] };
        }

        if (!sessionState.isActive && sessionState.lastTerminalStatus === 'blocked' && sessionState.lastResponse) {
          return { content: [{ type: "text", text: sessionState.lastResponse }] };
        }

        // If task was already completed, return the cached response
        if (!sessionState.isActive && sessionState.lastResponse && sessionState.lastTerminalStatus === 'completed') {
          const timeSinceComplete = sessionState.lastResponseTime
            ? Math.round((Date.now() - sessionState.lastResponseTime) / 1000)
            : 0;
          return { content: [{ type: "text", text: `Status: COMPLETED (${timeSinceComplete}s ago)\n\n${sessionState.lastResponse}` }] };
        }

        // Active task - get fresh status from Perplexity
        const switched = await Promise.race([
          cometClient.ensureOnPerplexityTab(),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3000))
        ]);

        if (!switched) {
          const elapsedSec = sessionState.taskStartTime ? Math.round((Date.now() - sessionState.taskStartTime) / 1000) : null;
          let output = `Status: ${sessionState.isActive ? 'WORKING' : 'UNKNOWN'}${elapsedSec !== null ? ` (${elapsedSec}s elapsed)` : ''}\n`;
          if (sessionState.currentTaskId) {
            output += `Task: ${sessionState.currentTaskId}\n`;
          }
          if (sessionState.steps.length > 0) {
            output += `\nSteps:\n${sessionState.steps.map(s => `  • ${s}`).join('\n')}\n`;
          }
          output += `\nLive status read timed out. Use comet_screenshot to inspect the page or comet_stop to cancel.`;
          return { content: [{ type: "text", text: output }] };
        }

        const status = await Promise.race([
          cometAI.getAgentStatus(),
          new Promise<Awaited<ReturnType<typeof cometAI.getAgentStatus>>>(resolve => setTimeout(() => resolve({
            status: sessionState.isActive ? 'working' : 'idle',
            steps: sessionState.steps,
            currentStep: '',
            response: sessionState.lastResponse || '',
            hasStopButton: sessionState.isActive,
            agentBrowsingUrl: '',
            isStable: false,
            blockedReason: undefined,
            blockedMessage: undefined,
            browserAutomationAvailable: true,
          }), 4000))
        ]);

        if (status.status === 'blocked') {
          const blockedText = [
            'Status: BLOCKED',
            `Reason: ${(status.blockedReason || sessionState.lastBlockedReason || 'unknown').toUpperCase()}`,
            '',
            status.blockedMessage || 'Comet browser automation is unavailable.',
            'Sign in to Perplexity/Comet in the browser session, then retry the task.',
          ];

          if (status.response) {
            blockedText.push('', 'Partial assistant output:', status.response);
          }

          const message = blockedText.join('\n');
          completeTask(message, 'blocked', status.blockedReason || sessionState.lastBlockedReason);
          return { content: [{ type: "text", text: message }] };
        }

        // If completed, update session state and return response
        if (status.status === 'completed' && status.response) {
          completeTask(status.response);
          return { content: [{ type: "text", text: status.response }] };
        }

        // Still working - return progress info
        const elapsedSec = sessionState.taskStartTime ? Math.round((Date.now() - sessionState.taskStartTime) / 1000) : null;
        let output = `Status: ${status.status.toUpperCase()}${elapsedSec !== null ? ` (${elapsedSec}s elapsed)` : ''}\n`;
        if (sessionState.currentTaskId) {
          output += `Task: ${sessionState.currentTaskId}\n`;
        }

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        // Combine session steps with current status steps
        const allSteps = [...new Set([...sessionState.steps, ...status.steps])];
        if (allSteps.length > 0) {
          output += `\nSteps:\n${allSteps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working' || sessionState.isActive) {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometAI.stopAgent();
        if (stopped) {
          sessionState.isActive = false;
        }
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_tabs": {
        const action = (args?.action as string) || 'list';
        const domain = args?.domain as string | undefined;
        const tabId = args?.tabId as string | undefined;

        switch (action) {
          case 'list': {
            const summary = await cometClient.getTabSummary();
            return { content: [{ type: "text", text: summary }] };
          }

          case 'switch': {
            if (tabId) {
              await cometClient.connect(tabId);
              return { content: [{ type: "text", text: `Switched to tab: ${tabId}` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab) {
                await cometClient.connect(tab.id);
                return { content: [{ type: "text", text: `Switched to ${tab.domain} (${tab.url})` }] };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to switch" }], isError: true };
          }

          case 'close': {
            if (tabId) {
              const tabs = await cometClient.getTabContexts();
              const tab = tabs.find(t => t.id === tabId);
              if (tab?.purpose === 'main') {
                return { content: [{ type: "text", text: "Cannot close main Perplexity tab" }], isError: true };
              }
              const success = await cometClient.closeTab(tabId);
              return { content: [{ type: "text", text: success ? `Closed tab: ${tabId}` : `Failed to close tab` }] };
            }
            if (domain) {
              const tab = await cometClient.findTabByDomain(domain);
              if (tab && tab.purpose !== 'main') {
                const success = await cometClient.closeTab(tab.id);
                return { content: [{ type: "text", text: success ? `Closed ${tab.domain}` : `Failed to close tab` }] };
              }
              if (tab?.purpose === 'main') {
                return { content: [{ type: "text", text: "Cannot close main Perplexity tab" }], isError: true };
              }
              return { content: [{ type: "text", text: `No tab found for domain: ${domain}` }], isError: true };
            }
            return { content: [{ type: "text", text: "Specify domain or tabId to close" }], isError: true };
          }

          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}. Use: list, switch, close` }], isError: true };
        }
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        await cometClient.ensureOnPerplexityTab();

        const blockState = await cometAI.getBrowserBlockState();
        if (blockState.blocked) {
          return { content: [{ type: "text", text: blockState.blockedMessage ?? 'Comet is blocked. Check login status.' }], isError: true };
        }

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        let clickResult: { success: boolean; method?: string; needsSelect?: boolean; error?: string };
        try {
          const result = await cometClient.evaluate(`
            (() => {
              const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
              if (btn) { btn.click(); return { success: true, method: 'button' }; }
              const allButtons = document.querySelectorAll('button');
              for (const b of allButtons) {
                const text = b.innerText.toLowerCase();
                if ((text.includes('search') || text.includes('research') ||
                     text.includes('labs') || text.includes('learn')) &&
                    b.querySelector('svg')) {
                  b.click();
                  return { success: true, method: 'dropdown-open', needsSelect: true };
                }
              }
              return { success: false, error: "Mode selector not found" };
            })()
          `);
          clickResult = result.result.value as typeof clickResult;
        } catch (e: any) {
          if (e?.message?.includes('WebSocket') || e?.message?.includes('CLOSED') || e?.message?.includes('closed')) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            try { await cometClient.ensureConnection(); } catch { /* best-effort */ }
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          }
          throw e;
        }

        if (clickResult.success && clickResult.needsSelect) {
          await new Promise(resolve => setTimeout(resolve, 300));
          let selectRes: { success: boolean; error?: string };
          try {
            const selectResult = await cometClient.evaluate(`
              (() => {
                const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
                for (const item of items) {
                  if (item.innerText.toLowerCase().includes('${mode}')) {
                    item.click();
                    return { success: true };
                  }
                }
                return { success: false, error: "Mode option not found in dropdown" };
              })()
            `);
            selectRes = selectResult.result.value as typeof selectRes;
          } catch (e: any) {
            if (e?.message?.includes('WebSocket') || e?.message?.includes('CLOSED') || e?.message?.includes('closed')) {
              await new Promise(resolve => setTimeout(resolve, 1500));
              try { await cometClient.ensureConnection(); } catch { /* best-effort */ }
              return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
            }
            throw e;
          }
          if (selectRes.success) {
            // Mode switch navigates to a new page; wait and reconnect CDP
            await new Promise(resolve => setTimeout(resolve, 1500));
            try { await cometClient.ensureConnection(); } catch { /* best-effort */ }
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          // Mode switch navigates to a new page; wait and reconnect CDP
          await new Promise(resolve => setTimeout(resolve, 1500));
          try { await cometClient.ensureConnection(); } catch { /* best-effort */ }
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
      }

      case "comet_upload": {
        const filePath = args?.filePath as string;
        const selector = args?.selector as string | undefined;
        const checkOnly = args?.checkOnly as boolean | undefined;

        if (!filePath) {
          return { content: [{ type: "text", text: "Error: filePath is required" }], isError: true };
        }

        // Check if file exists
        const fs = await import('fs');
        if (!fs.existsSync(filePath)) {
          return { content: [{ type: "text", text: `Error: File not found: ${filePath}` }], isError: true };
        }

        // If checkOnly, just report what file inputs exist
        if (checkOnly) {
          const inputInfo = await cometClient.hasFileInput();
          if (inputInfo.found) {
            let msg = `Found ${inputInfo.count} file input(s) on the page:\n`;
            msg += inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
            msg += `\n\nUse comet_upload with filePath to upload to one of these inputs.`;
            return { content: [{ type: "text", text: msg }] };
          } else {
            return { content: [{ type: "text", text: "No file input elements found on the current page. Navigate to a page with a file upload form first." }] };
          }
        }

        // Perform the upload
        const result = await cometClient.uploadFile(filePath, selector);

        if (result.success) {
          return { content: [{ type: "text", text: result.message }] };
        } else {
          // If no input found, provide helpful info
          if (!result.inputFound) {
            const inputInfo = await cometClient.hasFileInput();
            let msg = result.message;
            if (inputInfo.found) {
              msg += `\n\nAvailable file inputs:\n${inputInfo.selectors.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`;
              msg += `\n\nTry specifying a selector parameter.`;
            }
            return { content: [{ type: "text", text: msg }], isError: true };
          }
          return { content: [{ type: "text", text: result.message }], isError: true };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
