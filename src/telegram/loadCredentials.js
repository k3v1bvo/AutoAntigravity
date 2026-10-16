// Load TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID as a complete pair.
// Workspace .env wins; ~/.telegram_antigravity.env is used only when the workspace provides neither.
// A file with only one of the two values is rejected rather than mixed with the other file.
const fs = require('fs');
const path = require('path');
const os = require('os');

function parseEnv(file) {
    if (!file || !fs.existsSync(file)) return null;
    const out = { botToken: '', chatId: '' };
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('TELEGRAM_BOT_TOKEN=')) {
            out.botToken = trimmed.substring('TELEGRAM_BOT_TOKEN='.length).trim();
        } else if (trimmed.startsWith('TELEGRAM_CHAT_ID=')) {
            out.chatId = trimmed.substring('TELEGRAM_CHAT_ID='.length).trim();
        }
    }
    return out;
}

/**
 * @param {string|undefined} workspaceRoot
 * @param {string} [homeDir]
 * @returns {{ botToken: string, chatId: string, source: 'workspace'|'global'|null, reason?: string }}
 */
function loadTelegramCredentials(workspaceRoot, homeDir = os.homedir()) {
    const none = (reason) => ({ botToken: '', chatId: '', source: null, reason });

    const ws = parseEnv(workspaceRoot ? path.join(workspaceRoot, '.env') : null);
    if (ws && (ws.botToken || ws.chatId)) {
        if (ws.botToken && ws.chatId) return { ...ws, source: 'workspace' };
        return none('workspace .env has only one of TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
    }

    const g = parseEnv(path.join(homeDir, '.telegram_antigravity.env'));
    if (g && g.botToken && g.chatId) return { ...g, source: 'global' };
    if (g && (g.botToken || g.chatId)) return none('~/.telegram_antigravity.env has only one of TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
    return none('no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID found in workspace .env or ~/.telegram_antigravity.env');
}

module.exports = { loadTelegramCredentials };
