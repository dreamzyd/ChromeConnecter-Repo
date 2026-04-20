import {
  isTotpBound,
  setTotpBound,
  getSessionExpiry,
  setSessionExpiry,
  clearSession,
  clearAll,
  isSessionActive,
  formatTimeRemaining,
  getSessionDuration,
  setSessionDuration
} from "../lib/pairing.js";

const DEFAULT_SERVER_URL = "ws://localhost:18793";

const enabledToggle = document.getElementById("enabled-toggle");
const statusChip = document.getElementById("status-chip");
const statusText = document.getElementById("status-text");
const statusHint = document.getElementById("status-hint");
const totpPanel = document.getElementById("totp-panel");
const totpStates = Array.from(document.querySelectorAll(".totp-state"));
const totpHelp = document.getElementById("totp-help");
const totpQrcode = document.getElementById("totp-qrcode");
const confirmBindButton = document.getElementById("confirm-bind-button");
const totpCodeInput = document.getElementById("totp-code-input");
const verifyButton = document.getElementById("verify-button");
const resetTotpButtons = Array.from(document.querySelectorAll(".reset-totp-button"));
const sessionStatus = document.getElementById("session-status");
const sessionTimer = document.getElementById("session-timer");
const sessionDurationSelect = document.getElementById("session-duration");
const serverUrlInput = document.getElementById("server-url");

let countdownTimer = null;
let currentSessionExpiresAt = 0;

function setStatus(status) {
  const normalized = status.connected
    ? "connected"
    : status.enabled
      ? "connecting"
      : "disconnected";

  statusChip.dataset.status = normalized;

  if (normalized === "connected") {
    statusText.textContent = "已连接";
    statusHint.textContent = "已连接到中继服务器，可接收远程控制指令";
    return;
  }

  if (normalized === "connecting") {
    statusText.textContent = "连接中";
    statusHint.textContent = "扩展已启用，正在尝试连接中继服务器";
    return;
  }

  statusText.textContent = "未连接";
  statusHint.textContent = "关闭状态下不会连接中继服务器";
}

async function sendRuntimeMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.error("Failed to send runtime message", error);
    return null;
  }
}

