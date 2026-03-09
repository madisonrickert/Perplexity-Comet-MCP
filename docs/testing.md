# Test Battery

A structured test battery for AI agents to validate that all MCP tools work correctly end-to-end. Run these tests in order — each group builds on the previous one. A Perplexity account must be logged in and the launchd plist installed (see [macOS Login Persistence](../README.md#connection-issues)) before running.

---

## Group 1: Connection & Lifecycle

**1.1 — Cold connect (Comet not running)**

Stop Comet if it is running, then:
```
comet_connect
```
Expected: Comet launches, debug port attaches, response contains `"Connected"` or `"Comet started"`. No error.

**1.2 — Already-connected idempotency**

With Comet running and attached:
```
comet_connect
```
Expected: Response reports already connected. No restart, no error, same session.

**1.3 — Non-debug Comet running (no restart)**

Manually launch Comet without `--remote-debugging-port`, then:
```
comet_connect
```
Expected: Response reports Comet is running but not exposing the debug port. Instructs user to call with `allowRestart=true`. Does NOT silently restart.

**1.4 — Non-debug Comet running (with restart)**

Same setup as 1.3, then:
```
comet_connect allowRestart=true
```
Expected: Comet is restarted with debug port, response contains `"Connected"`. Login session persists (no login page).

**1.5 — Session persistence across restart (macOS)**

With a logged-in session:
1. Stop Comet completely.
2. Call `comet_connect`.
3. Call `comet_ask "Reply with just the word VERIFIED"`.

Expected: Response is `VERIFIED` (or similar). No login redirect. Confirms launchd + Keychain access is working.

---

## Group 2: `comet_ask` — Basic Queries

**2.1 — Simple factual question**
```
comet_ask "What is the capital of France? Reply in one word."
```
Expected: Response contains `"Paris"`. Completes without timeout.

**2.2 — New chat flag**
```
comet_ask "Remember the number 42." newChat=true
comet_ask "What number did I ask you to remember?"
```
Expected: First ask gets a confirmation. Second ask (no `newChat`) continues the same thread and answers `42`.

**2.3 — New chat resets context**
```
comet_ask "Remember the number 42." newChat=true
comet_ask "What number did I ask you to remember?" newChat=true
```
Expected: Second ask starts fresh and cannot recall the number.

**2.4 — Timeout respected**
```
comet_ask "Write a 10,000 word essay on the history of Rome." timeout=3000
```
Expected: Returns within ~3 seconds with a timeout or partial result. Does not hang.

**2.5 — Context injection**
```
comet_ask "The project is called Artemis. What is the project name?" context="Project name: Artemis"
```
Expected: Response cites `"Artemis"`. Confirms context parameter is prepended correctly.

---

## Group 3: `comet_ask` — Agentic Browsing

**3.1 — URL navigation**
```
comet_ask "Go to example.com and tell me the page heading."
```
Expected: Comet navigates to `example.com`, response contains `"Example Domain"` (the `<h1>` text). A browsing tab may open.

**3.2 — Tab policy: preserve (default)**
```
comet_ask "Go to example.com and return the page title." tabPolicy=preserve
comet_tabs
```
Expected: After `comet_ask` returns, `comet_tabs` lists the `example.com` tab still open.

**3.3 — Tab policy: cleanup**
```
comet_ask "Go to example.com and return the page title." tabPolicy=cleanup
comet_tabs
```
Expected: After `comet_ask` returns, `comet_tabs` shows no `example.com` tab (cleaned up).

**3.4 — Multi-step agentic task**
```
comet_ask "Go to github.com/trending, find the top-ranked repository today, and tell me its name and star count."
```
Expected: Comet navigates to GitHub Trending, returns a repo name and star count. May take 30–60 seconds.

---

## Group 4: `comet_poll` and `comet_stop`

**4.1 — Poll while idle**
```
comet_poll
```
Expected: Response reports `IDLE` or `no active task`. No error.

**4.2 — Poll during active task**

Start a long-running ask without waiting for it, then immediately poll:
```
comet_ask "Go to wikipedia.org and summarize the featured article in 5 bullet points." timeout=120000
comet_poll
```
Expected: `comet_poll` returns `WORKING` status with current step(s) listed (e.g., `"Navigating to wikipedia.org"`).

**4.3 — Stop active task**

Start the same long ask, then stop it:
```
comet_ask "Go to wikipedia.org and summarize the featured article." timeout=120000
comet_stop
```
Expected: `comet_stop` returns a confirmation that the task was halted. Subsequent `comet_poll` returns `IDLE`.

---

## Group 5: `comet_screenshot`

**5.1 — Screenshot while idle**
```
comet_screenshot
```
Expected: Returns PNG image data of the current Comet view. Non-empty binary/base64 payload. No error.

**5.2 — Screenshot after navigation**
```
comet_ask "Go to example.com."
comet_screenshot
```
Expected: Screenshot shows the `example.com` page content (visually or confirmed by description).

---

## Group 6: `comet_tabs`

**6.1 — List with no external tabs**

With only Perplexity UI open (no agent-browsed pages):
```
comet_tabs
```
Expected: Reports 0 external browsing tabs, or shows only Perplexity-internal tabs filtered out. No error.

**6.2 — List after navigation**

After `comet_ask` opens a tab:
```
comet_tabs
```
Expected: Lists the opened browsing tab with its domain and URL. Type shown as `AGENT-BROWSING` or equivalent.

**6.3 — Switch to a tab by domain**
```
comet_tabs action=switch domain="example.com"
```
Expected: Comet brings the `example.com` tab into focus. Response confirms the switch.

**6.4 — Close a tab by domain**
```
comet_tabs action=close domain="example.com"
```
Expected: Tab is closed. Subsequent `comet_tabs` no longer lists it.

**6.5 — Last-tab protection**

With exactly one external browsing tab open:
```
comet_tabs action=close domain="<the only tab's domain>"
```
Expected: Close is rejected with an error message explaining the last tab cannot be closed. Comet does not crash.

---

## Group 7: `comet_mode`

**7.1 — Read current mode**
```
comet_mode
```
Expected: Returns the current mode name (e.g., `"search"`). No error.

**7.2 — Switch to each mode**
```
comet_mode mode=research
comet_mode mode=labs
comet_mode mode=learn
comet_mode mode=search
```
Expected: Each call returns a confirmation of the mode switch. Final state is `search`.

**7.3 — Mode affects ask behavior**
```
comet_mode mode=research
comet_ask "Explain how Chromium encrypts cookies on macOS."
```
Expected: Response is noticeably more detailed and sourced than a `search` mode reply. (Qualitative check.)

---

## Group 8: `comet_upload`

**8.1 — Check inputs on a page with a file input**
```
comet_ask "Go to https://www.w3schools.com/tags/tryit.asp?filename=tryhtml5_input_type_file"
comet_upload filePath="/tmp/dummy.txt" checkOnly=true
```
Expected: Reports at least one file input found with its selector.

**8.2 — Upload a file**

Create a small test file first:
```bash
echo "test" > /tmp/comet-test-upload.txt
```
Then:
```
comet_ask "Go to https://www.w3schools.com/tags/tryit.asp?filename=tryhtml5_input_type_file"
comet_upload filePath="/tmp/comet-test-upload.txt"
```
Expected: Upload succeeds. Response confirms the filename was attached.

**8.3 — Upload to non-existent input**
```
comet_upload filePath="/tmp/comet-test-upload.txt" selector="#does-not-exist"
```
Expected: Error message. Does not crash or hang.

**8.4 — Upload non-existent file**
```
comet_upload filePath="/tmp/file-that-does-not-exist.txt"
```
Expected: Error message indicating file not found. Does not crash.

---

## Group 9: Error Handling & Edge Cases

**9.1 — Ask with Comet disconnected**

Stop Comet completely, then:
```
comet_ask "Hello"
```
Expected: MCP auto-reconnects (via `comet_connect` internally) or returns a clear error. Does not hang indefinitely.

**9.2 — Empty prompt**
```
comet_ask ""
```
Expected: Either returns a graceful error or Perplexity handles it without crashing the MCP.

**9.3 — Very long prompt**
```
comet_ask "<repeat 'word ' 2000 times>"
```
Expected: Either truncated gracefully or accepted. MCP does not crash or throw an unhandled exception.

**9.4 — Switch invalid mode**
```
comet_mode mode=invalid_mode_name
```
Expected: Returns an error or ignores the invalid value. Does not crash.

**9.5 — Screenshot with Comet disconnected**

Stop Comet, then:
```
comet_screenshot
```
Expected: Returns a clear error message. Does not hang.

---

## Pass Criteria

A test **passes** when:
- The expected output is returned (exact match or semantic match where noted).
- No unhandled exception, crash, or indefinite hang occurs.
- The MCP process remains alive and responsive after the test.

A test **fails** when:
- An unexpected error is returned.
- The MCP crashes or becomes unresponsive.
- Comet launches a login page when a session should already be active (Groups 2–9).
- A tab operation affects Perplexity's own internal tabs.
