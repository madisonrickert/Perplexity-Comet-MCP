// CDP Client wrapper for Comet browser control
// Modified for Windows/WSL support

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess, execSync } from "child_process";
import { platform } from "os";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
  TabContext,
} from "./types.js";

// Detect if running in WSL (must be before windowsFetch)
function isWSL(): boolean {
  if (platform() !== 'linux') return false;
  try {
    const release = execSync('uname -r', { encoding: 'utf8' }).toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

const IS_WSL = isWSL();

// Check if WSL can directly connect to Windows localhost (mirrored networking)
async function canConnectToWindowsLocalhost(port: number): Promise<boolean> {
  if (!IS_WSL) return true;

  const net = await import('net');
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' }, () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => {
      resolve(false);
    });
    client.setTimeout(2000, () => {
      client.destroy();
      resolve(false);
    });
  });
}

// For WSL: port to use for CDP connection
async function getWSLConnectPort(targetPort: number): Promise<number> {
  if (!IS_WSL) return targetPort;

  // Check if mirrored networking is enabled (direct localhost access works)
  const canConnect = await canConnectToWindowsLocalhost(targetPort);
  if (canConnect) {
    return targetPort;
  }

  // Cannot connect - throw helpful error
  throw new Error(
    `WSL cannot connect to Windows localhost:${targetPort}.\n\n` +
    `To fix this, enable WSL mirrored networking:\n` +
    `1. Create/edit %USERPROFILE%\\.wslconfig with:\n` +
    `   [wsl2]\n` +
    `   networkingMode=mirrored\n` +
    `2. Run: wsl --shutdown\n` +
    `3. Restart WSL and try again\n\n` +
    `Alternatively, run Claude Code from Windows PowerShell instead of WSL.`
  );
}

// Windows/WSL-compatible fetch using PowerShell
// On WSL, native fetch connects to WSL's localhost, not Windows where Comet runs
async function windowsFetch(url: string, method: string = 'GET'): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  // Use native fetch only on non-Windows AND non-WSL
  if (platform() !== 'win32' && !IS_WSL) {
    const response = await fetch(url, { method });
    return response;
  }

  // On Windows or WSL, use PowerShell to reach Windows localhost
  try {
    const psCommand = method === 'PUT'
      ? `Invoke-WebRequest -Uri '${url}' -Method PUT -UseBasicParsing | Select-Object -ExpandProperty Content`
      : `Invoke-WebRequest -Uri '${url}' -UseBasicParsing | Select-Object -ExpandProperty Content`;

    const result = execSync(`powershell.exe -NoProfile -Command "${psCommand}"`, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });

    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(result.trim())
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      json: async () => { throw error; }
    };
  }
}

