const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const WebSocket = require('ws');

const { RateLimiter } = require('./rate-limiter');
const { TOTPManager } = require('./totp-manager');
const { PairingManager } = require('./pairing-manager');
const { CommandRouter } = require('./command-router');

const WS_PORT = parsePort(process.env.PORT, 18793);
const HTTP_PORT = parsePort(process.env.HTTP_PORT, 18794);
const HOST = process.env.HOST || '0.0.0.0';
const HTTP_HOST = '127.0.0.1';

const rateLimiter = new RateLimiter({ maxAttempts: 5, windowMs: 600000 });
const totpManager = new TOTPManager();
const pairingManager = new PairingManager(totpManager);
const commandRouter = new CommandRouter(pairingManager, { timeoutMs: 30000 });

const wsServer = new WebSocket.Server({ host: HOST, port: WS_PORT });
const httpServer = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { success: true });
    return;
  }

  const requestUrl = new URL(req.url, `http://${HTTP_HOST}:${HTTP_PORT}`);
  const ip = getClientIp(req);

  try {
    if (req.method === 'POST' && requestUrl.pathname === '/api/connect') {
      await handleConnect(req, res, ip);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/totp/setup') {
      await handleTotpSetup(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/totp/reset') {
      await handleTotpReset(req, res);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/totp/status') {
      handleTotpStatus(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/command') {
      await handleCommand(req, res);
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
      handleStatus(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/disconnect') {
      handleDisconnect(req, res);
      return;
    }

    log('HTTP', `404 ${req.method} ${requestUrl.pathname}`);
    sendJson(res, 404, { success: false, error: 'Not found' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    log('HTTP', `${statusCode} ${req.method} ${requestUrl.pathname} - ${error.message}`);
    sendJson(res, statusCode, { success: false, error: error.message || 'Internal error' });
  }
});

wsServer.on('connection', (ws, req) => {
  log('WS', `Connection opened from ${getClientIp(req)}`);

  ws.on('message', (data) => {
    handleWsMessage(ws, data);
  });

  ws.on('close', () => {
    pairingManager.unregisterExtension(ws);
    commandRouter.rejectPendingForSocket(ws, 'Extension disconnected');
    log('WS', 'Connection closed');
  });

  ws.on('error', (error) => {
    log('WS', `Socket error: ${error.message}`);
  });
});

const heartbeatInterval = setInterval(() => {
  if (pairingManager.isSocketOpen(pairingManager.extensionWs)) {
    try {
      pairingManager.extensionWs.send(JSON.stringify({ type: 'ping' }));
    } catch (error) {
      log('WS', `Heartbeat failed: ${error.message}`);
    }
  }
}, 30000);

if (typeof heartbeatInterval.unref === 'function') {
  heartbeatInterval.unref();
}

wsServer.on('listening', () => {
  log('WS', `Server listening on ${HOST}:${WS_PORT}`);
});

wsServer.on('error', (error) => {
  log('WS', `Server error: ${error.message}`);
});

httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log('ChromeConnecter Relay Server');
  console.log(`WebSocket server listening on ${HOST}:${WS_PORT} (for Chrome extension)`);
  console.log(`HTTP API server listening on ${HTTP_HOST}:${HTTP_PORT} (for OpenClaw, localhost only)`);
});

httpServer.on('error', (error) => {
  log('HTTP', `Server error: ${error.message}`);
});

async function handleConnect(req, res, ip) {
  const rateCheck = rateLimiter.check(ip);
  if (!rateCheck.allowed) {
    sendJson(res, 429, {
      success: false,
      error: 'Too many attempts',
      retryAfter: rateCheck.retryAfter
    });
    return;
  }

  const body = await readJsonBody(req);
  if (!body || typeof body.totpCode !== 'string' || !/^\d{6}$/.test(body.totpCode.trim())) {
    throw createHttpError(400, 'Missing or invalid totpCode');
  }

  const result = pairingManager.verifyAndConnect(body.totpCode.trim(), body.sessionDurationMs);
  if (!result.success) {
    rateLimiter.recordFailure(ip);
    log('PAIR', `Pairing failed for ${ip}`);
    sendJson(res, 200, result);
    return;
  }

  rateLimiter.reset(ip);
  log('PAIR', `Pairing succeeded for ${ip}`);
  sendJson(res, 200, {
    success: true,
    sessionToken: result.sessionToken,
    sessionDurationMs: result.sessionDurationMs,
    sessionExpiresAt: Date.now() + result.sessionDurationMs
  });
}

async function handleTotpSetup(req, res) {
  assertLocalhostRequest(req);

  if (totpManager.isSetup()) {
    throw createHttpError(400, 'TOTP already configured. Reset first.');
  }

  const result = await totpManager.setup();
  sendJson(res, 200, result);
}

async function handleTotpReset(req, res) {
  assertLocalhostRequest(req);

  await totpManager.reset();
  pairingManager.invalidateAllSessions();
  sendJson(res, 200, { success: true });
}

function handleTotpStatus(req, res) {
  assertLocalhostRequest(req);

  sendJson(res, 200, {
    configured: totpManager.isSetup()
  });
}

async function handleCommand(req, res) {
  const sessionToken = extractBearerToken(req);
  if (!sessionToken) {
    throw createHttpError(401, 'Missing or invalid Authorization header');
  }

  const body = await readJsonBody(req);
  if (!body || typeof body.action !== 'string' || body.action.trim() === '') {
    throw createHttpError(400, 'Missing action');
  }

  const command = {
    id: generateCommandId(),
    action: body.action,
    params: body.params
  };

  log('CMD', `Routing command ${command.id} (${command.action})`);
  const result = await commandRouter.routeCommand(sessionToken, command);
  sendJson(res, 200, result);
}

function handleStatus(req, res) {
  const sessionToken = extractBearerToken(req);
  if (!sessionToken) {
    throw createHttpError(401, 'Missing or invalid Authorization header');
  }

  const connected = pairingManager.validateSession(sessionToken);
  sendJson(res, 200, {
    connected,
    stats: pairingManager.getStats()
  });
}

function handleDisconnect(req, res) {
  const sessionToken = extractBearerToken(req);
  if (!sessionToken) {
    throw createHttpError(401, 'Missing or invalid Authorization header');
  }

  if (!pairingManager.sessions.has(sessionToken)) {
    throw createHttpError(401, 'Invalid session token');
  }

  pairingManager.invalidateSession(sessionToken);
  sendJson(res, 200, { success: true });
}

function handleWsMessage(ws, data) {
  let message;

  try {
    message = JSON.parse(data.toString());
  } catch (error) {
    log('WS', 'Received invalid JSON message');
    return;
  }

  if (!message || typeof message.type !== 'string') {
    log('WS', 'Received message without type');
    return;
  }

  switch (message.type) {
    case 'register':
      if (typeof message.extensionId !== 'string' || message.extensionId.trim() === '') {
        log('WS', 'Register message missing extensionId');
        return;
      }
      pairingManager.registerExtension(message.extensionId.trim(), ws);
      log('PAIR', `Extension registered with extensionId ${message.extensionId.trim()}`);
      break;
    case 'getTotpSetup':
      handleWsTotpSetup(ws);
      break;
    case 'verifyTotp':
      handleWsVerifyTotp(ws, message);
      break;
    case 'resetTotp':
      handleWsResetTotp(ws);
      break;
    case 'pong':
      updateLastActivity(ws);
      break;
    case 'response':
      updateLastActivity(ws);
      commandRouter.handleExtensionResponse(ws, message);
      break;
    case 'unregister':
      pairingManager.unregisterExtension(ws);
      log('PAIR', 'Extension unregistered');
      break;
    default:
      log('WS', `Unhandled message type: ${message.type}`);
      break;
  }
}

async function handleWsTotpSetup(ws) {
  try {
    if (totpManager.isSetup()) {
      const secret = totpManager.getSecret();
      const { Secret } = require('otpauth');
      const QRCode = require('qrcode');
      const totp = totpManager.createTotp(Secret.fromBase32(secret));
      const uri = totp.toString();
      const qrDataUrl = await QRCode.toDataURL(uri);
      wsSend(ws, {
        type: 'totpSetup',
        isSetup: true,
        qrCodeDataUrl: qrDataUrl,
        otpauthUri: uri
      });
    } else {
      const result = await totpManager.setup();
      wsSend(ws, {
        type: 'totpSetup',
        isSetup: false,
        qrCodeDataUrl: result.qrDataUrl,
        otpauthUri: result.uri
      });
    }
  } catch (error) {
    log('TOTP', `Setup via WS failed: ${error.message}`);
    wsSend(ws, { type: 'totpSetup', isSetup: false, qrCodeDataUrl: '', otpauthUri: '' });
  }
}

function handleWsVerifyTotp(ws, message) {
  const code = typeof message.code === 'string' ? message.code.trim() : '';

  if (!/^\d{6}$/.test(code)) {
    wsSend(ws, { type: 'totpVerified', success: false, error: 'Invalid code format' });
    return;
  }

  const sessionDurationMs = typeof message.sessionDurationMs === 'number' && message.sessionDurationMs > 0
    ? message.sessionDurationMs
    : undefined;

  const result = pairingManager.verifyAndConnect(code, sessionDurationMs);
  wsSend(ws, {
    type: 'totpVerified',
    success: result.success,
    sessionToken: result.sessionToken,
    sessionExpiresAt: result.success ? Date.now() + result.sessionDurationMs : undefined,
    sessionDurationMs: result.success ? result.sessionDurationMs : undefined,
    error: result.error
  });

  if (result.success) {
    log('TOTP', 'Extension verified via WS');
  }
}

async function handleWsResetTotp(ws) {
  try {
    await totpManager.reset();
    pairingManager.invalidateAllSessions();
    const result = await totpManager.setup();
    wsSend(ws, {
      type: 'totpReset',
      success: true,
      qrCodeDataUrl: result.qrDataUrl,
      otpauthUri: result.uri
    });
    log('TOTP', 'TOTP reset and re-setup via WS');
  } catch (error) {
    log('TOTP', `Reset via WS failed: ${error.message}`);
    wsSend(ws, { type: 'totpReset', success: false, error: error.message });
  }
}

function wsSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function updateLastActivity(ws) {
  if (pairingManager.extensionWs === ws && pairingManager.isSocketOpen(ws)) {
    for (const session of pairingManager.sessions.values()) {
      session.lastActivity = Date.now();
    }
  }
}

function assertLocalhostRequest(req) {
  const clientIp = getClientIp(req);
  const normalizedIp = typeof clientIp === 'string' ? clientIp.trim() : '';

  if (normalizedIp !== '127.0.0.1' && normalizedIp !== '::1' && normalizedIp !== '::ffff:127.0.0.1') {
    throw createHttpError(403, 'Forbidden');
  }
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function generateCommandId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(16).toString('hex');
}

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }

  const token = header.slice('Bearer '.length).trim();
  return token || null;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }

  return req.socket.remoteAddress || 'unknown';
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(createHttpError(400, 'Invalid JSON body'));
      }
    });

    req.on('error', (error) => {
      reject(createHttpError(500, error.message || 'Request read error'));
    });
  });
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function log(category, message) {
  console.log(`${new Date().toISOString()} [${category}] ${message}`);
}
