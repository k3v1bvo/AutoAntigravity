// AutoAntigravity — CDP Connection Manager
// Persistent browser-level WebSocket connection with session pooling.
// Uses a minimal built-in WebSocket client (no external dependencies).

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { buildDOMObserverScript } = require('../scripts/DOMObserver');
const devToolsActivePort = require('./devToolsActivePort');

// ─── Minimal WebSocket Client (Node.js built-in only) ──────────────────
class MiniWebSocket extends EventEmitter {
    constructor(url) {
        super();
        this.readyState = 0; // CONNECTING
        this._fragments = [];

        const parsed = new URL(url);
        const key = crypto.randomBytes(16).toString('base64');
        const port = parsed.port || 80;

        const net = require('net');
        this._socket = net.createConnection({ host: parsed.hostname, port }, () => {
            const path = parsed.pathname + parsed.search;
            const req = [
                `GET ${path} HTTP/1.1`,
                `Host: ${parsed.hostname}:${port}`,
                `Upgrade: websocket`,
                `Connection: Upgrade`,
                `Sec-WebSocket-Key: ${key}`,
                `Sec-WebSocket-Version: 13`,
                '',
                ''
            ].join('\r\n');
            this._socket.write(req);
        });

        this._upgraded = false;
        this._buffer = Buffer.alloc(0);

        this._socket.on('data', (data) => {
            if (!this._upgraded) {
                this._buffer = Buffer.concat([this._buffer, data]);
                const headerEnd = this._buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) return;

                const header = this._buffer.slice(0, headerEnd).toString();
                if (!header.includes('101')) {
                    this.readyState = 3;
                    this.emit('error', new Error('WebSocket upgrade failed'));
                    this._socket.destroy();
                    return;
                }

                this._upgraded = true;
                this.readyState = 1; // OPEN
                this.emit('open');

                const remaining = this._buffer.slice(headerEnd + 4);
                this._buffer = Buffer.alloc(0);
                if (remaining.length > 0) {
                    this._processData(remaining);
                }
            } else {
                this._processData(data);
            }
        });

        this._socket.on('close', () => {
            if (this.readyState !== 3) {
                this.readyState = 3; // CLOSED
                this.emit('close');
            }
        });

        this._socket.on('error', (err) => {
            this.emit('error', err);
        });
    }

    _processData(data) {
        this._buffer = Buffer.concat([this._buffer, data]);

        while (this._buffer.length >= 2) {
            const firstByte = this._buffer[0];
            const secondByte = this._buffer[1];
            const fin = (firstByte & 0x80) !== 0;
            const opcode = firstByte & 0x0f;
            const masked = (secondByte & 0x80) !== 0;
            let payloadLen = secondByte & 0x7f;
            let offset = 2;

            if (payloadLen === 126) {
                if (this._buffer.length < 4) return;
                payloadLen = this._buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (this._buffer.length < 10) return;
                payloadLen = Number(this._buffer.readBigUInt64BE(2));
                offset = 10;
            }

            if (masked) offset += 4;

            if (this._buffer.length < offset + payloadLen) return;

            let payload = this._buffer.slice(offset, offset + payloadLen);

            if (masked) {
                const mask = this._buffer.slice(offset - 4, offset);
                for (let i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i & 3];
                }
            }

            this._buffer = this._buffer.slice(offset + payloadLen);

            // Handle opcodes
            if (opcode === 0x8) {
                // Close frame
                this.close();
                return;
            } else if (opcode === 0x9) {
                // Ping → Pong
                this._sendFrame(0xa, payload);
            } else if (opcode === 0xa) {
                // Pong — ignore
            } else if (opcode === 0x0) {
                // Continuation
                this._fragments.push(payload);
                if (fin) {
                    const full = Buffer.concat(this._fragments);
                    this._fragments = [];
                    this.emit('message', full);
                }
            } else if (opcode === 0x1 || opcode === 0x2) {
                // Text or Binary
                if (fin) {
                    this.emit('message', payload);
                } else {
                    this._fragments = [payload];
                }
            }
        }
    }

    send(data) {
        if (this.readyState !== 1) return;
        const payload = Buffer.from(data, 'utf-8');
        this._sendFrame(0x1, payload, true);
    }

    _sendFrame(opcode, payload, mask = true) {
        if (!this._socket || this._socket.destroyed) return;

        const fin = 0x80;
        const firstByte = fin | opcode;
        const maskBit = mask ? 0x80 : 0x00;
        let header;

        if (payload.length < 126) {
            header = Buffer.alloc(2);
            header[0] = firstByte;
            header[1] = maskBit | payload.length;
        } else if (payload.length < 65536) {
            header = Buffer.alloc(4);
            header[0] = firstByte;
            header[1] = maskBit | 126;
            header.writeUInt16BE(payload.length, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = firstByte;
            header[1] = maskBit | 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
        }

        if (mask) {
            const maskKey = crypto.randomBytes(4);
            const masked = Buffer.alloc(payload.length);
            for (let i = 0; i < payload.length; i++) {
                masked[i] = payload[i] ^ maskKey[i & 3];
            }
            this._socket.write(Buffer.concat([header, maskKey, masked]));
        } else {
            this._socket.write(Buffer.concat([header, payload]));
        }
    }

    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        try {
            this._sendFrame(0x8, Buffer.alloc(0), true);
            this._socket.end();
        } catch (e) { }
        this.emit('close');
    }
}

