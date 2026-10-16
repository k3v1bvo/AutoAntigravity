'use strict';
// Regression tests for the Telegram control path. Run: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// The extension modules import 'vscode'; stub it so they load under plain node.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') {
        return { env: { language: 'en' }, workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d }) } };
    }
    return origLoad.call(this, request, ...rest);
};

const { TelegramService } = require('../src/telegram/TelegramService');
const { resolveModelAlias, createModelHandler } = require('../src/telegram/modelCommand');
const { loadTelegramCredentials } = require('../src/telegram/loadCredentials');

function makeService() {
    const svc = new TelegramService(() => {});
    svc._botToken = 'token';
    svc._chatId = '123';
    svc.sent = [];
    svc.sendMessage = async (m) => { svc.sent.push(m); };
    svc.calls = [];
    for (const h of ['onHelpRequest', 'onStatusRequest', 'onSummaryRequest', 'onStartRequest', 'onStopRequest', 'onAutoAcceptRequest', 'onConfigRequest', 'onQueueRequest']) {
        svc[h] = () => svc.calls.push([h]);
    }
    for (const h of ['onModelRequest', 'onPrdRequest', 'onTaskRequest', 'onChatRequest']) {
        svc[h] = (a) => svc.calls.push([h, a]);
    }
    svc.onWorkflowRequest = (n, a) => svc.calls.push(['onWorkflowRequest', n, a]);
    svc.onMediaReceived = (c, f) => svc.calls.push(['onMediaReceived', c, f.length]);
    return svc;
}
const msg = (text, chatId = 123) => ({ chat: { id: chatId }, text });

test('messages from any chat other than the configured one are dropped', () => {
    const s = makeService();
    s._handleMessage(msg('/status', 999));
    s._handleMessage({ chat: { id: 999 }, photo: [{ file_id: 'f' }] });
    s._handleMessage(msg('hello', 999));
    s._handleMessage({ text: '/status' });
    assert.deepStrictEqual(s.calls, []);
    assert.deepStrictEqual(s.sent, []);
});

test('configured chat is dispatched (commands, aliases, media, plain chat)', () => {
    const s = makeService();
    s._handleMessage(msg('/status'));
    s._handleMessage(msg('/cuota'));
    s._handleMessage(msg('/resumen'));
    s._handleMessage({ chat: { id: '123' }, photo: [{ file_id: 'f' }], caption: 'cap' });
    s._handleMessage(msg('hello there'));
    assert.deepStrictEqual(s.calls, [
        ['onStatusRequest'], ['onStatusRequest'], ['onSummaryRequest'],
        ['onMediaReceived', 'cap', 1], ['onChatRequest', 'hello there'],
    ]);
});

test('bot mention is stripped from the command token only; arguments stay verbatim', () => {
    const s = makeService();
    s._handleMessage(msg('/task@my_bot email foo@bar.com about @scope/pkg'));
    s._handleMessage(msg('/prd@my_bot  spaced   args '));
    assert.deepStrictEqual(s.calls, [
        ['onTaskRequest', 'email foo@bar.com about @scope/pkg'],
        ['onPrdRequest', 'spaced   args'],
    ]);
});

test('/model matches the exact token; /models and unknown slashes are rejected', () => {
    const s = makeService();
    s._handleMessage(msg('/model@bot opus'));
    s._handleMessage(msg('/MODEL'));
    s._handleMessage(msg('/models'));
    s._handleMessage(msg('/nope arg'));
    assert.deepStrictEqual(s.calls, [['onModelRequest', 'opus'], ['onModelRequest', '']]);
    assert.strictEqual(s.sent.length, 2);
    assert.ok(s.sent[0].includes('/models'));
    assert.ok(s.sent[1].includes('/nope'));
});

