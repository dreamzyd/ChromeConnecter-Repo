import { CDPHandler } from "../lib/cdp-handler.js";
import {
  isTotpBound,
  setTotpBound,
  getSessionExpiry,
  setSessionExpiry,
  clearSession,
  clearAll,
  isSessionActive,
  getSessionDuration
} from "../lib/pairing.js";

const DEFAULT_SERVER_URL = "wss://your-domain.example.com";
const HEARTBEAT_INTERVAL_MS = 20000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];

const state = {
  enabled: false,
  totpBound: false,
  sessionExpiresAt: 0,
  qrCodeDataUrl: "",
  otpauthUri: "",
  serverUrl: DEFAULT_SERVER_URL,
  ws: null,
  connectedTabs: new Map(),
  heartbeatTimer: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  isConnecting: false,
  sessionExpiryTimer: null,
  pendingVerifyTotp: null,
  pendingResetTotp: null
};

function isSocketOpen() {
  return Boolean(state.ws && state.ws.readyState === WebSocket.OPEN);
}

function isSocketConnecting() {
  return Boolean(state.ws && state.ws.readyState === WebSocket.CONNECTING);
}

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "status",
    connected: isSocketOpen(),
    enabled: state.enabled
  }).catch(() => {
  });
}

function broadcastTotpState() {
  chrome.runtime.sendMessage({
    type: "totpStateChanged",
    bound: state.totpBound,
    sessionExpiresAt: state.sessionExpiresAt,
    qrCodeDataUrl: state.qrCodeDataUrl,
    otpauthUri: state.otpauthUri
  }).catch(() => {
  });
}

function clearHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (isSocketOpen()) {
      state.ws.send(JSON.stringify({ type: "ping" }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function clearReconnect() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (!state.enabled) {
    return;
  }

  clearReconnect();
  const delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
  broadcastStatus();
}

async function releaseHandlers() {
  const handlers = Array.from(state.connectedTabs.values());
  state.connectedTabs.clear();

  await Promise.all(handlers.map((handler) => handler.detach().catch(() => ({ success: false }))));
}

function resolvePendingRequest(key, payload) {
  const pending = state[key];
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  state[key] = null;
  pending.resolve(payload);
}

function rejectPendingRequest(key, errorMessage) {
  const pending = state[key];
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  state[key] = null;
  pending.resolve({ success: false, error: errorMessage });
}

function clearSessionExpiryTimer() {
  if (state.sessionExpiryTimer) {
    clearTimeout(state.sessionExpiryTimer);
    state.sessionExpiryTimer = null;
  }
}

function startSessionExpiryTimer() {
  clearSessionExpiryTimer();
  const remaining = state.sessionExpiresAt - Date.now();
  if (remaining <= 0) {
    state.sessionExpiresAt = 0;
    void clearSession();
    return;
  }

  state.sessionExpiryTimer = setTimeout(() => {
    state.sessionExpiresAt = 0;
    clearSession().catch(() => {
    });
    chrome.runtime.sendMessage({ type: "sessionExpired" }).catch(() => {
    });
    broadcastTotpState();
  }, remaining);
}

async function disconnectWebSocket() {
  clearHeartbeat();
  clearReconnect();
  state.isConnecting = false;

  rejectPendingRequest("pendingVerifyTotp", "连接已断开");
  rejectPendingRequest("pendingResetTotp", "连接已断开");

  if (state.ws) {
    try {
      state.ws.onopen = null;
      state.ws.onmessage = null;
      state.ws.onclose = null;
      state.ws.onerror = null;
      state.ws.close();
    } catch (error) {
      console.error("Failed to close websocket", error);
    }
    state.ws = null;
  }

  await releaseHandlers();
  broadcastStatus();
}

function sendWebSocketMessage(payload) {
  if (isSocketOpen()) {
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  return false;
}

async function connectWebSocket() {
  if (!state.enabled || state.isConnecting || isSocketOpen() || isSocketConnecting()) {
    return;
  }

  state.isConnecting = true;
  clearReconnect();
  broadcastStatus();

  try {
    const ws = new WebSocket(state.serverUrl || DEFAULT_SERVER_URL);
    state.ws = ws;

    ws.onopen = () => {
      state.isConnecting = false;
      state.reconnectAttempt = 0;
      sendWebSocketMessage({ type: "register", extensionId: "chrome-extension" });
      sendWebSocketMessage({ type: "getTotpSetup" });
      startHeartbeat();
      broadcastStatus();
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleRelayMessage(message);
      } catch (error) {
        console.error("Failed to handle relay message", error);
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error", error);
      state.isConnecting = false;
      broadcastStatus();
    };

    ws.onclose = () => {
      clearHeartbeat();
      state.ws = null;
      state.isConnecting = false;
      rejectPendingRequest("pendingVerifyTotp", "连接已断开");
      rejectPendingRequest("pendingResetTotp", "连接已断开");
      broadcastStatus();
      scheduleReconnect();
    };
  } catch (error) {
    console.error("Failed to connect websocket", error);
    state.isConnecting = false;
    state.ws = null;
    scheduleReconnect();
  }
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs.length || typeof tabs[0].id !== "number") {
    throw new Error("No active tab available");
  }

  return tabs[0].id;
}

async function getHandlerForTab(tabId) {
  const resolvedTabId = typeof tabId === "number" ? tabId : await getActiveTabId();
  let handler = state.connectedTabs.get(resolvedTabId);

  if (!handler) {
    handler = new CDPHandler(resolvedTabId);
    const attached = await handler.attach();
    if (!attached.success) {
      throw new Error(attached.error || "Failed to attach debugger");
    }
    state.connectedTabs.set(resolvedTabId, handler);
  }

  return { handler, tabId: resolvedTabId };
}

async function sendCommandResponse(id, result) {
  sendWebSocketMessage({
    type: "response",
    id,
    success: Boolean(result?.success),
    data: result?.data,
    error: result?.error
  });
}

async function runTabCommand(tabId, operation) {
  const { handler, tabId: resolvedTabId } = await getHandlerForTab(tabId);
  const result = await operation(handler, resolvedTabId);
  if (result.success && result.data === undefined) {
    result.data = true;
  }
  return result;
}

async function handleCommand(message) {
  const { id, action, params = {} } = message;

  try {
    let result;

    switch (action) {
      case "navigate":
        result = await runTabCommand(params.tabId, (handler) => handler.navigate(params.url));
        break;
      case "screenshot":
        result = await runTabCommand(params.tabId, (handler) => handler.screenshot());
        break;
      case "click":
        result = await runTabCommand(params.tabId, (handler) => handler.clickElement(params.selector));
        break;
      case "type":
        result = await runTabCommand(params.tabId, async (handler) => {
          const clickResult = await handler.clickElement(params.selector);
          if (!clickResult.success) {
            return clickResult;
          }
          return handler.type(params.text || "");
        });
        break;
      case "evaluate":
        result = await runTabCommand(params.tabId, (handler) => handler.evaluate(params.expression || ""));
        break;
      case "getContent":
        result = await runTabCommand(params.tabId, (handler) => handler.getPageContent());
        break;
      case "getHTML":
        result = await runTabCommand(params.tabId, (handler) => handler.getPageHTML());
        break;
      case "getLinks":
        result = await runTabCommand(params.tabId, (handler) => handler.getLinks());
        break;
      case "getFormFields":
        result = await runTabCommand(params.tabId, (handler) => handler.getFormFields());
        break;
      case "fillInput":
        result = await runTabCommand(params.tabId, (handler) => handler.fillInput(params.selector, params.value));
        break;
      case "scrollTo":
        result = await runTabCommand(params.tabId, (handler) => handler.scrollTo(params.x, params.y));
        break;
      case "scrollBy":
        result = await runTabCommand(params.tabId, (handler) => handler.scrollBy(params.dx, params.dy));
        break;
      case "getTabs": {
        const tabs = await chrome.tabs.query({});
        result = {
          success: true,
          data: tabs.map((tab) => ({
            id: tab.id,
            title: tab.title,
            url: tab.url,
            active: tab.active,
            windowId: tab.windowId
          }))
        };
        break;
      }
      case "activateTab": {
        const tab = await chrome.tabs.update(params.tabId, { active: true });
        if (typeof tab.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        result = { success: true, data: tab };
        break;
      }
      case "newTab": {
        const tab = await chrome.tabs.create({ url: params.url || "chrome://newtab/" });
        result = { success: true, data: tab };
        break;
      }
      case "closeTab": {
        await chrome.tabs.remove(params.tabId);
        const existing = state.connectedTabs.get(params.tabId);
        if (existing) {
          await existing.detach();
          state.connectedTabs.delete(params.tabId);
        }
        result = { success: true, data: true };
        break;
      }
      default:
        result = { success: false, error: `Unsupported action: ${action}` };
        break;
    }

    await sendCommandResponse(id, result);
  } catch (error) {
    await sendCommandResponse(id, {
      success: false,
      error: error?.message || String(error)
    });
  }
}

async function handleRelayMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "totpSetup") {
    state.qrCodeDataUrl = typeof message.qrCodeDataUrl === "string" ? message.qrCodeDataUrl : "";
    state.otpauthUri = typeof message.otpauthUri === "string" ? message.otpauthUri : "";
    state.totpBound = Boolean(message.isSetup);
    await setTotpBound(state.totpBound);
    broadcastTotpState();
    return;
  }

  if (message.type === "totpVerified") {
    if (message.success) {
      state.totpBound = true;
      state.sessionExpiresAt = typeof message.sessionExpiresAt === "number"
        ? message.sessionExpiresAt
        : Date.now() + await getSessionDuration();
      await setTotpBound(true);
      await setSessionExpiry(state.sessionExpiresAt);
      startSessionExpiryTimer();
      broadcastTotpState();
      resolvePendingRequest("pendingVerifyTotp", {
        success: true,
        sessionExpiresAt: state.sessionExpiresAt
      });
      return;
    }

    resolvePendingRequest("pendingVerifyTotp", {
      success: false,
      error: message.error || "动态验证码校验失败"
    });
    return;
  }

  if (message.type === "totpReset") {
    state.qrCodeDataUrl = typeof message.qrCodeDataUrl === "string" ? message.qrCodeDataUrl : "";
    state.otpauthUri = typeof message.otpauthUri === "string" ? message.otpauthUri : "";
    state.totpBound = false;
    state.sessionExpiresAt = 0;
    clearSessionExpiryTimer();
    await clearAll();
    broadcastTotpState();
    resolvePendingRequest("pendingResetTotp", {
      success: Boolean(message.success),
      qrCodeDataUrl: state.qrCodeDataUrl,
      otpauthUri: state.otpauthUri,
      error: message.success ? undefined : message.error || "重置绑定失败"
    });
    return;
  }

  if (message.type === "command") {
    await handleCommand(message);
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get({
    enabled: false,
    serverUrl: DEFAULT_SERVER_URL
  });

  state.enabled = Boolean(stored.enabled);
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER_URL;
  state.totpBound = await isTotpBound();
  state.sessionExpiresAt = await getSessionExpiry();

  if (!isSessionActive(state.sessionExpiresAt)) {
    state.sessionExpiresAt = 0;
    await clearSession();
  } else {
    startSessionExpiryTimer();
  }

  broadcastStatus();
  broadcastTotpState();
}

function createPendingRequest(key, timeoutMessage, callback) {
  if (!isSocketOpen()) {
    return Promise.resolve({ success: false, error: "当前未连接到中继服务器" });
  }

  rejectPendingRequest(key, "已取消之前的请求");

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state[key] = null;
      resolve({ success: false, error: timeoutMessage });
    }, 10000);

    state[key] = { resolve, timer };
    callback();
  });
}

