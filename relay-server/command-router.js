class CommandRouter {
  constructor(pairingManager, options) {
    const config = options || {};
    this.pairingManager = pairingManager;
    this.timeoutMs = Number.isInteger(config.timeoutMs) ? config.timeoutMs : 30000;
    this.pendingCommands = new Map();
  }

  routeCommand(sessionToken, command) {
    return new Promise((resolve, reject) => {
      if (!this.pairingManager.validateSession(sessionToken)) {
        reject(this.createError('Invalid or disconnected session', 401));
        return;
      }

      const ws = this.pairingManager.getExtensionWs(sessionToken);
      if (!ws) {
        reject(this.createError('Extension connection not available', 401));
        return;
      }

      const timer = setTimeout(() => {
        this.pendingCommands.delete(command.id);
        reject(this.createError('Command timed out', 504));
      }, this.timeoutMs);

      this.pendingCommands.set(command.id, { resolve, reject, timer, ws });

      try {
        ws.send(JSON.stringify({
          type: 'command',
          id: command.id,
          action: command.action,
          params: command.params
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommands.delete(command.id);
        reject(this.createError(error.message || 'Failed to send command', 500));
      }
    });
  }

  handleExtensionResponse(ws, response) {
    const pending = this.pendingCommands.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingCommands.delete(response.id);

    if (response.success === false) {
      pending.reject(this.createError(response.error || 'Command failed', 500, response));
      return;
    }

    pending.resolve(response);
  }

  rejectPendingForSocket(ws, errorMessage) {
    for (const [commandId, pending] of this.pendingCommands.entries()) {
      if (pending.ws !== ws) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pendingCommands.delete(commandId);
      pending.reject(this.createError(errorMessage || 'Extension disconnected', 500));
    }
  }

  createError(message, statusCode, response) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (response) {
      error.response = response;
    }
    return error;
  }
}

module.exports = { CommandRouter };
