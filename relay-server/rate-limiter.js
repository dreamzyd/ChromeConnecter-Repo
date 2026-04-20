class RateLimiter {
  constructor(options) {
    const config = options || {};
    this.maxAttempts = Number.isInteger(config.maxAttempts) ? config.maxAttempts : 5;
    this.windowMs = Number.isInteger(config.windowMs) ? config.windowMs : 600000;
    this.attempts = new Map();

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredEntries();
    }, 60000);

    if (typeof this.cleanupInterval.unref === 'function') {
      this.cleanupInterval.unref();
    }
  }

  check(ip) {
    const now = Date.now();
    const entry = this.attempts.get(ip);

    if (!entry) {
      return { allowed: true };
    }

    if (now - entry.windowStart >= this.windowMs) {
      this.attempts.delete(ip);
      return { allowed: true };
    }

    if (entry.count >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfter: Math.max(0, this.windowMs - (now - entry.windowStart))
      };
    }

    return { allowed: true };
  }

  recordFailure(ip) {
    const now = Date.now();
    const entry = this.attempts.get(ip);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return;
    }

    entry.count += 1;
  }

  reset(ip) {
    this.attempts.delete(ip);
  }

  cleanupExpiredEntries() {
    const now = Date.now();

    for (const [ip, entry] of this.attempts.entries()) {
      if (now - entry.windowStart >= this.windowMs) {
        this.attempts.delete(ip);
      }
    }
  }
}

module.exports = { RateLimiter };
