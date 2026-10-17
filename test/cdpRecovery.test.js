'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// Stub 'vscode' so extension modules load cleanly under node --test
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') {
        return {
            env: { language: 'en' },
            workspace: {
                workspaceFolders: [],
                getConfiguration: () => ({ get: (_k, d) => d })
            }
        };
    }
    return origLoad.call(this, request, ...rest);
};

const {
    parseDevToolsActivePort,
    getCandidateDirectories,
    getDevToolsActivePort
} = require('../src/cdp/devToolsActivePort');
const { ConnectionManager } = require('../src/cdp/ConnectionManager');

test('parseDevToolsActivePort parses standard 2-line DevToolsActivePort files', () => {
    const raw = '9558\r\n/devtools/browser/ea333616-3e8a-4de7-a951-a4cd87f58795\r\n';
    const res = parseDevToolsActivePort(raw);
    assert.deepStrictEqual(res, {
        port: 9558,
        wsPath: '/devtools/browser/ea333616-3e8a-4de7-a951-a4cd87f58795'
    });
});

test('parseDevToolsActivePort handles port-only files and whitespace', () => {
    const raw = '  9222  \n';
    const res = parseDevToolsActivePort(raw);
    assert.deepStrictEqual(res, {
        port: 9222,
        wsPath: null
    });
});

test('parseDevToolsActivePort rejects invalid ports, negative numbers, or non-numeric strings', () => {
    assert.strictEqual(parseDevToolsActivePort(''), null);
    assert.strictEqual(parseDevToolsActivePort('not_a_number\n/path'), null);
    assert.strictEqual(parseDevToolsActivePort('-10\n/path'), null);
    assert.strictEqual(parseDevToolsActivePort('0\n/path'), null);
    assert.strictEqual(parseDevToolsActivePort('70000\n/path'), null);
    assert.strictEqual(parseDevToolsActivePort(null), null);
});

test('getCandidateDirectories returns non-empty list of paths for current platform', () => {
    const dirs = getCandidateDirectories();
    assert.ok(Array.isArray(dirs));
    assert.ok(dirs.length >= 3);
    assert.ok(dirs.some(d => d.includes('Antigravity')));
});

test('getDevToolsActivePort reads and resolves port from temporary test directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cdp-test-'));
    try {
        const dummyFile = path.join(tempDir, 'DevToolsActivePort');
        fs.writeFileSync(dummyFile, '9558\n/devtools/browser/test-uuid-1234\n', 'utf8');

        const found = getDevToolsActivePort([tempDir]);
        assert.ok(found);
        assert.strictEqual(found.port, 9558);
        assert.strictEqual(found.wsPath, '/devtools/browser/test-uuid-1234');
        assert.strictEqual(found.filePath, dummyFile);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('ConnectionManager _findActivePort prioritizes DevToolsActivePort when configured port is unresponsive', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cm-test-'));
    const dummyFile = path.join(tempDir, 'DevToolsActivePort');
    fs.writeFileSync(dummyFile, '9558\n/devtools/browser/test-cm-uuid\n', 'utf8');

    try {
        const logs = [];
        const cm = new ConnectionManager({
            log: (msg) => logs.push(msg),
            getPort: () => 9559, // Configured port 9559 (simulating zombie/unresponsive port)
            getCustomTexts: () => [],
            getDevToolsDirs: () => [tempDir]
        });

        // Mock _pingPort: port 9559 fails, port 9558 succeeds
        cm._pingPort = async (p) => p === 9558;

        const activePort = await cm._findActivePort();

        assert.strictEqual(activePort, 9558);
        assert.strictEqual(cm.activeCdpPort, 9558);
        assert.strictEqual(cm.devToolsWsPath, '/devtools/browser/test-cm-uuid');
        assert.ok(logs.some(l => l.includes('✓ Discovered active port 9558 from DevToolsActivePort')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('ConnectionManager _getBrowserWsUrl falls back to devToolsWsPath if /json/version fails', async () => {
    const cm = new ConnectionManager({
        log: () => {},
        getPort: () => 9558,
        getCustomTexts: () => []
    });
    cm.devToolsWsPath = '/devtools/browser/fallback-uuid';

    // Mock http request failure by pointing to an unopen port
    const url = await cm._getBrowserWsUrl(59999);
    assert.strictEqual(url, 'ws://127.0.0.1:59999/devtools/browser/fallback-uuid');
});