// WebSocket readyState constants
MiniWebSocket.OPEN = 1;

// ─── Connection Manager ────────────────────────────────────────────────

class ConnectionManager {
    /**
     * @param {Object} options
     * @param {Function} options.log - Logging function
     * @param {Function} options.getPort - Returns configured CDP port
     * @param {Function} options.getCustomTexts - Returns custom button texts array
     */
    constructor({ log, getPort, getCustomTexts, getDevToolsDirs = null }) {
        this.log = log;
        this.getPort = getPort;
        this.getCustomTexts = getCustomTexts;
        this.getDevToolsDirs = getDevToolsDirs;

        this.ws = null;
        this.msgId = 0;
        this.pending = new Map();
        this.sessions = new Map();
        this.ignoredTargets = new Set();
        this.activeCdpPort = null;
        this.devToolsWsPath = null;

        this.isRunning = false;
        this.isConnecting = false;
        this.reconnectTimer = null;
        this.heartbeatTimer = null;
        this.activeScanTimer = null;

        // Performance: only run active scanning when AutoAccept is enabled
        this.autoAcceptActive = false;
        // Reconnect backoff
        this._reconnectAttempts = 0;
    }

    // ─── Public API ───────────────────────────────────────────────────

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.log('[CDP] Connection manager starting');
        this.connect();
    }

    stop() {
        this.isRunning = false;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        clearInterval(this.activeScanTimer);
        this.activeScanTimer = null;
        // Cleanup injected DOMObserver scripts before closing connection
        this._cleanupAllSessions();
        this._closeWebSocket();
        this.sessions.clear();
        this.ignoredTargets.clear();
        this._clearPending();
        this.log('[CDP] Connection manager stopped');
    }

    getSessionCount() {
        return this.sessions.size;
    }

    getActivePort() {
        return this.activeCdpPort;
    }

    /** Pause active scanning and heartbeat (when AutoAccept is OFF) */
    pauseActiveScanning() {
        this.autoAcceptActive = false;
        clearInterval(this.activeScanTimer);
        this.activeScanTimer = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        // Cleanup injected DOMObserver scripts in all sessions
        this._cleanupAllSessions();
    }

    /** Resume active scanning and heartbeat (when AutoAccept is ON) */
    resumeActiveScanning() {
        this.autoAcceptActive = true;
        if (this.ws && this.ws.readyState === MiniWebSocket.OPEN) {
            if (!this.heartbeatTimer) {
                this.heartbeatTimer = setInterval(() => this._heartbeat(), 30000);
            }
            if (!this.activeScanTimer) {
                this.activeScanTimer = setInterval(() => this._activeScanAll(), 5000);
            }
        }
    }

    // ─── Connection Lifecycle ─────────────────────────────────────────

    async connect() {
        if (!this.isRunning || this.isConnecting) return;
        if (this.ws && this.ws.readyState === MiniWebSocket.OPEN) return;
        this.isConnecting = true;

        try {
            const port = await this._findActivePort();
            if (!port) {
                this._scheduleReconnect();
                return;
            }

            const wsUrl = await this._getBrowserWsUrl(port);
            if (!wsUrl) {
                this._scheduleReconnect();
                return;
            }

            await this._establishConnection(wsUrl);
        } catch (e) {
            this.log(`[CDP] Connection error: ${e.message}`);
            this._scheduleReconnect();
        } finally {
            this.isConnecting = false;
        }
    }

    _establishConnection(wsUrl) {
        return new Promise((resolve, reject) => {
            const ws = new MiniWebSocket(wsUrl);
            const timeout = setTimeout(() => {
                try { ws.close(); } catch (e) { }
                reject(new Error('Connection timeout'));
            }, 10000);

            ws.on('open', async () => {
                clearTimeout(timeout);
                this.ws = ws;
                this.log('[CDP] Persistent connection established');

                try {
                    await this._initializeTargetDiscovery();
                    this._reconnectAttempts = 0; // Reset backoff on successful connection
                    // Only start active scanning if AutoAccept is enabled
                    if (this.autoAcceptActive) {
                        this.heartbeatTimer = setInterval(() => this._heartbeat(), 30000);
                        this.activeScanTimer = setInterval(() => this._activeScanAll(), 5000);
                    }
                    resolve();
                } catch (e) {
                    this.log(`[CDP] Initialization error: ${e.message}`);
                    ws.close();
                    reject(e);
                }
            });

            ws.on('message', (raw) => this._onMessage(raw));
            ws.on('close', () => {
                clearTimeout(timeout);
                this._onClose();
            });
            ws.on('error', () => { });
        });
    }

    // ─── Message Handling ─────────────────────────────────────────────

    _onMessage(raw) {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg.id && this.pending.has(msg.id)) {
                const handler = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(handler.timer);
                handler.resolve(msg);
                return;
            }

            switch (msg.method) {
                case 'Target.targetCreated':
                    this._handleNewTarget(msg.params.targetInfo);
                    break;
                case 'Target.targetDestroyed':
                    this._handleTargetDestroyed(msg.params.targetId);
                    break;
                case 'Target.detachedFromTarget':
                    this._handleSessionDetached(msg.params?.sessionId);
                    break;
                case 'Runtime.executionContextsCleared':
                    if (msg.sessionId) this._reinjectForSession(msg.sessionId);
                    break;
                case 'Runtime.consoleAPICalled':
                    this._handleConsoleMessage(msg.params);
                    break;
            }
        } catch (e) { }
    }

    _onClose() {
        this.log('[CDP] Connection closed');
        this.ws = null;
        this.sessions.clear();
        this.ignoredTargets.clear();
        this._clearPending();
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        clearInterval(this.activeScanTimer);
        this.activeScanTimer = null;

        if (this.isRunning) {
            this._scheduleReconnect();
        }
    }

    // ─── Target Discovery & Session Management ────────────────────────

    async _initializeTargetDiscovery() {
        await this._send('Target.setDiscoverTargets', { discover: true });

        const msg = await this._send('Target.getTargets');
        const targets = msg.result?.targetInfos || [];
        this.log(`[CDP] Found ${targets.length} targets`);

        const candidates = targets.filter(t => this._isCandidate(t));
        await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));

        this.log(`[CDP] ${this.sessions.size} sessions active after initial scan`);
    }

    _isCandidate(targetInfo) {
        const { url, type, title } = targetInfo;
        if (!url) return false;
        
        const lowerUrl = url.toLowerCase();
        const lowerTitle = (title || '').toLowerCase();

        // Include anything that looks like an Antigravity agent or a VS Code webview
        if (lowerUrl.includes('agent') || lowerUrl.includes('jetski') || lowerTitle.includes('agent') || lowerTitle.includes('antigravity')) return true;
        
        // Exclude generic editor/workbench shells that definitely aren't agents (e.g. settings)
        if (url.startsWith('file://') && !url.includes('workbench.html')) return false;
        if (url.includes('/editor/')) return false;
        
        return url.includes('vscode-webview://') ||
            url.includes('webview') ||
            type === 'iframe' ||
            type === 'page'; // page is usually the workbench or launcher
    }

    async _handleNewTarget(targetInfo) {
        const { targetId, type, url } = targetInfo;
        if (!this._isCandidate(targetInfo)) return;
        if (this.sessions.has(targetId)) return;
        if (this.ignoredTargets.has(targetId)) return;

        const shortId = targetId.substring(0, 6);

        try {
            const attachMsg = await this._send('Target.attachToTarget', { targetId, flatten: true });
            const sessionId = attachMsg.result?.sessionId;
            if (!sessionId) return;

            await this._send('Runtime.enable', {}, sessionId).catch(() => { });

            if (type === 'page') {
                const domCheck = await this._send('Runtime.evaluate', {
                    expression: 'typeof document !== "undefined" ? document.title || "has-dom" : "no-dom"'
                }, sessionId);
                const domResult = domCheck.result?.result?.value;
                if (!domResult || domResult === 'no-dom') {
                    await this._send('Target.detachFromTarget', { sessionId }).catch(() => { });
                    this.ignoredTargets.add(targetId);
                    return;
                }
            }

            const result = await this._injectObserver(sessionId);

            if (result === 'not-agent-panel' || result === 'not-a-browser-window' || result === 'not-a-browser-window') {
                await this._send('Target.detachFromTarget', { sessionId }).catch(() => { });
                this.ignoredTargets.add(targetId);
                return;
            }

            this.sessions.set(targetId, sessionId);
            this.log(`[CDP] ✓ Attached [${shortId}] → ${result} (${(url || '').substring(0, 50)})`);
        } catch (e) { }
    }

    _handleTargetDestroyed(targetId) {
        if (this.sessions.has(targetId)) {
            this.sessions.delete(targetId);
            this.log(`[CDP] Target destroyed [${targetId.substring(0, 6)}]`);
        }
        this.ignoredTargets.delete(targetId);
    }

    _handleSessionDetached(sessionId) {
        if (!sessionId) return;
        for (const [tid, sid] of this.sessions) {
            if (sid === sessionId) {
                this.sessions.delete(tid);
                this.log(`[CDP] Session detached [${tid.substring(0, 6)}]`);
                break;
            }
        }
    }

    _handleConsoleMessage(params) {
        if (!params || !params.args) return;
        // Only log our own dense messages (prefix with [AA_LOG]) to avoid spamming user with all page logs
        const prefixFlag = '[AA_LOG]';
        let firstArg = params.args[0]?.value;
        if (typeof firstArg === 'string' && firstArg.includes(prefixFlag)) {
            const texts = params.args.map(a => a.value || JSON.stringify(a.value)).join(' ');
            this.log(`[CDP Debug] ${texts}`);
            if (this.onActionAccepted) {
                try { this.onActionAccepted(texts.replace(prefixFlag, '').trim()); } catch(e) {}
            }
        }
    }

    // ─── Observer Injection ───────────────────────────────────────────

    async _injectObserver(sessionId) {
        const script = buildDOMObserverScript(this.getCustomTexts());
        const evalMsg = await this._send('Runtime.evaluate', { expression: script }, sessionId);
        return evalMsg.result?.result?.value || 'undefined';
    }

    async _reinjectForSession(sessionId) {
        let targetId = null;
        for (const [tid, sid] of this.sessions) {
            if (sid === sessionId) { targetId = tid; break; }
        }
        if (!targetId) return;

        const shortId = targetId.substring(0, 6);

        try {
            await new Promise(r => setTimeout(r, 500));
            const result = await this._injectObserver(sessionId);
            if (result && result !== 'not-agent-panel') {
                this.log(`[CDP] ✓ Re-injected [${shortId}] → ${result}`);
            }
        } catch (e) { }
    }

    /**
     * Active scan: force scanAndClick() on all attached sessions via CDP.
     * This is the key fix for inactive tab throttling — instead of relying
     * on the injected script's own timers (which get throttled), we actively
     * push a scan command from the extension host (Node.js, never throttled).
     */
    async _activeScanAll() {
        if (!this.ws || this.ws.readyState !== MiniWebSocket.OPEN) return;
        if (this.sessions.size === 0) return;

        for (const [targetId, sessionId] of this.sessions) {
            try {
                this._send('Runtime.evaluate', {
                    expression: 'typeof window.__AA_FORCE_SCAN === "function" ? window.__AA_FORCE_SCAN() : null'
                }, sessionId).catch(() => {});
            } catch (e) { /* silent */ }
        }
    }

    /**
     * Cleanup injected DOMObserver scripts in all attached sessions.
     * Called when AutoAccept is paused/stopped to free CPU resources.
     */
    _cleanupAllSessions() {
        if (!this.ws || this.ws.readyState !== MiniWebSocket.OPEN) return;
        if (this.sessions.size === 0) return;

        this.log(`[CDP] Cleaning up ${this.sessions.size} session(s)...`);
        for (const [targetId, sessionId] of this.sessions) {
            try {
                this._send('Runtime.evaluate', {
                    expression: 'typeof window.__AA_CLEANUP === "function" ? window.__AA_CLEANUP() : "no-cleanup"'
                }, sessionId).catch(() => {});
            } catch (e) { /* silent */ }
        }
    }

    // ─── CDP Protocol Transport ───────────────────────────────────────

    _send(method, params = {}, sessionId = null) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== MiniWebSocket.OPEN) {
                reject(new Error('not connected'));
                return;
            }
            const id = ++this.msgId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout: ${method}`));
            }, 5000);
            this.pending.set(id, { resolve, reject, timer });
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            this.ws.send(JSON.stringify(payload));
        });
    }

    // ─── Health & Reconnection ────────────────────────────────────────

    _scheduleReconnect() {
        if (this.reconnectTimer || !this.isRunning) return;
        // Exponential backoff: 3s, 10s, 30s, 60s max
        const delays = [3000, 10000, 30000, 60000];
        const delay = delays[Math.min(this._reconnectAttempts, delays.length - 1)];
        this._reconnectAttempts++;
        this.log(`[CDP] Reconnecting in ${delay / 1000}s... (attempt ${this._reconnectAttempts})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.isRunning) this.connect();
        }, delay);
    }

    async _heartbeat() {
        try {
            const msg = await this._send('Target.getTargets');
            const targets = msg.result?.targetInfos || [];
            this.log(`[CDP] Heartbeat: ${targets.length} targets, ${this.sessions.size} sessions`);

            const candidates = targets.filter(t =>
                this._isCandidate(t) &&
                !this.sessions.has(t.targetId) &&
                !this.ignoredTargets.has(t.targetId)
            );
            if (candidates.length > 0) {
                this.log(`[CDP] ${candidates.length} new targets found, attaching...`);
                await Promise.allSettled(candidates.map(t => this._handleNewTarget(t)));
            }
        } catch (e) { }
    }

    // ─── Port Discovery ───────────────────────────────────────────────

    _pingPort(port) {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                res.on('data', () => { });
                res.on('end', () => resolve(true));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    _getBrowserWsUrl(port) {
        return new Promise((resolve, reject) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const info = JSON.parse(data);
                        resolve(info.webSocketDebuggerUrl || null);
                    } catch (e) {
                        if (this.devToolsWsPath) {
                            resolve(`ws://127.0.0.1:${port}${this.devToolsWsPath}`);
                        } else {
                            reject(e);
                        }
                    }
                });
            });
            req.on('error', (err) => {
                if (this.devToolsWsPath) {
                    resolve(`ws://127.0.0.1:${port}${this.devToolsWsPath}`);
                } else {
                    reject(err);
                }
            });
            req.on('timeout', () => {
                req.destroy();
                if (this.devToolsWsPath) {
                    resolve(`ws://127.0.0.1:${port}${this.devToolsWsPath}`);
                } else {
                    reject(new Error('timeout'));
                }
            });
        });
    }

    async _findActivePort() {
        if (this.activeCdpPort && await this._pingPort(this.activeCdpPort)) {
            return this.activeCdpPort;
        }

        // 1. Try reading DevToolsActivePort generated dynamically by Chromium/Electron.
        // This recovers situations where port 9559 is held in a ghost/zombie LISTEN state
        // and Electron picked an alternative ephemeral port (e.g. 9558).
        const searchDirs = typeof this.getDevToolsDirs === 'function' ? this.getDevToolsDirs() : null;
        const devToolsInfo = devToolsActivePort.getDevToolsActivePort(searchDirs);
        if (devToolsInfo && await this._pingPort(devToolsInfo.port)) {
            this.log(`[CDP] ✓ Discovered active port ${devToolsInfo.port} from DevToolsActivePort (${devToolsInfo.filePath})`);
            this.activeCdpPort = devToolsInfo.port;
            this.devToolsWsPath = devToolsInfo.wsPath;
            return devToolsInfo.port;
        }

        const configPort = this.getPort();
        if (await this._pingPort(configPort)) {
            this.activeCdpPort = configPort;
            return configPort;
        }

        // Electron sometimes opens the debug port on a different port than requested.
        // Scan a small range around the configured port to find the actual CDP endpoint.
        const scanRange = 20;
        const startPort = Math.max(1024, configPort - scanRange);
        const endPort = Math.min(65535, configPort + scanRange);
        const batchSize = 10;

        for (let base = startPort; base <= endPort; base += batchSize) {
            const ports = [];
            for (let p = base; p < Math.min(base + batchSize, endPort + 1); p++) {
                if (p === configPort) continue; // Already tried
                ports.push(p);
            }
            const results = await Promise.all(
                ports.map(async (p) => ({ port: p, ok: await this._pingPort(p) }))
            );
            const found = results.find(r => r.ok);
            if (found) {
                this.log(`[CDP] ✓ Discovered CDP on port ${found.port} (configured: ${configPort})`);
                this.activeCdpPort = found.port;
                return found.port;
            }
        }

        return null;
    }

    // ─── Cleanup Helpers ──────────────────────────────────────────────

    _closeWebSocket() {
        if (this.ws) {
            try { this.ws.close(); } catch (e) { }
            this.ws = null;
        }
    }

    _clearPending() {
        for (const [id, handler] of this.pending) {
            clearTimeout(handler.timer);
        }
        this.pending.clear();
    }
}

module.exports = { ConnectionManager };
