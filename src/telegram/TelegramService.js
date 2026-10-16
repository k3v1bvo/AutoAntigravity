// AutoAntigravity — Telegram Bot Service
// Sends progress updates and receives commands via Telegram Bot API.

const https = require('https');
const fs = require('fs');
const { scanWorkflows } = require('./scanWorkflows');
const { t } = require('../i18n');

class TelegramService {
    constructor(log) {
        this._log = log || (() => { });
        this._botToken = null;
        this._chatId = null;
        this._polling = false;
        this._pollTimer = null;
        this._offset = 0;

        // External callback properties
        this.onMessageReceived = null;
        this.onStatusRequest = null;
        this.onStopRequest = null;
        this.onHelpRequest = null;
        this.onStartRequest = null;
        this.onAutoAcceptRequest = null;
        this.onConfigRequest = null;
        this.onQueueRequest = null;
        this.onWorkflowRequest = null;
        this.onMediaReceived = null;
        this.onTaskRequest = null;
        this.onPrdRequest = null;
        this.onChatRequest = null;
        this.onModelRequest = null;
        this.onSummaryRequest = null;

        // Notification detail level
        this.detailedNotification = false;
    }

    /** @returns {string|null} Current bot token */
    get botToken() { return this._botToken; }

    /** @returns {string|null} Current chat ID */
    get chatId() { return this._chatId; }

    /** @returns {boolean} Whether the service is actively polling */
    isConnected() { return this._polling; }

    /**
     * Start the Telegram bot service with the given token and chat ID.
     * Begins long polling and sends a connection message.
     * @param {string} botToken
     * @param {string} chatId
     * @param {string} [workspaceRoot] - Workspace root path for scanning workflow files
     */
    async start(botToken, chatId, workspaceRoot) {
        this._botToken = botToken;
        this._chatId = chatId;
        this._workspaceRoot = workspaceRoot;
        this._polling = true;

        await this.setMyCommands(workspaceRoot);
        await this.sendMessage(t('tg.connected'));
        this._poll();
        this._log('[Telegram] 봇 서비스 시작됨');
    }

    /** Stop polling and clear timers. */
    stop() {
        this._polling = false;
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
        this._log('[Telegram] 봇 서비스 중지됨');
    }

    /** Dispose — stop and clean up. */
    dispose() {
        this.stop();
    }

    /**
     * Send a text message to the configured chat.
     * Splits into chunks if text exceeds 4096 characters.
     * Never throws — errors are logged silently.
     */
    async sendMessage(text) {
        try {
            if (!this._botToken || !this._chatId) return;

            const maxLen = 4096;
            for (let i = 0; i < text.length; i += maxLen) {
                const chunk = text.substring(i, i + maxLen);
                try {
                    await this._telegramApiCall('sendMessage', {
                        chat_id: this._chatId,
                        text: chunk,
                        parse_mode: 'Markdown'
                    });
                } catch (markdownErr) {
                    try {
                        await this._telegramApiCall('sendMessage', {
                            chat_id: this._chatId,
                            text: chunk
                        });
                    } catch (plainErr) {
                        this._log('[Telegram] sendMessage error: ' + plainErr.message);
                    }
                }
            }
        } catch (err) {
            this._log('[Telegram] sendMessage error: ' + err.message);
        }
    }

    /**
     * Send a photo file to the configured chat via Telegram sendPhoto API.
     * Uses multipart/form-data to upload the local file.
     * Never throws — errors are logged silently.
     * @param {string} photoPath - Absolute path to the image file
     * @param {string} [caption] - Optional caption for the photo
     */
    async sendPhoto(photoPath, caption) {
        try {
            if (!this._botToken || !this._chatId) return;
            if (!fs.existsSync(photoPath)) {
                this._log(`[Telegram] sendPhoto 파일 없음: ${photoPath}`);
                return;
            }

            const path = require('path');
            const boundary = '----TelegramBotBoundary' + Date.now();
            const fileName = path.basename(photoPath);
            const fileData = fs.readFileSync(photoPath);

            // Build multipart/form-data body
            const parts = [];

            // chat_id field
            parts.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="chat_id"\r\n\r\n` +
                `${this._chatId}\r\n`
            ));

            // caption field (optional)
            if (caption) {
                parts.push(Buffer.from(
                    `--${boundary}\r\n` +
                    `Content-Disposition: form-data; name="caption"\r\n\r\n` +
                    `${caption}\r\n`
                ));
            }

            // photo file field
            parts.push(Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="photo"; filename="${fileName}"\r\n` +
                `Content-Type: application/octet-stream\r\n\r\n`
            ));
            parts.push(fileData);
            parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