chrome.runtime.onInstalled.addListener(() => {
  loadSettings().then(() => {
    if (state.enabled) {
      connectWebSocket();
    }
  }).catch((error) => {
    console.error("Failed to initialize on install", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  loadSettings().then(() => {
    if (state.enabled) {
      connectWebSocket();
    }
  }).catch((error) => {
    console.error("Failed to initialize on startup", error);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const handler = state.connectedTabs.get(tabId);
  if (!handler) {
    return;
  }

  await handler.detach();
  state.connectedTabs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "toggle": {
        state.enabled = Boolean(message.enabled);
        await chrome.storage.local.set({ enabled: state.enabled });

        if (state.enabled) {
          connectWebSocket();
        } else {
          await disconnectWebSocket();
        }

        const status = { connected: isSocketOpen(), enabled: state.enabled };
        broadcastStatus();
        sendResponse(status);
        break;
      }
      case "updateServerUrl": {
        state.serverUrl = String(message.serverUrl || DEFAULT_SERVER_URL).trim() || DEFAULT_SERVER_URL;
        await chrome.storage.local.set({ serverUrl: state.serverUrl });
        await disconnectWebSocket();
        if (state.enabled) {
          connectWebSocket();
        }
        sendResponse({ success: true, connected: isSocketOpen() });
        break;
      }
      case "getStatus":
        sendResponse({
          connected: isSocketOpen(),
          enabled: state.enabled,
          totpBound: state.totpBound,
          sessionExpiresAt: state.sessionExpiresAt,
          qrCodeDataUrl: state.qrCodeDataUrl
        });
        break;
      case "getTotpStatus":
        sendResponse({
          bound: state.totpBound,
          sessionExpiresAt: state.sessionExpiresAt,
          qrCodeDataUrl: state.qrCodeDataUrl
        });
        break;
      case "requestTotpSetup": {
        if (state.qrCodeDataUrl) {
          sendResponse({ qrCodeDataUrl: state.qrCodeDataUrl, otpauthUri: state.otpauthUri });
        } else if (isSocketOpen()) {
          sendWebSocketMessage({ type: "getTotpSetup" });
          sendResponse({ qrCodeDataUrl: "", pending: true });
        } else {
          sendResponse({ qrCodeDataUrl: "", error: "当前未连接到中继服务器" });
        }
        break;
      }
      case "confirmTotpBind":
        state.totpBound = true;
        await setTotpBound(true);
        broadcastTotpState();
        sendResponse({ success: true });
        break;
      case "verifyTotp": {
        const code = String(message.code || "").trim();
        if (!/^\d{6}$/.test(code)) {
          sendResponse({ success: false, error: "验证码必须为 6 位数字" });
          return;
        }

        const sessionDurationMs = await getSessionDuration();
        const result = await createPendingRequest(
          "pendingVerifyTotp",
          "动态验证码校验超时，请稍后重试",
          () => {
            sendWebSocketMessage({ type: "verifyTotp", code, sessionDurationMs });
          }
        );
        sendResponse(result);
        break;
      }
      case "resetTotp": {
        const result = await createPendingRequest(
          "pendingResetTotp",
          "重置绑定超时，请稍后重试",
          () => {
            sendWebSocketMessage({ type: "resetTotp" });
          }
        );
        sendResponse(result);
        break;
      }
      case "updateSessionDuration": {
        sendResponse({ success: true });
        break;
      }
      default:
        sendResponse({ success: false, error: "Unknown message type" });
        break;
    }
  })().catch((error) => {
    sendResponse({ success: false, error: error?.message || String(error) });
  });

  return true;
});

loadSettings().then(() => {
  if (state.enabled) {
    connectWebSocket();
  }
}).catch((error) => {
  console.error("Failed to initialize service worker", error);
});
