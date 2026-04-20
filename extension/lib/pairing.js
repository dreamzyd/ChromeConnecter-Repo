const TOTP_BOUND_KEY = "totpBound";
const SESSION_EXPIRES_KEY = "sessionExpiresAt";
const SESSION_DURATION_KEY = "sessionDurationMs";
const DEFAULT_SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

export async function isTotpBound() {
  const stored = await chrome.storage.local.get({ [TOTP_BOUND_KEY]: false });
  return Boolean(stored[TOTP_BOUND_KEY]);
}

export async function setTotpBound(bound) {
  await chrome.storage.local.set({ [TOTP_BOUND_KEY]: Boolean(bound) });
  return Boolean(bound);
}

export async function getSessionExpiry() {
  const stored = await chrome.storage.local.get({ [SESSION_EXPIRES_KEY]: 0 });
  const expiresAt = stored[SESSION_EXPIRES_KEY];
  return typeof expiresAt === "number" ? expiresAt : 0;
}

export async function setSessionExpiry(expiresAt) {
  const normalized = typeof expiresAt === "number" ? expiresAt : 0;
  await chrome.storage.local.set({ [SESSION_EXPIRES_KEY]: normalized });
  return normalized;
}

export async function clearSession() {
  await chrome.storage.local.remove(SESSION_EXPIRES_KEY);
}

export async function clearAll() {
  await chrome.storage.local.remove([TOTP_BOUND_KEY, SESSION_EXPIRES_KEY]);
}

export function isSessionActive(expiresAt) {
  return typeof expiresAt === "number" && expiresAt > Date.now();
}

export function formatTimeRemaining(expiresAt) {
  if (!isSessionActive(expiresAt)) {
    return "0秒";
  }

  const totalSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}时${minutes}分`;
  }

  if (minutes > 0) {
    return `${minutes}分${seconds}秒`;
  }

  return `${seconds}秒`;
}

export async function getSessionDuration() {
  const stored = await chrome.storage.local.get({ [SESSION_DURATION_KEY]: DEFAULT_SESSION_DURATION_MS });
  const value = stored[SESSION_DURATION_KEY];
  return typeof value === "number" && value > 0 ? value : DEFAULT_SESSION_DURATION_MS;
}

export async function setSessionDuration(durationMs) {
  const normalized = typeof durationMs === "number" && durationMs > 0 ? durationMs : DEFAULT_SESSION_DURATION_MS;
  await chrome.storage.local.set({ [SESSION_DURATION_KEY]: normalized });
  return normalized;
}
