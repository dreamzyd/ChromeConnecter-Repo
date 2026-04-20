const crypto = require('crypto');
const WebSocket = require('ws');

class PairingManager {
  constructor(totpManager) {
    this.totpManager = totpManager;
    this.extensionWs = null;
    this.extensionId = null;
    this.sessions = new Map();
    this.DEFAULT_SESSION_MAX_AGE = 8 * 60 * 60 * 1000;
    this.sessionMaxAge = this.DEFAULT_SESSION_MAX_AGE;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000);

    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  registerExtension(extensionId, ws) {
    if (this.extensionWs && this.extensionWs !== ws && this.isSocketOpen(this.extensionWs)) {
      try {
        this.extensionWs.close();
      } catch (error) {
        // Ignore close failures while replacing an existing extension connection.
      }
    }

    this.invalidateAllSessions();
    this.extensionWs = ws;
    this.extensionId = extensionId;

    return { success: true };
  }

  unregisterExtension(ws) {
    if (this.extensionWs !== ws) {
      return;
    }

    this.extensionWs = null;
    this.extensionId = null;
    this.invalidateAllSessions();
  }

  setSessionMaxAge(durationMs) {
    if (typeof durationMs === 'number' && durationMs > 0) {
      this.sessionMaxAge = durationMs;
    }
  }

  verifyAndConnect(totpCode, durationMs) {
    if (!this.totpManager || !this.totpManager.verify(totpCode)) {
      return {
        success: false,
        error: 'Invalid or expired TOTP code'
      };
    }

    if (!this.isSocketOpen(this.extensionWs)) {
      this.extensionWs = null;
      this.extensionId = null;

      return {
        success: false,
        error: 'No extension connected'
      };
    }

    const now = Date.now();
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const maxAge = (typeof durationMs === 'number' && durationMs > 0) ? durationMs : this.sessionMaxAge;

    this.sessions.set(sessionToken, {
      createdAt: now,
      lastActivity: now,
      maxAge
    });

    return { success: true, sessionToken, sessionDurationMs: maxAge };
  }

  getExtensionWs(sessionToken) {
    if (!this.validateSession(sessionToken)) {
      return null;
    }

    return this.extensionWs;
  }

  validateSession(sessionToken) {
    const session = this.sessions.get(sessionToken);
    if (!session) {
      return false;
    }

    const now = Date.now();
    if (now - session.createdAt >= session.maxAge) {
      this.sessions.delete(sessionToken);
      return false;
    }

    if (!this.isSocketOpen(this.extensionWs)) {
      this.extensionWs = null;
      this.extensionId = null;
      this.invalidateAllSessions();
      return false;
    }

    session.lastActivity = now;
    return true;
  }

  invalidateSession(sessionToken) {
    this.sessions.delete(sessionToken);
  }

  invalidateAllSessions() {
    this.sessions.clear();
  }

  cleanup() {
    const now = Date.now();

    if (!this.isSocketOpen(this.extensionWs)) {
      this.extensionWs = null;
      this.extensionId = null;
      this.invalidateAllSessions();
      return;
    }

    for (const [sessionToken, session] of this.sessions.entries()) {
      if (now - session.createdAt >= session.maxAge) {
        this.sessions.delete(sessionToken);
      }
    }
  }

  getStats() {
    return {
      extensionConnected: this.isSocketOpen(this.extensionWs),
      activeSessions: this.sessions.size
    };
  }

  isSocketOpen(ws) {
    return Boolean(ws) && ws.readyState === WebSocket.OPEN;
  }
}

module.exports = { PairingManager };
