# ChromeConnecter - Remote Browser Control Skill

You can control the user's Chrome browser remotely through the ChromeConnecter Relay Server. The user has a Chrome extension installed that accepts commands via WebSocket, and you interact with it through a local HTTP API.

## 🤖 AI Automated Crawling & Script Maintenance Workflow (CRITICAL)
When the user asks you to fetch, download, or crawl a specific webpage/post, you MUST follow this strict workflow to ensure reusable, site-specific Python crawler scripts are maintained.

### Step 1: Identify Domain & Setup
1. Extract the domain name from the target URL to create a `site_category` (e.g., `bbs.quantclass.cn` -> `quantclass_bbs`).
2. Ensure you have the `sessionToken` (ask user for TOTP if not available or expired).

### Step 2: Check for Existing Script
1. Look in the `crawlers/` directory for an existing script named `<site_category>.py` (e.g., `crawlers/quantclass_bbs.py`).
2. If it exists, execute it using the terminal: `export CHROME_SESSION_TOKEN="<token>"; python3 crawlers/<site_category>.py <URL>`.
3. If it succeeds, inform the user where the files are saved. You are done!
4. If it fails OR does not exist, proceed to Step 3.

### Step 3: Analyze & Maintain Script
1. If no script exists, use the provided `crawlers/crawler_template.py` as a baseline.
2. Use the `navigate` and `getHTML` (or `evaluate`) API commands directly via curl/python to inspect the DOM of the target URL.
3. Identify the correct CSS selectors for:
   - Page content/text
   - Attachments or specific download buttons (which may require scrolling or waiting).
4. Create or fix the script `crawlers/<site_category>.py`.
   - The script MUST import and use `crawlers.utils`.
   - It MUST save text and decoded attachments using the `get_save_dir(SITE_CATEGORY, title)` format.
5. Re-run the script. Repeat this Step 3 until the script successfully downloads the correct content and attachments to the `downloads/<site_category>/...` directory.

---

## Prerequisites

1. The Relay Server must be running (default: `http://127.0.0.1:18794`)
2. The user's Chrome extension must be connected (ON state, with Google Authenticator bound)
3. You must first establish a session using a 6-digit TOTP code from Google Authenticator

## Connection Flow

### Step 1: Check TOTP Status

Verify that Google Authenticator is configured:

```bash
curl http://127.0.0.1:18794/api/totp/status
```

**Response:**
```json
{ "configured": true }
```

If `configured` is `false`, the user needs to open the Chrome extension popup and scan the QR code with Google Authenticator first.

### Step 2: Connect with TOTP Code

Ask the user for their current 6-digit Google Authenticator code, then connect:

```bash
curl -X POST http://127.0.0.1:18794/api/connect \
  -H "Content-Type: application/json" \
  -d '{"totpCode": "123456", "sessionDurationMs": 28800000}'
```

**Request fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| totpCode | string | Yes | 6-digit code from Google Authenticator |
| sessionDurationMs | number | No | Session duration in ms (default 28800000 = 8h). Options: 3600000 (1h), 7200000 (2h), 14400000 (4h), 28800000 (8h), 43200000 (12h), 86400000 (24h) |

**Response (success):**
```json
{
  "success": true,
  "sessionToken": "64-char-hex-token",
  "sessionDurationMs": 28800000,
  "sessionExpiresAt": 1735689600000
}
```

**Response (failure):**
```json
{
  "success": false,
  "error": "Invalid or expired TOTP code"
}
```

Save the `sessionToken` for ALL subsequent requests. The session validity is **configurable** (default: 8 hours). The duration can be set via the Chrome extension popup or by passing `sessionDurationMs` in the connect request.

### Step 3: Use the Session Token

All command and status requests require the session token as a Bearer token:

```
Authorization: Bearer <sessionToken>
```

## API Reference

Base URL: `http://127.0.0.1:18794`

### POST /api/connect

Establish a session with a TOTP code.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| totpCode | string | Yes | 6-digit code from Google Authenticator |
| sessionDurationMs | number | No | Session duration in ms (default 28800000 = 8h). Options: 3600000, 7200000, 14400000, 28800000, 43200000, 86400000 |

### GET /api/totp/status

Check if Google Authenticator TOTP is configured. Localhost only.

### GET /api/totp/setup

Initial TOTP setup (returns QR code data URL and otpauth URI). Localhost only. Fails if already configured.

### POST /api/totp/reset

Reset TOTP binding and invalidate all sessions. Localhost only.

### POST /api/command

Send a browser control command. Requires `Authorization: Bearer <token>` header.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| action | string | Yes | The command action name (see below) |
| params | object | No | Parameters for the command |

### GET /api/status

Check if the extension is still connected. Requires `Authorization: Bearer <token>` header.

**Response:**
```json
{
  "connected": true,
  "stats": {
    "extensionConnected": true,
    "activeSessions": 1
  }
}
```

### POST /api/disconnect

End the session. Requires `Authorization: Bearer <token>` header.

## Available Commands

### navigate

Open a URL in the active tab.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "navigate", "params": {"url": "https://example.com"}}'
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| url | string | Yes | The URL to navigate to |

### screenshot

Capture the visible page as a base64-encoded PNG.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "screenshot"}'
```

Returns `{ "success": true, "data": "<base64-png>" }`.

### getContent

Get the page title, full text content, and current URL.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "getContent"}'
```

Returns `{ "success": true, "data": { "title": "...", "text": "...", "url": "..." } }`.

### getHTML

Get the full HTML source of the page.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "getHTML"}'
```

Returns `{ "success": true, "data": "<html>...</html>" }`.

### click

Click an element using a CSS selector.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "click", "params": {"selector": ".my-button"}}'
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| selector | string | Yes | CSS selector for the element to click |

### type

Click an element then type text into it.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "type", "params": {"selector": "#search", "text": "hello world"}}'
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| selector | string | Yes | CSS selector for the input element |
| text | string | Yes | Text to type character by character |

### evaluate

Run JavaScript in the page context and return the result.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "evaluate", "params": {"expression": "document.title"}}'
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| expression | string | Yes | JavaScript expression. Use IIFE for complex logic: `(() => { ... })()` |

### fillInput

Set a form field's value using a CSS selector. Dispatches `input` and `change` events.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SESSION_TOKEN" \
  -d '{"action": "fillInput", "params": {"selector": "#search", "value": "query"}}'
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| selector | string | Yes | CSS selector for the input element |
| value | string | Yes | Value to set |

### getLinks

Get all anchor links on the page.

```bash
curl -X POST http://127.0.0.1:18794/api/command \
  -H "Content-Type: application/json" \
```