test('workflows dispatch by normalized or file name; the IDE gets the file name', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-wf-'));
    fs.mkdirSync(path.join(ws, '.agent', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agent', 'workflows', 'review-code.md'), '---\ndescription: Review\n---\n');
    const s = makeService();
    s._workspaceRoot = ws;
    s._handleMessage(msg('/review_code src/a.js'));
    s._handleMessage(msg('/review-code@bot src/b.js'));
    s._handleMessage(msg('/review'));
    assert.deepStrictEqual(s.calls, [
        ['onWorkflowRequest', 'review-code', 'src/a.js'],
        ['onWorkflowRequest', 'review-code', 'src/b.js'],
    ]);
    assert.strictEqual(s.sent.length, 1);
});

test('model aliases resolve to menu keywords; unknown values are rejected', () => {
    assert.strictEqual(resolveModelAlias('Sonnet'), 'sonnet');
    assert.strictEqual(resolveModelAlias(' gemini   PRO '), 'gemini pro');
    assert.strictEqual(resolveModelAlias('flash'), 'flash');
    assert.strictEqual(resolveModelAlias('gpt-9'), null);
    assert.strictEqual(resolveModelAlias('click here'), null);
    assert.strictEqual(resolveModelAlias(''), null);
});

function fakeLoop({ busy = false, after = 'Claude Opus 4.6', clicked = true } = {}) {
    const loop = {
        flags: [], switched: [], current: 'Claude Sonnet 4.6',
        isBusy() { return busy || loop.flags[loop.flags.length - 1] === true; },
        setStandaloneRunning(v) { loop.flags.push(v); },
        async _getCurrentModel() { return loop.current; },
        async _switchModel(k) { loop.switched.push(k); loop.current = after; return clicked; },
    };
    return loop;
}

test('/model handler: invalid alias and busy loop never touch the UI', async () => {
    const sent = [];
    const loop = fakeLoop({ busy: true });
    const handler = createModelHandler({ ralphLoop: loop, send: async (m) => sent.push(m) });
    await handler('bogus');
    await handler('opus');
    assert.deepStrictEqual(loop.switched, []);
    assert.deepStrictEqual(loop.flags, []);
    assert.strictEqual(sent.length, 2);
});

test('/model handler: switch is serialized via the standalone flag and verified against the selector', async () => {
    const sent = [];
    const loop = fakeLoop();
    const handler = createModelHandler({ ralphLoop: loop, send: async (m) => sent.push(m) });
    await handler('opus');
    assert.deepStrictEqual(loop.switched, ['opus']);
    assert.deepStrictEqual(loop.flags, [true, false]);
    assert.ok(sent[sent.length - 1].includes('Claude Opus 4.6'));

    // Click landed somewhere else: selector still shows the old model -> reported as failure
    const sent2 = [];
    const loop2 = fakeLoop({ after: 'Claude Sonnet 4.6' });
    await createModelHandler({ ralphLoop: loop2, send: async (m) => sent2.push(m) })('opus');
    assert.ok(sent2[sent2.length - 1].includes('❌'));
    assert.deepStrictEqual(loop2.flags, [true, false]);
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tg-')); }
function writeEnv(dir, name, token, chat) {
    fs.writeFileSync(path.join(dir, name), (token ? `TELEGRAM_BOT_TOKEN=${token}\n` : '') + (chat ? `TELEGRAM_CHAT_ID=${chat}\n` : ''));
}

test('credentials load as a complete pair, never mixed across files', () => {
    const ws = tmpDir(), home = tmpDir();
    assert.strictEqual(loadTelegramCredentials(ws, home).source, null);

    writeEnv(home, '.telegram_antigravity.env', 'gtok', 'gchat');
    assert.deepStrictEqual(loadTelegramCredentials(ws, home), { botToken: 'gtok', chatId: 'gchat', source: 'global' });

    writeEnv(ws, '.env', 'wtok', '');
    const partial = loadTelegramCredentials(ws, home);
    assert.strictEqual(partial.source, null);
    assert.strictEqual(partial.botToken, '');

    writeEnv(ws, '.env', 'wtok', 'wchat');
    assert.deepStrictEqual(loadTelegramCredentials(ws, home), { botToken: 'wtok', chatId: 'wchat', source: 'workspace' });
});
