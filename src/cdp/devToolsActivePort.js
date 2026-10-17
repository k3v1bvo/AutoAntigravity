'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Parses the content of a Chromium/Electron DevToolsActivePort file.
 * The file format has 2 lines:
 *   Line 1: Port number (e.g. "9558")
 *   Line 2: WebSocket browser endpoint path (e.g. "/devtools/browser/uuid")
 *
 * @param {string} content - Raw content of the DevToolsActivePort file
 * @returns {{ port: number, wsPath: string|null }|null}
 */
function parseDevToolsActivePort(content) {
    if (typeof content !== 'string') return null;
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    const port = parseInt(lines[0], 10);
    if (isNaN(port) || port <= 0 || port > 65535) {
        return null;
    }

    const wsPath = lines[1] && lines[1].startsWith('/') ? lines[1] : null;
    return { port, wsPath };
}

/**
 * Returns candidate user data directories where Antigravity IDE or VS Code
 * may store its DevToolsActivePort file.
 *
 * @param {string|null} customDir - Optional user-specified directory
 * @returns {string[]}
 */
function getCandidateDirectories(customDir = null) {
    const candidates = [];
    if (customDir && typeof customDir === 'string') {
        candidates.push(customDir);
    }

    const home = os.homedir();
    const platform = process.platform;
    const appNames = ['Antigravity IDE', 'antigravity', 'Code', 'Code - Insiders', 'Cursor', 'Windsurf'];

    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        for (const name of appNames) {
            candidates.push(path.join(appData, name));
        }
    } else if (platform === 'darwin') {
        const appSupport = path.join(home, 'Library', 'Application Support');
        for (const name of appNames) {
            candidates.push(path.join(appSupport, name));
        }
    } else {
        const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
        for (const name of appNames) {
            candidates.push(path.join(configHome, name));
        }
    }

    return candidates;
}

/**
 * Scans candidate directories for an active DevToolsActivePort file and parses it.
 *
 * @param {string[]|string|null} customDirs - Optional directory or directories to search first
 * @returns {{ port: number, wsPath: string|null, filePath: string }|null}
 */
function getDevToolsActivePort(customDirs = null) {
    const searchDirs = Array.isArray(customDirs)
        ? customDirs
        : (customDirs ? [customDirs] : getCandidateDirectories());

    for (const dir of searchDirs) {
        try {
            const portFile = path.join(dir, 'DevToolsActivePort');
            if (fs.existsSync(portFile)) {
                const content = fs.readFileSync(portFile, 'utf8');
                const parsed = parseDevToolsActivePort(content);
                if (parsed) {
                    return {
                        port: parsed.port,
                        wsPath: parsed.wsPath,
                        filePath: portFile
                    };
                }
            }
        } catch (e) {
            // Ignore filesystem permission or read errors and continue searching
        }
    }

    return null;
}

module.exports = {
    parseDevToolsActivePort,
    getCandidateDirectories,
    getDevToolsActivePort
};
