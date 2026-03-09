# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- Updated developer documentation to use `pnpm` for local install/build/test commands.
- Documented that local MCP clients configured to run `dist/index.js` must rebuild and restart the MCP child process after source changes before validating behavior.
- Documented that the current MCP runtime should be used sequentially: one `comet_ask` at a time per Comet browser session.
- Added `tabPolicy` to `comet_ask` so browsing-tab cleanup is explicit (`preserve`, `cleanup`, or `cleanup_on_blocked`) instead of always happening automatically.
- `comet_connect` now requires explicit opt-in before restarting a running non-debug Comet session, and it accepts `allowRestart` and `userDataDir` launch options.
- Debuggable Comet launches now default to a dedicated persistent remote-debug profile instead of the normal Comet default profile.

### Fixed

- `comet_ask` now returns an explicit blocked state when browser-required prompts hit Comet's logged-out browser-capability warning instead of silently treating assistant text as a successful browser action.

## [2.6.2] - 2026-01-11

### Fixed

- **WSL Support Complete** - Fixed `windowsFetch` to use PowerShell on WSL (was incorrectly using native fetch which connects to WSL localhost instead of Windows)
- **Tab Cleanup Crash** - Removed aggressive tab cleanup in `comet_connect` that was closing tabs and crashing Comet browser
- **WSL Networking Detection** - Added automatic detection of WSL mirrored networking with helpful error message and setup instructions

### Added

- **WSL Mirrored Networking Guide** - Clear instructions in error messages for enabling WSL2 mirrored networking
- **WSL Troubleshooting Docs** - Added WSL-specific troubleshooting section to README

### Changed

- Simplified `comet_connect` to preserve all existing tabs instead of cleaning up blank tabs

## [2.6.1] - 2026-01-10

### Fixed

- WSL browser launching via PowerShell with `Set-Location` to avoid UNC path issues

## [2.6.0] - 2026-01-10

### Added

- **File Upload Support** - New `comet_upload` tool for uploading files to web forms
- Major stability improvements

## [2.4.0] - 2026-01-10

### Added

- **Tab Management System** - New `comet_tabs` tool for viewing, switching, and closing browser tabs
- **Tab Registry** - Internal tracking of all external browsing tabs with purpose and domain
- **Last Tab Protection** - Prevents closing the only external tab which would crash Comet
- **Internal Tab Filtering** - Automatically filters chrome://, devtools://, and Perplexity UI tabs
- **Windows/WSL Support** - Full compatibility with Windows and WSL environments
- **PowerShell Fetch Workarounds** - Bypasses Node.js fetch issues on Windows
- **Direct CDP WebSocket Connection** - More reliable connection on Windows
- **Smart Completion Detection** - Response stability tracking instead of fixed timeouts
- **Auto-Reconnect** - Exponential backoff recovery (300ms-2s) from connection drops
- **Health Check Caching** - 2-second cache for efficient connection validation
- **Pre-Operation Checks** - Validates connection before every operation
- **Agentic Prompt Transformation** - Automatically triggers browser actions for URLs and action verbs
- **DOM-Based Submit** - More reliable prompt submission using DOM events
- **Full Response Extraction** - Captures complete responses after "X steps completed" marker
- **Tab Change Handling** - Maintains Perplexity connection during agentic browsing
- **Idle Timeout Detection** - 6-second idle detection for completion

### Changed

- Increased max reconnect attempts to 10
- Reduced poll interval to 1.5 seconds for better responsiveness
- Improved error recovery with Perplexity tab switching

### Fixed

- Connection drops during long agentic tasks
- Response truncation on complex queries
- Submit not working (text in box but not sent)
- Browser crash when closing last tab
- Incorrect tab counting due to internal Chrome tabs

## [1.0.0] - Original Release

- Initial fork from [hanzili/comet-mcp](https://github.com/hanzili/comet-mcp)
- Basic 6 tools: connect, ask, poll, stop, screenshot, mode
- macOS support
