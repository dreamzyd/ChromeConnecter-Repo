const { TOTP, Secret } = require('otpauth');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class TOTPManager {
  constructor(options) {
    const config = options || {};
    this.secretFilePath = config.secretFilePath || path.join(__dirname, '.totp-secret.json');
    this.secret = null;

    this.loadSecret();
  }

  loadSecret() {
    try {
      if (!fs.existsSync(this.secretFilePath)) {
        return;
      }

      const fileContent = fs.readFileSync(this.secretFilePath, 'utf8');
      const parsed = JSON.parse(fileContent);

      if (parsed && typeof parsed.secret === 'string' && parsed.secret.trim() !== '') {
        this.secret = parsed.secret.trim();
      }
    } catch (error) {
      this.secret = null;
    }
  }

  isSetup() {
    return this.secret !== null;
  }

  async setup() {
    const secret = new Secret({ size: 20 });
    const base32Secret = secret.base32;
    const totp = this.createTotp(secret);
    const payload = {
      secret: base32Secret,
      createdAt: new Date().toISOString()
    };

    await fs.promises.writeFile(this.secretFilePath, JSON.stringify(payload, null, 2), 'utf8');

    try {
      await fs.promises.chmod(this.secretFilePath, 0o600);
    } catch (error) {
      // Ignore chmod issues on platforms that do not support POSIX modes.
    }

    this.secret = base32Secret;

    return {
      secret: base32Secret,
      uri: totp.toString(),
      qrDataUrl: await QRCode.toDataURL(totp.toString())
    };
  }

  verify(token) {
    if (!this.secret || typeof token !== 'string') {
      return false;
    }

    const sanitizedToken = token.trim();
    if (!/^\d{6}$/.test(sanitizedToken)) {
      return false;
    }

    return TOTP.validate({
      token: sanitizedToken,
      secret: Secret.fromBase32(this.secret),
      issuer: 'ChromeConnector',
      label: 'ChromeConnector',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      window: 10
    }) !== null;
  }

  async reset() {
    this.secret = null;

    try {
      await fs.promises.unlink(this.secretFilePath);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }

    return { success: true };
  }

  getSecret() {
    return this.secret;
  }

  createTotp(secret) {
    return new TOTP({
      issuer: 'ChromeConnector',
      label: 'ChromeConnector',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret
    });
  }
}

module.exports = { TOTPManager };