            const body = Buffer.concat(parts);

            await new Promise((resolve, reject) => {
                const options = {
                    hostname: 'api.telegram.org',
                    port: 443,
                    path: `/bot${this._botToken}/sendPhoto`,
                    method: 'POST',
                    headers: {
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': body.length
                    },
                    timeout: 60000
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.ok) {
                                resolve(parsed.result);
                            } else {
                                reject(new Error(`Telegram sendPhoto error: ${parsed.description || 'Unknown'}`));
                            }
                        } catch (e) {
                            reject(new Error(`JSON parse error: ${e.message}`));
                        }
                    });
                });

                req.on('error', (err) => reject(err));
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('sendPhoto timeout'));
                });

                req.write(body);
                req.end();
            });

            this._log(`[Telegram] 📷 사진 전송 완료: ${fileName}`);
        } catch (err) {
            this._log(`[Telegram] sendPhoto 오류: ${err.message}`);
        }
    }

    /**
     * 개별 작업 완료 결과를 텔레그램으로 전송.
     * @param {string} taskText - 완료된 작업명
     * @param {number} iteration - 현재 반복 횟수
     * @param {{ completed: number, total: number }} progress - 진행률 (완료/전체)
     * @param {string[]} [imagePaths] - 작업 중 생성된 이미지 파일 경로 배열
     */
    async sendTaskResult(taskText, iteration, progress, imagePaths) {
        const { completed, total } = progress;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
        const bar = '█'.repeat(Math.round(percent / 10)) + '░'.repeat(10 - Math.round(percent / 10));

        const message = [
            t('tg.task_completed'),
            ``,
            `${t('tg.task_label')} ${taskText}`,
            `${t('tg.iteration_label')} ${iteration}${t('tg.iteration_suffix')}`,
            `${t('tg.progress_label')} ${completed}/${total} (${percent}%)`,
            `[${bar}]`,
        ].join('\n');

        await this.sendMessage(message);

        // 이미지가 있으면 전송
        if (imagePaths && imagePaths.length > 0) {
            for (const imgPath of imagePaths) {
                const path = require('path');
                await this.sendPhoto(imgPath, `🖼 ${path.basename(imgPath)}`);
            }
        }
    }

    /**
     * 세션 완료 결과를 텔레그램으로 전송.
     * detailedNotification 플래그와 무관하게 항상 호출됨.
     * @param {string} sessionLabel - 세션 제목
     * @param {Array<{text: string, completed: boolean}>} tasks - 작업 목록
     * @param {number} totalIterations - 총 반복 횟수
     */
    async sendSessionResult(sessionLabel, tasks, totalIterations) {
        const taskLines = (tasks || []).map(t => {
            const icon = t.completed ? '✅' : '❌';
            return `${icon} ${t.text}`;
        });

        const message = [
            `${t('tg.session_completed')} ${sessionLabel || t('tg.unknown')}`,
            ``,
            t('tg.task_results'),
            ...taskLines,
            ``,
            `${t('tg.total_iterations')} ${totalIterations}${t('tg.total_iterations_suffix')}`,
        ].join('\n');

        await this.sendMessage(message);
    }

    /**
     * Long-poll for incoming updates from Telegram.
     * Recursively calls itself via setTimeout.
     */
    async _poll() {
        if (!this._polling) return;

        try {
            const result = await this._telegramApiCall('getUpdates', {
                offset: this._offset,
                timeout: 30
            });

            if (result && Array.isArray(result)) {
                for (const update of result) {
                    this._offset = update.update_id + 1;
                    if (update.message) {
                        this._handleMessage(update.message);
                    }
                }
            }
        } catch (err) {
            this._log(`[Telegram] polling 오류: ${err.message}`);
        }

        // Schedule next poll
        if (this._polling) {
            this._pollTimer = setTimeout(() => this._poll(), 1000);
        }
    }

    /**
     * Handle an incoming message — dispatch commands or forward text.
     * Also handles media messages (photo / document) via onMediaReceived callback.
     */
    _handleMessage(message) {
        if (!message) return;

        // --- Authorization: only the configured chat may drive the IDE (commands, media, chat relay) ---
        const fromChat = message.chat ? message.chat.id : undefined;
        if (String(fromChat) !== String(this._chatId)) {
            this._log(`[Telegram] ⚠ Ignored message from unauthorized chat: ${fromChat}`);
            return;
        }

        // --- Media handling (photo / document) ---
        const mediaFiles = [];

        if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
            // Telegram sends multiple sizes; last element = highest resolution
            const bestPhoto = message.photo[message.photo.length - 1];
            mediaFiles.push({
                fileId: bestPhoto.file_id,
                fileName: 'photo.jpg',
                type: 'photo'
            });
        }

        if (message.document) {
            mediaFiles.push({
                fileId: message.document.file_id,
                fileName: message.document.file_name || 'document',
                type: 'document'
            });
        }

        if (mediaFiles.length > 0) {
            const captionText = (message.caption || '').trim();
            if (this.onMediaReceived) {
                this.onMediaReceived(captionText, mediaFiles);
            }
            return; // Media message handled — skip text-only flow
        }

        // --- Text-only handling ---
        if (!message.text) return;

        const text = message.text.trim();

        // Command token: "/name" or "/name@botname" — the bot mention is stripped from the token only,
        // arguments are passed through verbatim (emails, @scoped/packages, etc. stay intact).
        const cmdMatch = text.match(/^\/([a-zA-Z0-9_-]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/);
        if (!cmdMatch) {
            if (text.startsWith('/')) {
                this.sendMessage(t('tg.unknown_command', { cmd: text.substring(1, 31) }));
            } else if (this.onChatRequest) {
                // 일반 텍스트 메시지 → AI 대화로 전달
                this.onChatRequest(text);
            }
            return;
        }
        const cmdName = cmdMatch[1];
        const cmd = cmdName.toLowerCase();
        const args = (cmdMatch[2] || '').trim();

        switch (cmd) {
            case 'help': case 'ayuda':
                if (this.onHelpRequest) this.onHelpRequest();
                return;
            case 'status': case 'quota': case 'cuota':
                if (this.onStatusRequest) this.onStatusRequest();
                return;
            case 'summary': case 'resumen': case 'acciones':
                if (this.onSummaryRequest) this.onSummaryRequest();
                return;
            case 'model':
                if (this.onModelRequest) this.onModelRequest(args);
                return;
            case 'start':
                if (this.onStartRequest) this.onStartRequest();
                return;
            case 'stop':
                if (this.onStopRequest) this.onStopRequest();
                return;
            case 'autoaccept':
                if (this.onAutoAcceptRequest) this.onAutoAcceptRequest();
                return;
            case 'config':
                if (this.onConfigRequest) this.onConfigRequest();
                return;
            case 'queue':
                if (this.onQueueRequest) this.onQueueRequest();
                return;
            case 'prd':
                // /prd 명령: 뒤의 텍스트를 onPrdRequest 콜백으로 전달 (write-prd 워크플로우)
                if (!args) this.sendMessage(t('tg.prd_usage'));
                else if (this.onPrdRequest) this.onPrdRequest(args);
                return;
            case 'task':
                // /task 명령: 뒤의 텍스트를 onTaskRequest 콜백으로 직접 전달 (대화 형식)
                if (!args) this.sendMessage(t('tg.task_usage'));
                else if (this.onTaskRequest) this.onTaskRequest(args);
                return;
            default: {
                // Dynamic workflow slash command: /workflow-name optional args (only known workflows run)
                let isKnownWorkflow = false;
                try {
                    isKnownWorkflow = scanWorkflows(this._workspaceRoot).some(w => w.command.toLowerCase() === cmd);
                } catch (e) { /* no workspace */ }
                if (isKnownWorkflow && this.onWorkflowRequest) {
                    this.onWorkflowRequest(cmdName, args);
                } else {
                    this.sendMessage(t('tg.unknown_command', { cmd: cmdName }));
                }
            }
        }
    }

    /**
     * Make a POST request to the Telegram Bot API.
     * @param {string} method - API method name (e.g. 'sendMessage', 'getUpdates')
     * @param {object} body - JSON body to send
     * @returns {Promise<any>} Parsed JSON result
     */
    _telegramApiCall(method, body) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(body);

            const options = {
                hostname: 'api.telegram.org',
                port: 443,
                path: `/bot${this._botToken}/${method}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 35000 // 35s timeout for long polling
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.ok) {
                            resolve(parsed.result);
                        } else {
                            reject(new Error(`Telegram API error: ${parsed.description || 'Unknown'}`));
                        }
                    } catch (e) {
                        reject(new Error(`JSON parse error: ${e.message}`));
                    }
                });
            });

            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Download a file from Telegram servers to a local path.
     * Uses getFile API to obtain file_path, then downloads the binary content.
     * @param {string} fileId - Telegram file_id
     * @param {string} destPath - Local destination path to save the file
     * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
     */
    downloadFile(fileId, destPath) {
        return this._telegramApiCall('getFile', { file_id: fileId })
            .then((fileInfo) => {
                const filePath = fileInfo.file_path;
                const fileUrl = `/file/bot${this._botToken}/${filePath}`;

                return new Promise((resolve, reject) => {
                    const options = {
                        hostname: 'api.telegram.org',
                        port: 443,
                        path: fileUrl,
                        method: 'GET',
                        timeout: 60000 // 60s timeout for file download
                    };

                    const req = https.request(options, (res) => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`HTTP ${res.statusCode} downloading file`));
                            return;
                        }

                        const fileStream = fs.createWriteStream(destPath);
                        res.pipe(fileStream);

                        fileStream.on('finish', () => {
                            fileStream.close();
                            resolve({ success: true, path: destPath });
                        });

                        fileStream.on('error', (err) => {
                            // Clean up partial file on write error
                            try { fs.unlinkSync(destPath); } catch (_) { /* ignore */ }
                            reject(err);
                        });
                    });

                    req.on('error', (err) => reject(err));
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('File download timeout'));
                    });

                    req.end();
                });
            })
            .then((result) => {
                this._log(`[Telegram] 파일 다운로드 완료: ${destPath}`);
                return result;
            })
            .catch((err) => {
                this._log(`[Telegram] 파일 다운로드 실패: ${err.message}`);
                return { success: false, error: err.message };
            });
    }


    /**
     * Register slash commands with Telegram via setMyCommands API.
     * This enables the auto-complete menu when users type '/' in the chat.
     * Includes hardcoded commands + dynamically scanned workflow commands.
     * @param {string} [workspaceRoot] - Workspace root for scanning .agent/workflows/
     */
    async setMyCommands(workspaceRoot) {
        try {
            // 1) 기존 하드코딩 명령어
            const builtInCommands = [
                { command: 'help', description: t('tg.cmd_help') },
                { command: 'status', description: t('tg.cmd_status') },
                { command: 'quota', description: t('tg.cmd_quota') },
                { command: 'start', description: t('tg.cmd_start') },
                { command: 'stop', description: t('tg.cmd_stop') },
                { command: 'autoaccept', description: t('tg.cmd_autoaccept') },
                { command: 'config', description: t('tg.cmd_config') },
                { command: 'queue', description: t('tg.cmd_queue') },
                { command: 'task', description: t('tg.cmd_task') },
                { command: 'prd', description: t('tg.cmd_prd') },
                { command: 'model', description: t('tg.cmd_model') },
                { command: 'summary', description: t('tg.cmd_summary') }
            ];

            // 2) 동적 워크플로우 명령어 스캔 (공유 헬퍼 사용)
            const builtInNames = new Set(builtInCommands.map(c => c.command));
            const dynamicCommands = scanWorkflows(workspaceRoot)
                .filter(cmd => !builtInNames.has(cmd.command))
                .map(cmd => ({ command: cmd.command, description: cmd.description }));

            const allCommands = [...builtInCommands, ...dynamicCommands];

            await this._telegramApiCall('setMyCommands', {
                commands: allCommands
            });
            this._log(`[Telegram] setMyCommands 등록 완료 (${builtInCommands.length} 기본 + ${dynamicCommands.length} 워크플로우)`);
        } catch (err) {
            this._log(`[Telegram] setMyCommands 실패: ${err.message}`);
        }
    }

    /**
     * Ralph Loop log callback — only forwards important events to Telegram.
     * Filters by level ('error') or by presence of key emoji/markers in msg.
     */
    onRalphLog(logEntry) {
        if (!logEntry) return;

        const { msg, level } = logEntry;
        // detailedNotification=true: 기존 모든 마커 유지
        // detailedNotification=false(기본): 시작/완료/에러만 전달
        const importantMarkers = this.detailedNotification
            ? ['═══', t('tg.marker_task_completed'), t('tg.marker_all_tasks'), '❌', '🚀', '⏹', '🎉']
            : ['🚀', '🎉', '❌'];

        const isImportant = level === 'error' || importantMarkers.some(marker => msg && msg.includes(marker));

        if (isImportant) {
            const prefix = level === 'error' ? '🔴 ' : '';
            this.sendMessage(`${prefix}${msg}`);
        }
    }
}

module.exports = { TelegramService };