// Detect platform and set appropriate Comet path
function getCometPath(): string {
  const os = platform();

  // Check for custom path via environment variable
  if (process.env.COMET_PATH) {
    return process.env.COMET_PATH;
  }

  if (os === "darwin") {
    return "/Applications/Comet.app/Contents/MacOS/Comet";
  } else if (os === "win32" || IS_WSL) {
    // Common Windows installation paths for Comet (Perplexity)
    // For WSL, these paths won't be directly usable but we track them for reference
    const possiblePaths = [
      `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      `${process.env.APPDATA}\\Perplexity\\Comet\\Application\\comet.exe`,
      "C:\\Program Files\\Perplexity\\Comet\\Application\\comet.exe",
      "C:\\Program Files (x86)\\Perplexity\\Comet\\Application\\comet.exe",
    ];

    for (const p of possiblePaths) {
      if (existsSync(p)) {
        return p;
      }
    }

    // Default to LOCALAPPDATA path
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\Application\\comet.exe`;
  }

  // Fallback for other platforms
  return "/Applications/Comet.app/Contents/MacOS/Comet";
}

const COMET_PATH = getCometPath();
const IS_WINDOWS = platform() === "win32" || IS_WSL;
const DEFAULT_PORT = 9223;

function getDefaultCometUserDataDir(): string {
  const os = platform();

  if (process.env.COMET_USER_DATA_DIR) {
    return process.env.COMET_USER_DATA_DIR;
  }

  if (os === "darwin") {
    return `${process.env.HOME}/Library/Application Support/Comet`;
  }

  if (os === "win32" || IS_WSL) {
    return `${process.env.LOCALAPPDATA}\\Perplexity\\Comet\\User Data`;
  }

   return `${process.env.HOME}/.config/comet`;
}

export interface StartCometOptions {
  allowRestart?: boolean;
  userDataDir?: string;
}

export interface StartCometResult {
  status: "connected" | "launched" | "running_no_debug_port";
  message: string;
}

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private preferredUserDataDir: string = getDefaultCometUserDataDir();
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private isReconnecting: boolean = false;
  private connectionCheckInterval: NodeJS.Timeout | null = null;
  private lastHealthCheck: number = 0;
  private healthCheckCache: boolean = false;
  private readonly HEALTH_CHECK_CACHE_MS: number = 2000; // Cache health check for 2s

  // Tab context registry for multi-tab workflow awareness
  private tabRegistry: Map<string, TabContext> = new Map();

  // Page lifecycle tracking — events accumulated per frame for the current
  // document (loaderId). Used by waitForLifecycle() so screenshots and other
  // ops can confirm the renderer has actually painted before they run.
  private frameLifecycle: Map<string, { loaderId: string; events: Set<string> }> = new Map();
  private lifecycleListener: ((params: any) => void) | null = null;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Check if connection is healthy by testing a simple operation (cached)
   */
  async isConnectionHealthy(): Promise<boolean> {
    // Return cached result if recent
    const now = Date.now();
    if (now - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS) {
      return this.healthCheckCache;
    }

    if (!this.client) {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }

    try {
      await this.client.Runtime.evaluate({ expression: '1+1', timeout: 3000 });
      this.healthCheckCache = true;
      this.lastHealthCheck = now;
      return true;
    } catch {
      this.healthCheckCache = false;
      this.lastHealthCheck = now;
      return false;
    }
  }

  /**
   * Force invalidate health cache (call after known connection issues)
   */
  invalidateHealthCache(): void {
    this.lastHealthCheck = 0;
    this.healthCheckCache = false;
  }

  /**
   * Ensure connection is healthy, reconnect if not
   */
  async ensureConnection(): Promise<void> {
    if (!await this.isConnectionHealthy()) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  /**
   * Pre-operation check - ensures connection is valid before any operation
   * Call this before critical operations
   */
  async preOperationCheck(): Promise<void> {
    // Quick check if client exists
    if (!this.client) {
      await this.reconnect();
      return;
    }

    // If we recently verified health, skip
    if (Date.now() - this.lastHealthCheck < this.HEALTH_CHECK_CACHE_MS && this.healthCheckCache) {
      return;
    }

    // Full health check
    if (!await this.isConnectionHealthy()) {
      this.invalidateHealthCache();
      await this.reconnect();
    }
  }

  /**
   * Auto-reconnect wrapper for operations with exponential backoff
   */
  async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    // Wait for ongoing reconnect
    if (this.isReconnecting) {
      let waitCount = 0;
      while (this.isReconnecting && waitCount < 20) {
        await new Promise(resolve => setTimeout(resolve, 300));
        waitCount++;
      }
    }

    // Pre-operation health check (uses cache for efficiency)
    try {
      await this.preOperationCheck();
    } catch {
      // If pre-check fails, try to proceed anyway
    }

    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket', 'CLOSED', 'not open', 'disconnected', 'readyState',
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'socket hang up',
        'Protocol error', 'Target closed', 'Session closed', 'Execution context',
        'not found', 'detached', 'crashed', 'Inspected target navigated', 'aborted'
      ];

      const isConnectionError = connectionErrors.some(e =>
        errorMessage.toLowerCase().includes(e.toLowerCase())
      );

      if (isConnectionError && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        this.isReconnecting = true;
        this.invalidateHealthCache();

        try {
          // Shorter delays for faster recovery
          const delay = Math.min(300 * Math.pow(1.3, this.reconnectAttempts - 1), 2000);
          await new Promise(resolve => setTimeout(resolve, delay));
          await this.reconnect();
          this.isReconnecting = false;
          // Retry the operation after reconnect
          return await operation();
        } catch (reconnectError) {
          this.isReconnecting = false;
          // If reconnect fails, try fresh start
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            try {
              const startResult = await this.startComet(this.state.port);
              if (startResult.status === 'running_no_debug_port') {
                throw new Error(startResult.message);
              }
              await new Promise(r => setTimeout(r, 1500));
              const targets = await this.listTargets();
              const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity'));
              const anyPage = page || targets.find(t => t.type === 'page');
              if (anyPage) {
                await this.connect(anyPage.id);
                return await operation();
              }
            } catch {
              // Last resort failed
            }
          }
          throw reconnectError;
        }
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
    }
    this.state.connected = false;
    this.client = null;

    // Verify Comet is running
    try {
      await this.getVersion();
    } catch {
      try {
        const startResult = await this.startComet(this.state.port);
        if (startResult.status === 'running_no_debug_port') {
          throw new Error(startResult.message);
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : 'Cannot connect to Comet. Ensure Comet is running with remote debugging enabled.'
        );
      }
    }

    // Try to reconnect to last target
    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        if (targets.find(t => t.id === this.lastTargetId)) {
          return await this.connect(this.lastTargetId);
        }
      } catch { /* target gone */ }
    }

    // Find best target
    const targets = await this.listTargets();
    const target = targets.find(t => t.type === 'page' && t.url.includes('perplexity.ai')) ||
                   targets.find(t => t.type === 'page' && t.url !== 'about:blank');

    if (target) {
      return await this.connect(target.id);
    }

    throw new Error('No suitable tab found for reconnection');
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();

    return {
      main: targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
      ) || null,
      sidecar: targets.find(t =>
        t.type === 'page' && t.url.includes('sidecar')
      ) || null,
      agentBrowsing: targets.find(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension') &&
        !t.url.includes('chrome://') &&
        t.url !== 'about:blank'
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: targets.filter(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  /**
   * Ensure we're connected to the main Perplexity tab
   * Used during agentic browsing when Comet may open new tabs
   */
  async ensureOnPerplexityTab(): Promise<boolean> {
    try {
      // First check if current connection is valid and on Perplexity
      if (this.client) {
        try {
          const urlResult = await this.client.Runtime.evaluate({
            expression: 'window.location.href',
            timeout: 2000
          });
          const currentUrl = urlResult.result.value as string;
          if (currentUrl?.includes('perplexity.ai')) {
            return true; // Already on Perplexity tab
          }
        } catch {
          // Current connection is stale, continue to reconnect
        }
      }

      // Find and connect to Perplexity main tab
      const tabs = await this.listTabsCategorized();
      if (tabs.main) {
        await this.connect(tabs.main.id);
        this.invalidateHealthCache();
        return true;
      }

      // Fallback: find any Perplexity tab
      const targets = await this.listTargets();
      const perplexityTab = targets.find(t =>
        t.type === 'page' && t.url.includes('perplexity.ai')
      );

      if (perplexityTab) {
        await this.connect(perplexityTab.id);
        this.invalidateHealthCache();
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if we're currently connected to the Perplexity tab
   */
  async isOnPerplexityTab(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const result = await this.client.Runtime.evaluate({
        expression: 'window.location.href',
        timeout: 2000
      });
      const url = result.result.value as string;
      return url?.includes('perplexity.ai') || false;
    } catch {
      return false;
    }
  }

  // ============ TAB REGISTRY METHODS ============

  /**
   * Extract domain from URL
   */
  private extractDomain(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Check if URL is an internal Chrome/Comet page (not a real browsing tab)
   */
  private isInternalTab(url: string): boolean {
    // Chrome internal pages
    if (url.startsWith('chrome://') ||
        url.startsWith('chrome-extension://') ||
        url.startsWith('devtools://') ||
        url === 'about:blank' ||
        url === '') {
      return true;
    }

    // ALL Perplexity URLs are internal Comet UI, not real browsing tabs
    if (url.includes('perplexity.ai')) {
      return true;
    }

    return false;
  }

  /**
   * Infer tab purpose from URL and context
   */
  private inferPurpose(url: string, title: string): TabContext['purpose'] {
    if (this.isInternalTab(url)) return 'unknown';
    if (url.includes('perplexity.ai')) return 'main';
    // Default to agent-browsing for external sites
    return 'agent-browsing';
  }

  /**
   * Update tab registry with current browser state
   */
  async refreshTabRegistry(): Promise<TabContext[]> {
    const targets = await this.listTargets();
    const currentTime = Date.now();

    // Track which tabs still exist
    const existingIds = new Set<string>();

    for (const target of targets) {
      if (target.type !== 'page') continue;

      // Skip internal Chrome tabs entirely
      if (this.isInternalTab(target.url)) continue;

      existingIds.add(target.id);

      // Update or create tab context
      const existing = this.tabRegistry.get(target.id);
      const domain = this.extractDomain(target.url);

      if (existing) {
        // Update existing entry
        existing.url = target.url;
        existing.title = target.title;
        existing.domain = domain;
        existing.lastActivity = currentTime;
        // Re-infer purpose if URL changed significantly
        if (existing.domain !== domain) {
          existing.purpose = this.inferPurpose(target.url, target.title);
        }
      } else {
        // New tab - create entry
        const context: TabContext = {
          id: target.id,
          url: target.url,
          title: target.title,
          purpose: this.inferPurpose(target.url, target.title),
          domain,
          lastActivity: currentTime,
        };
        this.tabRegistry.set(target.id, context);
      }
    }

    // Remove closed tabs from registry
    for (const id of this.tabRegistry.keys()) {
      if (!existingIds.has(id)) {
        this.tabRegistry.delete(id);
      }
    }

    return Array.from(this.tabRegistry.values());
  }

  /**
   * Get all tracked tabs with context
   */
  async getTabContexts(): Promise<TabContext[]> {
    await this.refreshTabRegistry();
    return Array.from(this.tabRegistry.values());
  }

  /**
   * Find a tab by domain (for reuse)
   */
  async findTabByDomain(domain: string): Promise<TabContext | null> {
    await this.refreshTabRegistry();
    for (const tab of this.tabRegistry.values()) {
      if (tab.domain.includes(domain) || domain.includes(tab.domain)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Find a tab by URL pattern
   */
  async findTabByUrl(urlPattern: string): Promise<TabContext | null> {
    await this.refreshTabRegistry();
    for (const tab of this.tabRegistry.values()) {
      if (tab.url.includes(urlPattern)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Find tabs by purpose
   */
  async findTabsByPurpose(purpose: TabContext['purpose']): Promise<TabContext[]> {
    await this.refreshTabRegistry();
    return Array.from(this.tabRegistry.values()).filter(t => t.purpose === purpose);
  }

  /**
   * Update tab purpose (for workflow tracking)
   */
  setTabPurpose(tabId: string, purpose: TabContext['purpose'], taskId?: string): void {
    const tab = this.tabRegistry.get(tabId);
    if (tab) {
      tab.purpose = purpose;
      if (taskId) tab.taskId = taskId;
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Set content summary for a tab
   */
  setTabContentSummary(tabId: string, summary: string): void {
    const tab = this.tabRegistry.get(tabId);
    if (tab) {
      tab.contentSummary = summary;
      tab.lastActivity = Date.now();
    }
  }

  /**
   * Navigate to URL, reusing existing tab if one exists for that domain
   */
  async navigateOrReuseTab(url: string, purpose: TabContext['purpose'] = 'agent-browsing', taskId?: string): Promise<{ tabId: string; reused: boolean }> {
    const domain = this.extractDomain(url);

    // Check if we already have a tab for this domain
    const existingTab = await this.findTabByDomain(domain);

    if (existingTab && existingTab.purpose !== 'main') {
      // Reuse existing tab
      await this.connect(existingTab.id);
      await this.navigate(url, true);
      this.setTabPurpose(existingTab.id, purpose, taskId);
      return { tabId: existingTab.id, reused: true };
    }

    // Create new tab
    const newTab = await this.newTab(url);
    await new Promise(r => setTimeout(r, 1500)); // Wait for load
    await this.connect(newTab.id);

    // Register the new tab
    const context: TabContext = {
      id: newTab.id,
      url: newTab.url,
      title: newTab.title,
      purpose,
      domain,
      lastActivity: Date.now(),
      taskId,
    };
    this.tabRegistry.set(newTab.id, context);

    return { tabId: newTab.id, reused: false };
  }

  /**
   * Get formatted tab summary for context display (filters out internal Chrome tabs)
   */
  async getTabSummary(): Promise<string> {
    const allTabs = await this.getTabContexts();

    // Filter out internal Chrome tabs - only show real browsing tabs
    const tabs = allTabs.filter(t => !this.isInternalTab(t.url));

    if (tabs.length === 0) {
      return "No browsing tabs open";
    }

    const lines: string[] = [`${tabs.length} browsing tab(s) open:`];

    for (const tab of tabs) {
      const active = tab.id === this.state.activeTabId ? " [ACTIVE]" : "";
      const task = tab.taskId ? ` (task: ${tab.taskId})` : "";
      const summary = tab.contentSummary ? ` - ${tab.contentSummary}` : "";
      lines.push(`  • ${tab.purpose.toUpperCase()}: ${tab.domain}${active}${task}${summary}`);
      lines.push(`    URL: ${tab.url.substring(0, 80)}${tab.url.length > 80 ? '...' : ''}`);
    }

    return lines.join('\n');
  }

  /**
   * Check if Comet process is running
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use tasklist to check for comet.exe
        const check = spawn('tasklist', ['/FI', 'IMAGENAME eq comet.exe', '/NH']);
        let output = '';
        check.stdout?.on('data', (data) => { output += data.toString(); });
        check.on('close', () => {
          // If comet.exe is running, output will contain "comet.exe"
          resolve(output.toLowerCase().includes('comet.exe'));
        });
        check.on('error', () => resolve(false));
      } else {
        // macOS/Linux: use pgrep
        const check = spawn('pgrep', ['-f', 'Comet.app']);
        check.on('close', (code) => resolve(code === 0));
        check.on('error', () => resolve(false));
      }
    });
  }

  /**
   * Kill any running Comet process.
   * On macOS, uses graceful AppleScript quit so Comet can flush cookies before exit.
   * Falls back to pkill if AppleScript fails.
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      if (IS_WINDOWS) {
        // Windows: use taskkill to kill comet.exe
        const kill = spawn('taskkill', ['/F', '/IM', 'comet.exe']);
        kill.on('close', () => setTimeout(resolve, 1000));
        kill.on('error', () => setTimeout(resolve, 1000));
      } else {
        // macOS: graceful quit via AppleScript lets Comet flush cookies cleanly
        const quit = spawn('osascript', ['-e', 'tell application "Comet" to quit']);
        quit.on('close', () => setTimeout(resolve, 3000));
        quit.on('error', () => {
          // Fallback to pkill if osascript is unavailable
          const kill = spawn('pkill', ['-f', 'Comet.app']);
          kill.on('close', () => setTimeout(resolve, 1000));
          kill.on('error', () => setTimeout(resolve, 1000));
        });
      }
    });
  }

  /**
   * Patch the Chromium Preferences file to prevent cookie-clear-on-exit.
   * Must be called AFTER Comet has fully quit and BEFORE the next launch,
   * because Comet overwrites Preferences on quit.
   */
  private patchProfilePreferences(userDataDir: string): void {
    const prefsPath = join(userDataDir, 'Default', 'Preferences');
    if (!existsSync(prefsPath)) return;
    try {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf8'));

      // Allow sign-in so Chromium doesn't treat this as an unsigned-in profile
      prefs.signin = prefs.signin ?? {};
      prefs.signin.allowed = true;
      // Disable the "clear cookies on exit for non-browser-signed-in profiles" migration
      prefs.signin.cookie_clear_on_exit_migration_notice_complete = false;

      // Disable browser-level clear-on-exit
      prefs.browser = prefs.browser ?? {};
      prefs.browser.clear_data_on_exit = false;

      // Mark previous session as clean so crash-recovery cleanup doesn't run
      prefs.profile = prefs.profile ?? {};
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;

      writeFileSync(prefsPath, JSON.stringify(prefs));
    } catch {
      // Non-fatal — don't block Comet launch if Preferences can't be patched
    }
  }

  private async isDebugPortReady(port: number): Promise<boolean> {
    try {
      if (IS_WINDOWS) {
        const testClient = await Promise.race([
          CDP({ port, host: '127.0.0.1' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cdp_timeout')), 2000)),
        ]);
        await testClient.close();
        return true;
      }

      const response = await Promise.race([
        windowsFetch(`http://127.0.0.1:${port}/json/version`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('http_timeout')), 2000)),
      ]);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForDebugPort(port: number, userDataDir: string): Promise<void> {
    const maxAttempts = 40;
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;
      if (await this.isDebugPortReady(port)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, attempts === 1 ? 1500 : 500));
    }

    const hint = IS_WINDOWS
      ? `Try running: "${COMET_PATH}" --remote-debugging-port=${port} --user-data-dir="${userDataDir}"`
      : `Try: ${COMET_PATH} --remote-debugging-port=${port} --user-data-dir="${userDataDir}"`;
    throw new Error(`Timeout waiting for Comet debug port. ${hint}`);
  }

  private async launchCometWithDebug(port: number, launchArgs: string[], userDataDir: string): Promise<StartCometResult> {
    if (IS_WSL) {
      let cometPath = '';
      try {
        const localAppData = execSync('cmd.exe /c echo %LOCALAPPDATA%', { encoding: 'utf8' }).trim().replace(/\r?\n/g, '');
        cometPath = `${localAppData}\\Perplexity\\Comet\\Application\\Comet.exe`;
        } catch {
          cometPath = 'C:\\Users\\' + (process.env.USER || 'user') + '\\AppData\\Local\\Perplexity\\Comet\\Application\\Comet.exe';
        }

      const psArgs = launchArgs.map(arg => arg.includes(' ') ? `\"${arg}\"` : arg).join(' ');
      const psCommand = `Set-Location C:\\; Start-Process -FilePath '${cometPath}' -ArgumentList '${psArgs}'`;
      spawn('powershell.exe', ['-NoProfile', '-Command', psCommand], {
        detached: true,
        stdio: 'ignore',
      }).unref();

      await this.waitForDebugPort(port, userDataDir);
      return { status: 'launched', message: `Comet started via WSL->PowerShell on port ${port}` };
    }

    const LAUNCHD_LABEL = 'ai.perplexity.comet-debug';
    const launchdPlist = `${process.env.HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;
    const launchdAvailable = !IS_WINDOWS && existsSync(launchdPlist);

    if (launchdAvailable) {
      spawn('launchctl', ['start', LAUNCHD_LABEL], { detached: true, stdio: 'ignore' }).unref();
    } else {
      this.cometProcess = spawn(COMET_PATH, launchArgs, {
        detached: true,
        stdio: 'ignore',
      });
      this.cometProcess.unref();
    }

    await this.waitForDebugPort(port, userDataDir);
    return { status: 'launched', message: `Comet started with debug port ${port}` };
  }

  /**
   * Start Comet browser with remote debugging enabled
   */
  async startComet(port: number = DEFAULT_PORT, options: StartCometOptions = {}): Promise<StartCometResult> {
    const allowRestart = options.allowRestart ?? false;
    const userDataDir = options.userDataDir ?? this.preferredUserDataDir;
    const launchArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--remote-allow-origins=*`,
    ];
    this.state.port = port;
    this.preferredUserDataDir = userDataDir;

    if (await this.isDebugPortReady(port)) {
      try {
        const version = await this.getVersion();
        return {
          status: 'connected',
          message: `Comet already running with debug port ${port} (${version.Browser})`,
        };
      } catch {
        return {
          status: 'connected',
          message: `Comet already running with debug port ${port}`,
        };
      }
    }

    const isRunning = await this.isCometProcessRunning();
    if (isRunning && !allowRestart) {
      return {
        status: 'running_no_debug_port',
        message:
          `Comet is already running but not exposing debug port ${port}. ` +
          `To attach MCP control, restart it with debugging enabled by calling comet_connect with allowRestart=true. ` +
          `The restart path will use the profile at ${userDataDir}.`,
      };
    }

    if (isRunning) {
      await this.killComet();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.patchProfilePreferences(userDataDir);

    return this.launchCometWithDebug(port, launchArgs, userDataDir);
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/version`);
    if (!response.ok) throw new Error(`Failed to get version: ${response.status}`);
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    // On WSL, use HTTP via PowerShell (WebSocket doesn't work across WSL/Windows boundary)
    if (IS_WSL) {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
      if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
      return response.json() as Promise<CDPTarget[]>;
    }

    // On native Windows (not WSL), use CDP Target.getTargets() to avoid HTTP issues
    if (IS_WINDOWS) {
      try {
        const tempClient = await CDP({ port: this.state.port, host: '127.0.0.1' });
        const { targetInfos } = await (tempClient as any).Target.getTargets();
        await tempClient.close();

        return targetInfos.map((t: any) => ({
          id: t.targetId,
          type: t.type,
          title: t.title,
          url: t.url,
          webSocketDebuggerUrl: `ws://127.0.0.1:${this.state.port}/devtools/page/${t.targetId}`
        }));
      } catch (error) {
        throw new Error(`Failed to list targets: ${error}`);
      }
    }

    // Fallback for other platforms (macOS, Linux)
    const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/list`);
    if (!response.ok) throw new Error(`Failed to list targets: ${response.status}`);
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    // On WSL, check if we can connect directly (mirrored networking required)
    const connectPort = await getWSLConnectPort(this.state.port);

    const options: CDP.Options = { port: connectPort, host: '127.0.0.1' };
    if (targetId) options.target = targetId;

    this.client = await CDP(options);

    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    // Subscribe to Page.lifecycleEvent so we can wait for paint readiness
    // (firstContentfulPaint, networkAlmostIdle, etc.) the way Lighthouse and
    // Puppeteer do, instead of polling document.readyState.
    this.frameLifecycle.clear();
    try {
      await this.client.Page.setLifecycleEventsEnabled({ enabled: true });
      this.lifecycleListener = (params: any) => {
        const { frameId, loaderId, name } = params || {};
        if (!frameId || !loaderId || !name) return;
        const existing = this.frameLifecycle.get(frameId);
        if (!existing || existing.loaderId !== loaderId) {
          this.frameLifecycle.set(frameId, { loaderId, events: new Set([name]) });
        } else {
          existing.events.add(name);
        }
      };
      this.client.Page.lifecycleEvent(this.lifecycleListener);
    } catch { /* lifecycle tracking is best-effort */ }

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = await this.client.Runtime.evaluate({ expression: "window.location.href" });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Wait for any frame in the current document to have fired the named
   * Page.lifecycleEvent (e.g. 'firstContentfulPaint', 'networkAlmostIdle').
   * Returns true if the event has fired (or fires before the timeout); false
   * on timeout. If the event has already fired before this is called,
   * resolves synchronously.
   */
  async waitForLifecycle(eventName: string, timeoutMs: number): Promise<boolean> {
    if (!this.client) return false;
    for (const { events } of this.frameLifecycle.values()) {
      if (events.has(eventName)) return true;
    }
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (val: boolean) => {
        if (done) return;
        done = true;
        try { (this.client as any)?.removeListener?.('Page.lifecycleEvent', listener); } catch { /* ignore */ }
        clearTimeout(timer);
        resolve(val);
      };
      const listener = (params: any) => { if (params?.name === eventName) finish(true); };
      try { (this.client as any).on('Page.lifecycleEvent', listener); }
      catch { finish(false); return; }
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean = true): Promise<NavigateResult> {
    this.ensureConnected();
    const result = await this.client!.Page.navigate({ url });
    if (waitForLoad) await this.client!.Page.loadEventFired();
    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Navigate to a URL with automatic retry on failure
   * @param url - URL to navigate to
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param retryDelay - Delay between retries in ms (default: 1000)
   */
  async navigateWithRetry(url: string, maxRetries: number = 3, retryDelay: number = 1000): Promise<{ success: boolean; url: string; attempts: number; error?: string }> {
    let lastError: string = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.withAutoReconnect(async () => {
          this.ensureConnected();
          const result = await this.client!.Page.navigate({ url });

          // Check if navigation succeeded
          if (result.errorText) {
            throw new Error(result.errorText);
          }

          // Wait for load with timeout
          await Promise.race([
            this.client!.Page.loadEventFired(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page load timeout')), 15000))
          ]);

          this.state.currentUrl = url;
        });

        return { success: true, url, attempts: attempt };
      } catch (error: any) {
        lastError = error.message || String(error);

        // Don't retry for certain errors
        if (lastError.includes('net::ERR_NAME_NOT_RESOLVED') ||
            lastError.includes('net::ERR_INVALID_URL')) {
          return { success: false, url, attempts: attempt, error: lastError };
        }

        // Wait before retry
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
        }
      }
    }

    return { success: false, url, attempts: maxRetries, error: lastError };
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png"): Promise<ScreenshotResult> {
    this.ensureConnected();

    try { await this.client!.Page.bringToFront(); } catch { /* not all targets support it */ }

    // Wait for paint readiness via Page.lifecycleEvent (Lighthouse/Puppeteer
    // approach). If firstContentfulPaint already fired for this document the
    // call returns synchronously; otherwise we wait up to 2s for the next FCP.
    await this.waitForLifecycle('firstContentfulPaint', 2000);

    // Hidden targets (e.g. the Perplexity sidecar panel) report a 0x0 layout
    // viewport; Page.captureScreenshot then waits for compositor frames that
    // never arrive and hangs for ~2 minutes. When that happens, supply an
    // explicit clip + captureBeyondViewport so the renderer produces a frame
    // immediately.
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    try {
      const metrics = await this.client!.Page.getLayoutMetrics();
      const v = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      if (!v?.clientWidth || !v?.clientHeight) {
        clip = { x: 0, y: 0, width: 1280, height: 800, scale: 1 };
      }
    } catch {
      clip = { x: 0, y: 0, width: 1280, height: 800, scale: 1 };
    }

    const result = await this.client!.Page.captureScreenshot({
      format,
      ...(clip ? { captureBeyondViewport: true, clip } : {}),
    }) as ScreenshotResult;

    if (!result?.data) {
      throw new Error(
        "Screenshot returned empty data. Ensure you're connected to a visible tab with content.",
      );
    }

    return result;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();
    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Press a key
   */
  async pressKey(key: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Input.dispatchKeyEvent({ type: "keyDown", key });
    await this.client!.Input.dispatchKeyEvent({ type: "keyUp", key });
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const response = await windowsFetch(
      `http://127.0.0.1:${this.state.port}/json/new${url ? `?${url}` : ""}`,
      'PUT'
    );
    if (!response.ok) throw new Error(`Failed to create new tab: ${response.status}`);
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<boolean> {
    try {
      if (this.client) {
        const result = await this.client.Target.closeTarget({ targetId });
        return result.success;
      }
    } catch { /* fallback to HTTP */ }

    try {
      const response = await windowsFetch(`http://127.0.0.1:${this.state.port}/json/close/${targetId}`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }

  /**
   * Upload a file to a file input element on the page
   * Uses CDP DOM.setFileInputFiles to inject file into input
   *
   * @param filePath - Absolute path to the file to upload
   * @param selector - Optional CSS selector for the file input (auto-detects if not provided)
   * @returns Result with success status and details
   */
  async uploadFile(filePath: string, selector?: string): Promise<{ success: boolean; message: string; inputFound: boolean }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      // Find the file input element
      let nodeId: number;

      if (selector) {
        // Use provided selector
        const doc = await this.client!.DOM.getDocument();
        const result = await this.client!.DOM.querySelector({
          nodeId: doc.root.nodeId,
          selector: selector
        });

        if (!result.nodeId) {
          return {
            success: false,
            message: `No element found matching selector: ${selector}`,
            inputFound: false
          };
        }
        nodeId = result.nodeId;
      } else {
        // Auto-detect file input - find first visible file input
        const doc = await this.client!.DOM.getDocument();

        // Try common file input selectors
        const selectors = [
          'input[type="file"]:not([disabled])',
          'input[type="file"]',
          '[data-testid*="file"] input',
          '[class*="upload"] input[type="file"]',
          '[class*="dropzone"] input[type="file"]'
        ];

        let found = false;
        for (const sel of selectors) {
          try {
            const result = await this.client!.DOM.querySelector({
              nodeId: doc.root.nodeId,
              selector: sel
            });
            if (result.nodeId) {
              nodeId = result.nodeId;
              found = true;
              break;
            }
          } catch {
            continue;
          }
        }

        if (!found) {
          return {
            success: false,
            message: 'No file input element found on the page. Try providing a specific selector.',
            inputFound: false
          };
        }
      }

      // Set the file on the input element
      try {
        await this.client!.DOM.setFileInputFiles({
          nodeId: nodeId!,
          files: [filePath]
        });

        // Trigger change event to notify the page
        await this.client!.Runtime.evaluate({
          expression: `
            (function() {
              const input = document.querySelector('${selector || 'input[type="file"]'}');
              if (input) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })();
          `
        });

        return {
          success: true,
          message: `File uploaded successfully: ${filePath}`,
          inputFound: true
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to set file: ${error.message}`,
          inputFound: true
        };
      }
    });
  }

  /**
   * Upload multiple files to a file input element
   *
   * @param filePaths - Array of absolute file paths
   * @param selector - Optional CSS selector for the file input
   */
  async uploadFiles(filePaths: string[], selector?: string): Promise<{ success: boolean; message: string }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const doc = await this.client!.DOM.getDocument();
      const sel = selector || 'input[type="file"]';

      const result = await this.client!.DOM.querySelector({
        nodeId: doc.root.nodeId,
        selector: sel
      });

      if (!result.nodeId) {
        return {
          success: false,
          message: `No file input found with selector: ${sel}`
        };
      }

      try {
        await this.client!.DOM.setFileInputFiles({
          nodeId: result.nodeId,
          files: filePaths
        });

        // Trigger change event
        await this.client!.Runtime.evaluate({
          expression: `
            (function() {
              const input = document.querySelector('${sel}');
              if (input) {
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })();
          `
        });

        return {
          success: true,
          message: `${filePaths.length} file(s) uploaded successfully`
        };
      } catch (error: any) {
        return {
          success: false,
          message: `Failed to upload files: ${error.message}`
        };
      }
    });
  }

  /**
   * Check if the current page has any file inputs
   */
  async hasFileInput(): Promise<{ found: boolean; count: number; selectors: string[] }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            const inputs = document.querySelectorAll('input[type="file"]');
            const selectors = [];
            inputs.forEach((input, i) => {
              let sel = 'input[type="file"]';
              if (input.id) sel = '#' + input.id;
              else if (input.name) sel = 'input[name="' + input.name + '"]';
              else if (input.className) sel = 'input[type="file"].' + input.className.split(' ')[0];
              selectors.push(sel);
            });
            return { count: inputs.length, selectors };
          })();
        `,
        returnByValue: true
      });

      const data = result.result.value as { count: number; selectors: string[] };
      return {
        found: data.count > 0,
        count: data.count,
        selectors: data.selectors
      };
    });
  }

  /**
   * Click on a file input to potentially trigger a file picker dialog
   * Note: This won't actually open a native dialog in headless mode,
   * but can trigger custom file picker UIs
   */
  async clickFileInput(selector?: string): Promise<{ success: boolean; message: string }> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();

      const sel = selector || 'input[type="file"]';

      const result = await this.client!.Runtime.evaluate({
        expression: `
          (function() {
            const input = document.querySelector('${sel}');
            if (input) {
              input.click();
              return { clicked: true };
            }
            return { clicked: false };
          })();
        `,
        returnByValue: true
      });

      const data = result.result.value as { clicked: boolean };
      return {
        success: data.clicked,
        message: data.clicked ? 'File input clicked' : 'No file input found to click'
      };
    });
  }
}

export const cometClient = new CometCDPClient();