function clearCountdownTimer() {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

async function expireSessionLocally() {
  currentSessionExpiresAt = 0;
  clearCountdownTimer();
  await clearSession();
  renderTotpState({ bound: true, sessionExpiresAt: 0 });
}

function updateTimerLabel(expiresAt) {
  sessionTimer.textContent = `剩余时间: ${formatTimeRemaining(expiresAt)}`;
}

function startCountdown(expiresAt) {
  clearCountdownTimer();

  if (!isSessionActive(expiresAt)) {
    void expireSessionLocally();
    return;
  }

  currentSessionExpiresAt = expiresAt;
  updateTimerLabel(expiresAt);
  countdownTimer = window.setInterval(() => {
    if (!isSessionActive(currentSessionExpiresAt)) {
      void expireSessionLocally();
      return;
    }

    updateTimerLabel(currentSessionExpiresAt);
  }, 1000);
}

let qrCodeRequested = false;

async function requestQrCode() {
  if (qrCodeRequested) {
    return;
  }

  qrCodeRequested = true;

  try {
    const response = await sendRuntimeMessage({ type: "requestTotpSetup" });
    if (response?.qrCodeDataUrl) {
      totpQrcode.src = response.qrCodeDataUrl;
      totpQrcode.style.display = "";
      totpHelp.textContent = "绑定后请使用 Google Authenticator 输入 6 位动态验证码。";
    }
  } catch (error) {
    console.error("Failed to request QR code", error);
  } finally {
    qrCodeRequested = false;
  }
}

function setActiveTotpState(state) {
  totpPanel.dataset.totpState = state;
  for (const section of totpStates) {
    section.classList.toggle("active", section.dataset.state === state);
  }
}

function renderTotpState({ bound, sessionExpiresAt, qrCodeDataUrl }) {
  const verified = isSessionActive(sessionExpiresAt);

  if (typeof qrCodeDataUrl === "string" && qrCodeDataUrl) {
    totpQrcode.src = qrCodeDataUrl;
    totpQrcode.style.display = "";
  } else {
    totpQrcode.style.display = "none";
  }

  if (!bound) {
    clearCountdownTimer();
    currentSessionExpiresAt = 0;
    setActiveTotpState("unbound");
    totpHelp.textContent = "绑定后请使用 Google Authenticator 输入 6 位动态验证码。";

    if (!qrCodeDataUrl) {
      totpHelp.textContent = "正在加载二维码…";
      void requestQrCode();
    }
    return;
  }

  if (!verified) {
    clearCountdownTimer();
    currentSessionExpiresAt = 0;
    setActiveTotpState("bound");
    totpHelp.textContent = "请输入 Google Authenticator 当前显示的 6 位验证码。";
    return;
  }

  setActiveTotpState("verified");
  sessionStatus.textContent = "会话有效";
  totpHelp.textContent = "验证通过后可在会话有效期内直接接收远程控制指令。";
  startCountdown(sessionExpiresAt);
}

async function syncLocalTotpState({ bound, sessionExpiresAt }) {
  await setTotpBound(Boolean(bound));

  if (isSessionActive(sessionExpiresAt)) {
    await setSessionExpiry(sessionExpiresAt);
  } else {
    await clearSession();
  }
}

async function refreshTotpState() {
  const status = await sendRuntimeMessage({ type: "getTotpStatus" });
  const bound = typeof status?.bound === "boolean" ? status.bound : await isTotpBound();
  const sessionExpiresAt = typeof status?.sessionExpiresAt === "number"
    ? status.sessionExpiresAt
    : await getSessionExpiry();

  await syncLocalTotpState({ bound, sessionExpiresAt });
  renderTotpState({
    bound,
    sessionExpiresAt,
    qrCodeDataUrl: status?.qrCodeDataUrl || ""
  });
}

async function initializePopup() {
  const stored = await chrome.storage.local.get({
    enabled: false,
    serverUrl: DEFAULT_SERVER_URL
  });

  enabledToggle.checked = Boolean(stored.enabled);
  serverUrlInput.value = stored.serverUrl || DEFAULT_SERVER_URL;

  const durationMs = await getSessionDuration();
  sessionDurationSelect.value = String(durationMs);

  const status = await sendRuntimeMessage({ type: "getStatus" });
  setStatus({
    enabled: Boolean(stored.enabled),
    connected: Boolean(status?.connected)
  });

  await refreshTotpState();
}

async function handleToggleChange() {
  const enabled = enabledToggle.checked;
  await chrome.storage.local.set({ enabled });
  const status = await sendRuntimeMessage({ type: "toggle", enabled });
  setStatus({ enabled, connected: Boolean(status?.connected) });
}

async function handleConfirmBind() {
  const response = await sendRuntimeMessage({ type: "confirmTotpBind" });
  if (!response?.success) {
    totpHelp.textContent = response?.error || "绑定状态更新失败，请稍后重试。";
    return;
  }

  await setTotpBound(true);
  renderTotpState({ bound: true, sessionExpiresAt: 0 });
}

async function handleVerify() {
  const code = totpCodeInput.value.replace(/\D/g, "").slice(0, 6);
  totpCodeInput.value = code;

  if (code.length !== 6) {
    totpHelp.textContent = "请输入 6 位验证码。";
    totpCodeInput.focus();
    return;
  }

  const response = await sendRuntimeMessage({ type: "verifyTotp", code });
  if (!response?.success) {
    totpHelp.textContent = response?.error || "验证码校验失败，请检查后重试。";
    totpCodeInput.focus();
    totpCodeInput.select();
    return;
  }

  const sessionExpiresAt = Number(response.sessionExpiresAt) || 0;
  await syncLocalTotpState({ bound: true, sessionExpiresAt });
  renderTotpState({ bound: true, sessionExpiresAt });
}

async function handleResetTotp() {
  if (!window.confirm("确定要重置谷歌验证器绑定吗？")) {
    return;
  }

  totpHelp.textContent = "正在重置…";

  const response = await sendRuntimeMessage({ type: "resetTotp" });
  if (!response?.success) {
    totpHelp.textContent = response?.error || "重置绑定失败，请稍后重试。";
    return;
  }

  await clearAll();
  totpCodeInput.value = "";

  // 直接用 response 中携带的 QR 数据切换到 unbound 界面
  renderTotpState({
    bound: false,
    sessionExpiresAt: 0,
    qrCodeDataUrl: response.qrCodeDataUrl || ""
  });
}

let serverUrlSaveTimer = null;

function scheduleServerUrlSave() {
  window.clearTimeout(serverUrlSaveTimer);
  serverUrlSaveTimer = window.setTimeout(async () => {
    const serverUrl = serverUrlInput.value.trim() || DEFAULT_SERVER_URL;
    serverUrlInput.value = serverUrl;
    await chrome.storage.local.set({ serverUrl });
    await sendRuntimeMessage({ type: "updateServerUrl", serverUrl });
    statusHint.textContent = "中继服务器地址已更新";
  }, 250);
}

enabledToggle.addEventListener("change", handleToggleChange);
confirmBindButton.addEventListener("click", handleConfirmBind);
verifyButton.addEventListener("click", handleVerify);
for (const resetButton of resetTotpButtons) {
  resetButton.addEventListener("click", handleResetTotp);
}
serverUrlInput.addEventListener("input", scheduleServerUrlSave);
serverUrlInput.addEventListener("blur", scheduleServerUrlSave);

sessionDurationSelect.addEventListener("change", async () => {
  const val = Number(sessionDurationSelect.value);
  await setSessionDuration(val);
  await sendRuntimeMessage({ type: "updateSessionDuration", durationMs: val });
});

totpCodeInput.addEventListener("input", () => {
  totpCodeInput.value = totpCodeInput.value.replace(/\D/g, "").slice(0, 6);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "status") {
    enabledToggle.checked = Boolean(message.enabled);
    setStatus({ enabled: Boolean(message.enabled), connected: Boolean(message.connected) });
  }

  if (message?.type === "totpStateChanged") {
    const bound = Boolean(message.bound);
    const sessionExpiresAt = Number(message.sessionExpiresAt) || 0;
    void syncLocalTotpState({ bound, sessionExpiresAt }).then(() => {
      renderTotpState({
        bound,
        sessionExpiresAt,
        qrCodeDataUrl: message.qrCodeDataUrl || ""
      });
    });
  }

  if (message?.type === "sessionExpired") {
    void clearSession().then(() => {
      renderTotpState({ bound: true, sessionExpiresAt: 0 });
    });
  }
});

initializePopup();
