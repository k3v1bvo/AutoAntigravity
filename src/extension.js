// AutoAntigravity — Unified Extension Entry Point
// Combines Auto Accept (CDP button clicking) + Ralph Loop (iterative agent execution)
// + Self-Updater (Gitea release auto-update)

const vscode = require('vscode');
const { AutoAcceptManager } = require('./autoAccept');
const { RalphLoopManager, LoopState } = require('./ralph/ralphLoop');
const { RalphSidebarProvider } = require('./ralph/RalphSidebarProvider');
const { TelemetryService } = require('./telemetry/TelemetryService');
const { TelegramService } = require('./telegram/TelegramService');
const { scanWorkflows } = require('./telegram/scanWorkflows');
const { t } = require('./i18n');
const { loadTelegramCredentials } = require('./telegram/loadCredentials');
const { createModelHandler } = require('./telegram/modelCommand');

let autoAccept = null;
let ralphLoop = null;
let sidebarProvider = null;
let telemetryService = null;
let telegramService = null;
let statusBarAutoAccept = null;
let statusBarRalph = null;
let outputChannel = null;
let _extensionContext = null;

function log(msg) {
    if (outputChannel) {
        outputChannel.appendLine(`${new Date().toLocaleTimeString()} ${msg}`);
    }
}

function updateAutoAcceptStatusBar() {
    if (!statusBarAutoAccept) return;
    if (autoAccept && autoAccept.isEnabled) {
        statusBarAutoAccept.text = '$(zap) AutoAccept: ON';
        statusBarAutoAccept.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarAutoAccept.tooltip = 'Auto Accept is ACTIVE — click to disable';
    } else {
        statusBarAutoAccept.text = '$(circle-slash) AutoAccept: OFF';
        statusBarAutoAccept.backgroundColor = undefined;
        statusBarAutoAccept.tooltip = 'Auto Accept is OFF — click to enable';
    }
    // Sync sidebar
    if (sidebarProvider) sidebarProvider.updateState();
}

function updateRalphStatusBar() {
    if (!statusBarRalph) return;
    if (!ralphLoop) return;

    const state = ralphLoop.getState();
    switch (state) {
        case LoopState.RUNNING:
            statusBarRalph.text = `$(sync~spin) Ralph: #${ralphLoop.currentIteration}`;
            statusBarRalph.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarRalph.tooltip = 'Ralph Loop is RUNNING — click to stop';
            break;
        case LoopState.STOPPING:
            statusBarRalph.text = '$(loading~spin) Ralph: Stopping...';
            statusBarRalph.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarRalph.tooltip = 'Ralph Loop is stopping...';
            break;
        case LoopState.QUOTA_PAUSED:
            statusBarRalph.text = '$(watch) Ralph: Quota Paused';
            statusBarRalph.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            statusBarRalph.tooltip = 'Ralph Loop paused — waiting for model quota reset';
            break;
        default:
            statusBarRalph.text = '$(debug-start) Ralph: IDLE';
            statusBarRalph.backgroundColor = undefined;
            statusBarRalph.tooltip = 'Ralph Loop is IDLE — click to start';
            break;
    }
    // Sync sidebar
    if (sidebarProvider) sidebarProvider.updateState();
}

// ─── Git Session Helper ────────────────────────────────────────────────
/**
 * IDLE 상태에서 _sendToAgent 직접 호출 전에 Git 세션 브랜치를 미리 생성.
 * 이렇게 해야 PRD 작성 커밋도 세션 브랜치에서 이루어짐.
 * @param {string} label - 세션 라벨 (작업 설명 등)
 */
function _initGitSessionIfIdle(label) {
    const autoCommit = vscode.workspace.getConfiguration('autoAntigravity')
        .get('ralphLoop.autoCommit', true);
    if (!autoCommit) return;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const wsRoot = workspaceFolders && workspaceFolders.length > 0
        ? workspaceFolders[0].uri.fsPath : null;
    if (!wsRoot) return;

    // 이미 활성 세션이 있으면 건너뜀
    const existing = ralphLoop.gitManager.getSessionInfo();
    if (existing.active) {
        log(`[Git] 📌 기존 세션 사용: ${existing.sessionBranch || existing.originalBranch}`);
        return;
    }

    const gitResult = ralphLoop.gitManager.initSession(wsRoot, label);
    if (gitResult.success) {
        log(`[Git] 🌿 세션 브랜치 생성: ${gitResult.sessionBranch}`);
    }
}

// ─── Telegram Immediate Execution: Wait & Send Images Helper ──────────
/**
 * 즉시 실행 후 에이전트 작업 완료를 기다리고, 새로 생성된 이미지를 텔레그램으로 전송.
 * @param {Set<string>} imagesBefore - 실행 전 이미지 스냅샷
 */
async function _waitAndSendImages(imagesBefore) {
    try {
        log('[Telegram] ⏳ 에이전트 작업 완료 대기 중...');
        await ralphLoop._waitForAgentCompletion();
        log('[Telegram] ✅ 에이전트 작업 완료 감지');

        // 새로 생성된 이미지 감지
        const newImages = ralphLoop._getNewImagesSinceSnapshot(imagesBefore);
        if (newImages.length > 0 && telegramService) {
            const path = require('path');
            for (const imgPath of newImages) {
                await telegramService.sendPhoto(imgPath, `🖼 ${path.basename(imgPath)}`);
            }
            log(`[Telegram] 🖼 생성된 이미지 ${newImages.length}개 텔레그램 전송 완료`);
        }
    } catch (err) {
        log(`[Telegram] ⚠ 이미지 감지/전송 실패: ${err.message}`);
    }
}

// ─── Telegram Connect / Disconnect ────────────────────────────────────
function connectTelegram(context) {
    _extensionContext = context;
    // TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID: 워크스페이스 .env → ~/.telegram_antigravity.env (항상 쌍으로만 로드)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const creds = loadTelegramCredentials(workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined);
    const { botToken, chatId } = creds;
    if (!botToken || !chatId) {
        log('[Telegram] 텔레그램 활성화되었으나 botToken 또는 chatId가 비어있습니다. (' + creds.reason + ')');
        return;
    }
    log('[Telegram] Credentials loaded from ' + creds.source);

    telegramService = new TelegramService(log);

    // globalState에서 상세 알림 설정 복원
    telegramService.detailedNotification = context.globalState.get('autoAntigravity.telegramDetailedNotification', false);

    // 텔레그램 → 플러그인: /task 명령 수신 시 idle이면 즉시 실행, 아니면 큐에 추가
    telegramService.onTaskRequest = async (text) => {
        const isIdle = !ralphLoop.isBusy();

        if (isIdle) {
            ralphLoop.setStandaloneRunning(true);
            // Git 세션 초기화
            _initGitSessionIfIdle(text);

            // 이미지 스냅샷 (실행 전)
            const imagesBefore = ralphLoop._snapshotImageFiles();

            // Ralph Loop가 idle이면 즉시 대화 프롬프트로 전달
            try {
                ralphLoop.setStandaloneRunning(true);
                log(`[Telegram] 📤 즉시 실행 프롬프트 전송: ${text.substring(0, 80)}`);
                await ralphLoop._sendToAgent(text, []);
                telegramService.sendMessage(`${t('tg.executing_now')} ${text.substring(0, 80)}`);
                log(`[Telegram] ✅ 즉시 실행 프롬프트 전송 완료`);

                // 에이전트 완료 대기 후 생성된 이미지 텔레그램 전송 (비동기, 에러 무시)
                _waitAndSendImages(imagesBefore).finally(() => { ralphLoop.setStandaloneRunning(false); });
            } catch (err) {
                log(`[Telegram] ❌ 즉시 실행 프롬프트 전송 실패: ${err.message}`);
                telegramService.sendMessage(`${t('tg.execute_failed')} ${err.message}`);
                ralphLoop.setStandaloneRunning(false);
            }
        } else if (sidebarProvider) {
            // Ralph Loop가 실행 중이면 작업 큐에 추가 (text 그대로 저장)
            sidebarProvider._taskQueue.push({ text, mediaPaths: [], type: 'task' });
            sidebarProvider.updateState();
            telegramService.sendMessage(`${t('tg.queued')} (${sidebarProvider._taskQueue.length}): ${text.substring(0, 80)}`);
            log('[Telegram] 작업 큐에 추가: ' + text.substring(0, 80));
        } else {
            telegramService.sendMessage(t('tg.sidebar_not_init'));
        }
    };

    // 텔레그램 → 플러그인: /prd 명령 수신 시 idle이면 즉시 /write-prd 워크플로우 실행, 아니면 큐에 추가
    telegramService.onPrdRequest = async (text) => {
        const prompt = '/write-prd ' + text;

        if (!ralphLoop.isBusy()) {
            // Git 세션 초기화
            _initGitSessionIfIdle(text);

            // Ralph Loop가 idle이면 즉시 /write-prd 워크플로우로 실행
            try {
                ralphLoop.setStandaloneRunning(true);
                log(`[Telegram] 📤 PRD 즉시 실행 프롬프트 전송: ${text.substring(0, 80)}`);
                await ralphLoop._sendToAgent(prompt, []);
                telegramService.sendMessage(`${t('tg.prd_executing')} ${text.substring(0, 80)}`);
                log(`[Telegram] ✅ PRD 즉시 실행 프롬프트 전송 완료`);
                await ralphLoop._waitForAgentCompletion();
            } catch (err) {
                log(`[Telegram] ❌ PRD 즉시 실행 프롬프트 전송 실패: ${err.message}`);
                telegramService.sendMessage(`${t('tg.prd_execute_failed')} ${err.message}`);
            } finally {
                ralphLoop.setStandaloneRunning(false);
            }
        } else if (sidebarProvider) {
            // Ralph Loop가 실행 중이면 작업 큐에 추가 (type: 'prd'로 저장)
            sidebarProvider._taskQueue.push({ text, mediaPaths: [], type: 'prd' });
            sidebarProvider.updateState();
            telegramService.sendMessage(`${t('tg.prd_queued')} (${sidebarProvider._taskQueue.length}): ${text.substring(0, 80)}`);
            log('[Telegram] PRD 작업 큐에 추가: ' + text.substring(0, 80));
        } else {
            telegramService.sendMessage(t('tg.sidebar_not_init'));
        }
    };

    // 텔레그램 → 플러그인: 일반 대화 메시지 수신 시 AI에 전달 후 응답 회신
    telegramService.onChatRequest = async (text) => {
        const isIdle = !ralphLoop.isBusy();

        if (isIdle) {
            ralphLoop.setStandaloneRunning(true);
            // Git 세션 초기화
            _initGitSessionIfIdle(text);

            try {
                log(`[Telegram] 💬 일반 대화 프롬프트 전송: ${text.substring(0, 80)}`);
                await ralphLoop._sendToAgent(text, []);
                telegramService.sendMessage(t('tg.chat_processing'));
                log(`[Telegram] ✅ 일반 대화 프롬프트 전송 완료`);

                // 에이전트 완료 대기 후 응답 추출
                await ralphLoop._waitForAgentCompletion();
                log(`[Telegram] ✅ 에이전트 대화 응답 완료`);

                // CDP로 마지막 에이전트 응답 추출
                const response = await ralphLoop._getLastAgentResponse();
                if (response) {
                    telegramService.sendMessage(`🤖 ${response}`);
                    log(`[Telegram] 📤 대화 응답 텔레그램 전송 완료 (${response.length}자)`);
                } else {
                    telegramService.sendMessage(t('tg.chat_extract_fail'));
                    log(`[Telegram] ⚠ 대화 응답 추출 실패`);
                }
                ralphLoop.setStandaloneRunning(false);
            } catch (err) {
                ralphLoop.setStandaloneRunning(false);
                log(`[Telegram] ❌ 일반 대화 처리 실패: ${err.message}`);
                telegramService.sendMessage(`${t('tg.chat_failed')} ${err.message}`);
            }
        } else if (sidebarProvider) {
            // Ralph Loop가 실행 중이면 작업 큐에 추가 (type: 'chat')
            sidebarProvider._taskQueue.push({ text, mediaPaths: [], type: 'chat' });
            sidebarProvider.updateState();
            telegramService.sendMessage(`${t('tg.chat_queued')} (${sidebarProvider._taskQueue.length}): ${text.substring(0, 80)}`);
            log('[Telegram] 대화 큐에 추가: ' + text.substring(0, 80));
        } else {
            telegramService.sendMessage(t('tg.sidebar_not_init'));
        }
    };

    // 텔레그램 → 플러그인: /model — 모델 조회/전환 (별칭 검증, 작업 중 거부, 전환 결과 검증)
    telegramService.onModelRequest = createModelHandler({
        ralphLoop,
        send: (m) => telegramService.sendMessage(m),
        log,
    });

    // 텔레그램 → 플러그인: /summary — 자동 승인 기록 조회
    telegramService.onSummaryRequest = () => {
        const autoAcceptState = autoAccept && autoAccept.isEnabled ? 'ON ⚡' : 'OFF 🔴';
        telegramService.sendMessage([
            t('tg.summary_title'),
            ``,
            `${t('tg.status_autoaccept')} ${autoAcceptState}`,
            `${t('tg.summary_count')} ${autoAccept ? autoAccept._acceptedTotal : 0}`,
            ``,
            autoAccept ? autoAccept.getAcceptedSummary() : t('tg.summary_empty'),
        ].join('\n'));
    };

    // 텔레그램 → 플러그인: 도움말
    telegramService.onHelpRequest = () => {
        const lines = [
            t('tg.help_title'),
            ``,
            `/help — ${t('tg.cmd_help')}`,
            `/status — ${t('tg.cmd_status')}`,
            `/quota — ${t('tg.cmd_quota')}`,
            `/start — ${t('tg.cmd_start')}`,
            `/stop — ${t('tg.cmd_stop')}`,
            `/autoaccept — ${t('tg.cmd_autoaccept')}`,
            `/model [name] — ${t('tg.cmd_model')}`,
            `/summary — ${t('tg.cmd_summary')}`,
            `/config — ${t('tg.cmd_config')}`,
            `/queue — ${t('tg.cmd_queue')}`,
        ];

        // 동적 워크플로우 명령어 추가
        const wsRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
        const builtInNames = new Set(['help', 'status', 'quota', 'start', 'stop', 'autoaccept', 'model', 'summary', 'config', 'queue']);
        const workflows = scanWorkflows(wsRoot).filter(w => !builtInNames.has(w.command));
        if (workflows.length > 0) {
            lines.push(``);
            lines.push(t('tg.help_workflow_section'));
            for (const wf of workflows) {
                lines.push(`/${wf.command} — ${wf.description}`);
            }
        }

        lines.push(``);
        lines.push(t('tg.help_task_section'));
        lines.push(t('tg.help_task_desc'));
        lines.push(t('tg.help_prd_desc'));
        lines.push(``);
        lines.push(t('tg.help_general_msg'));

        telegramService.sendMessage(lines.join('\n'));
    };

    // 텔레그램 → 플러그인: 상태 조회 (+ AI 사용량)
    telegramService.onStatusRequest = () => {
        const state = ralphLoop.getState();
        const progress = ralphLoop.taskManager.getProgress();
        const autoAcceptState = autoAccept && autoAccept.isEnabled ? 'ON ⚡' : 'OFF 🔴';
        const queueCount = sidebarProvider ? sidebarProvider._taskQueue.length : 0;

        const lines = [
            t('tg.status_title'),
            ``,
            `${t('tg.status_ralph')} ${state}`,
            `${t('tg.status_progress')} ${progress.completed}/${progress.total} (${t('tg.status_remaining')} ${progress.remaining})`,
            `${t('tg.status_iteration')} ${ralphLoop.currentIteration}`,
            `${t('tg.status_autoaccept')} ${autoAcceptState}`,
            `${t('tg.status_accepted')} ${autoAccept ? autoAccept._acceptedTotal : 0}`,
            `${t('tg.status_queue')} ${queueCount}${t('tg.status_items')}`,
        ];

        // AI 사용량 정보 추가 (TelemetryService → { label, remaining: 0~1, resetTime })
        if (telemetryService) {
            const quota = telemetryService.getData();
            if (quota && quota.connected && quota.models && quota.models.length > 0) {
                lines.push(``);
                lines.push(t('tg.status_ai_usage'));
                for (const m of quota.models) {
                    const pct = Math.max(0, Math.min(100, Math.round((typeof m.remaining === 'number' ? m.remaining : 0) * 100)));
                    const filled = Math.round(pct / 10);
                    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
                    const reset = m.resetTime ? ` (${t('tg.status_reset')} ${new Date(m.resetTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : '';
                    lines.push(`  ${m.label || m.name}: ${pct}% ${t('tg.status_left')} [${bar}]${reset}`);
                }
            } else if (quota && !quota.connected) {
                lines.push(``);
                lines.push(t('tg.status_ai_connecting'));
            }
        }

        telegramService.sendMessage(lines.join('\n'));
    };

    // 텔레그램 → 플러그인: Ralph Loop 시작
    telegramService.onStartRequest = () => {
        const state = ralphLoop.getState();
        if (state === LoopState.RUNNING || ralphLoop.isBusy()) {
            telegramService.sendMessage(t('tg.already_running'));
        } else {
            ralphLoop.start().then(() => {
                updateRalphStatusBar();
                telegramService.sendMessage(t('tg.loop_started'));
            }).catch(err => {
                telegramService.sendMessage(`${t('tg.loop_start_failed')} ${err.message}`);
            });
        }
    };

    // 텔레그램 → 플러그인: 정지
    telegramService.onStopRequest = async () => {
        await ralphLoop.stop();
        updateRalphStatusBar();
        telegramService.sendMessage(t('tg.loop_stopped'));
    };

    // 텔레그램 → 플러그인: AutoAccept 토글
    telegramService.onAutoAcceptRequest = () => {
        const enabled = autoAccept.toggle();
        updateAutoAcceptStatusBar();
        telegramService.sendMessage(`⚡ AutoAccept: ${enabled ? 'ON ✅' : 'OFF 🔴'}`);
    };

    // 텔레그램 → 플러그인: 설정 조회
    telegramService.onConfigRequest = () => {
        const config = vscode.workspace.getConfiguration('autoAntigravity');
        const configMsg = [
            t('tg.config_title'),
            ``,
            `🔄 *Max Iterations*: ${config.get('ralphLoop.maxIterations', 50)}`,
            `⏱ *Iteration Delay*: ${config.get('ralphLoop.iterationDelayMs', 1500)}ms`,
            `📝 *PRD Modification*: ${config.get('ralphLoop.allowPrdModification', false) ? 'ON' : 'OFF'}`,
            `▶️ *Auto Start*: ${config.get('ralphLoop.autoStart', true) ? 'ON' : 'OFF'}`,
            `💾 *Auto Commit*: ${config.get('ralphLoop.autoCommit', true) ? 'ON' : 'OFF'}`,
            `🗑 *Auto Delete Branch*: ${config.get('ralphLoop.autoDeleteBranch', true) ? 'ON' : 'OFF'}`,
            `🔀 *Parallel Enabled*: ${config.get('ralphLoop.enableParallel', true) ? 'ON' : 'OFF'}`,
            `📁 *Task File*: ${config.get('ralphLoop.taskFile', 'PRD.md')}`,
        ].join('\n');
        telegramService.sendMessage(configMsg);
    };

    // 텔레그램 → 플러그인: 작업 큐 조회
    telegramService.onQueueRequest = () => {
        if (!sidebarProvider || sidebarProvider._taskQueue.length === 0) {
            telegramService.sendMessage(t('tg.queue_empty'));
            return;
        }
        const items = sidebarProvider._taskQueue.map((t, i) => `${i + 1}. ${t.text.substring(0, 60)}${t.mediaPaths.length > 0 ? ` 📎${t.mediaPaths.length}` : ''}`);
        const msg = [`${t('tg.queue_title')} (${sidebarProvider._taskQueue.length})`, ``, ...items].join('\n');
        telegramService.sendMessage(msg);
    };

    // 텔레그램 → 플러그인: 동적 워크플로우 명령어 수신
    telegramService.onWorkflowRequest = async (workflowName, argsText) => {
        // (TelegramService already rejects unknown workflow names before calling this)
        const prompt = argsText ? `/${workflowName} ${argsText}` : `/${workflowName}`;
        const isIdle = !ralphLoop.isBusy();

        if (isIdle) {
            ralphLoop.setStandaloneRunning(true);
            // Git 세션 초기화 (워크플로우도 세션 브랜치에서 진행)
            _initGitSessionIfIdle(workflowName);

            // Ralph Loop가 idle이면 즉시 실행
            try {
                ralphLoop.setStandaloneRunning(true);
                log(`[Telegram] 📤 워크플로우 프롬프트 전송: ${prompt.substring(0, 80)}`);
                await ralphLoop._sendToAgent(prompt, []);
                telegramService.sendMessage(`${t('tg.workflow_executing')} /${workflowName}`);
                log(`[Telegram] ✅ 워크플로우 프롬프트 전송 완료`);
                await ralphLoop._waitForAgentCompletion();
            } catch (err) {
                log(`[Telegram] ❌ 워크플로우 프롬프트 전송 실패: ${err.message}`);
                telegramService.sendMessage(`${t('tg.workflow_failed')} ${err.message}`);
            } finally {
                ralphLoop.setStandaloneRunning(false);
            }
        } else {
            // Ralph Loop가 실행 중이면 작업 큐에 추가
            if (sidebarProvider) {
                sidebarProvider._taskQueue.push({ text: prompt, mediaPaths: [] });
                sidebarProvider.updateState();
                telegramService.sendMessage(`${t('tg.workflow_queued')} (${sidebarProvider._taskQueue.length}): ${prompt.substring(0, 80)}`);
                log(`[Telegram] 작업 큐에 워크플로우 추가: ${prompt.substring(0, 80)}`);
            } else {
                telegramService.sendMessage(t('tg.sidebar_not_init'));
            }
        }
    };

    // 텔레그램 → 플러그인: 미디어 수신 시 파일 다운로드 후 처리
    telegramService.onMediaReceived = async (text, mediaFiles) => {
        const fs = require('fs');
        const path = require('path');

        // 워크스페이스 루트 확인
        const wsRoot = workspaceFolders && workspaceFolders.length > 0
            ? workspaceFolders[0].uri.fsPath : null;
        if (!wsRoot) {
            telegramService.sendMessage(t('tg.media_no_workspace'));
            return;
        }

        // .antigravity/media/ 디렉토리 생성
        const mediaDir = path.join(wsRoot, '.antigravity', 'media');
        fs.mkdirSync(mediaDir, { recursive: true });

        // 각 미디어 파일 다운로드
        const timestamp = Date.now();
        const downloadedPaths = [];

        for (const mf of mediaFiles) {
            const fileName = mf.type === 'photo' && (!mf.fileName || mf.fileName === 'photo.jpg')
                ? `${timestamp}_photo.jpg`
                : `${timestamp}_${mf.fileName}`;
            const destPath = path.join(mediaDir, fileName);

            try {
                const result = await telegramService.downloadFile(mf.fileId, destPath);
                if (result.success) {
                    downloadedPaths.push(result.path);
                    log(`[Telegram] 📥 미디어 다운로드 성공: ${fileName}`);
                } else {
                    log(`[Telegram] ⚠️ 미디어 다운로드 실패: ${result.error}`);
                }
            } catch (err) {
                log(`[Telegram] ❌ 미디어 다운로드 오류: ${err.message}`);
            }
        }

        if (downloadedPaths.length === 0) {
            telegramService.sendMessage(t('tg.media_download_all_fail'));
            return;
        }

        // 프롬프트 구성: 미디어 + 캡션 텍스트를 대화 프롬프트로 직접 전달 (/task와 동일)
        const captionText = text || '';
        const mediaRefs = downloadedPaths.map(p => `@${p}`).join(' ');
        const prompt = captionText
            ? `${captionText}\n\n${t('tg.media_attach_label')}\n${mediaRefs}`
            : `${t('tg.media_analyze')}\n\n${t('tg.media_attach_label')}\n${mediaRefs}`;

        const isIdle = !ralphLoop.isBusy();

        if (isIdle) {
            ralphLoop.setStandaloneRunning(true);
            // Git 세션 초기화 (미디어 작업도 세션 브랜치에서 진행)
            _initGitSessionIfIdle(captionText || t('tg.media_session_label'));

            // 이미지 스냅샷 (실행 전)
            const imagesBefore = ralphLoop._snapshotImageFiles();

            // idle이면 즉시 대화 프롬프트로 전달
            try {
                ralphLoop.setStandaloneRunning(true);
                log(`[Telegram] 📤 미디어 포함 즉시 실행: ${prompt.substring(0, 80)}`);
                await ralphLoop._sendToAgent(prompt, downloadedPaths);
                telegramService.sendMessage(`${t('tg.media_executing')} (${downloadedPaths.length}): ${captionText.substring(0, 60) || t('tg.media_no_caption')}`);
                log(`[Telegram] ✅ 미디어 포함 즉시 실행 완료`);

                // 에이전트 완료 대기 후 생성된 이미지 텔레그램 전송 (비동기, 에러 무시)
                _waitAndSendImages(imagesBefore).finally(() => { ralphLoop.setStandaloneRunning(false); });
            } catch (err) {
                log(`[Telegram] ❌ 미디어 포함 즉시 실행 실패: ${err.message}`);
                telegramService.sendMessage(`${t('tg.media_failed')} ${err.message}`);
                ralphLoop.setStandaloneRunning(false);
            }
        } else if (sidebarProvider) {
            // 실행 중이면 큐에 추가 (텍스트 + 미디어 경로, type: 'task')
            const queueText = captionText || t('tg.media_attach_task');
            sidebarProvider._taskQueue.push({ text: queueText, mediaPaths: downloadedPaths, type: 'task' });
            sidebarProvider.updateState();
            telegramService.sendMessage(`${t('tg.media_queued')} (${sidebarProvider._taskQueue.length}, ${downloadedPaths.length}): ${queueText.substring(0, 60)}`);
            log(`[Telegram] 미디어 작업 큐에 추가: ${queueText.substring(0, 80)}`);
        } else {
            telegramService.sendMessage(t('tg.sidebar_not_init'));
        }
    };

    // 플러그인 → 텔레그램: Ralph Loop 로그 전달
    ralphLoop.onLogCallback = (logEntry) => {
        telegramService.onRalphLog(logEntry);
    };

    // 플러그인 → 텔레그램: 개별 작업 완료 결과 전달 (detailedNotification 플래그에 따라 조건부)
    // imagePaths: 작업 중 생성된 이미지 파일 경로 배열 (git diff 기반 감지)
    ralphLoop.onTaskCompleteCallback = (taskText, iteration, progress, imagePaths) => {
        if (telegramService.detailedNotification) {
            telegramService.sendTaskResult(taskText, iteration, progress, imagePaths);
        } else if (imagePaths && imagePaths.length > 0) {
            // 상세 알림이 꺼져 있어도 이미지가 있으면 이미지만 전송
            for (const imgPath of imagePaths) {
                const path = require('path');
                telegramService.sendPhoto(imgPath, `🖼 ${path.basename(imgPath)}`);
            }
        }
    };

    // 플러그인 → 텔레그램: 쿼터 초과 알림
    ralphLoop.onQuotaExhaustedCallback = (info) => {
        if (info.resumed) {
            telegramService.sendMessage(t('tg.quota_resumed'));
        } else {
            telegramService.sendMessage(
                `${t('tg.quota_exhausted_title')}\n\n` +
                `${t('tg.quota_exhausted_body')}\n` +
                `${t('tg.quota_exhausted_reset')} ${info.refreshTime}\n` +
                `${t('tg.quota_exhausted_resume')} ${info.resumeTime} (${t('tg.quota_exhausted_wait', { minutes: info.waitMinutes })})\n\n` +
                t('tg.quota_exhausted_info')
            );
        }
    };

    // NOTE: onAllTasksCompleteCallback은 activate()에서 통합 설정 (사이드바 큐 처리 + 텔레그램 알림)

    const wsRoot = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : undefined;
    telegramService.start(botToken, chatId, wsRoot);
    context.subscriptions.push({ dispose: () => telegramService.dispose() });
    log('[Telegram] 텔레그램 봇 서비스 시작');

    // sidebar에 참조 동기화
    if (sidebarProvider) {
        sidebarProvider.telegramService = telegramService;
        sidebarProvider.updateState();
    }

    // 텔레그램 연결 상태를 globalState에 영속 저장
    context.globalState.update('autoAntigravity.telegramConnected', true);
}

function disconnectTelegram() {
    if (telegramService) {
        telegramService.dispose();
        telegramService = null;
        log('[Telegram] 텔레그램 봇 서비스 해제');
    }
    // Ralph Loop 콜백 정리 (onAllTasksCompleteCallback은 activate()에서 관리)
    if (ralphLoop) {
        ralphLoop.onLogCallback = null;
        ralphLoop.onTaskCompleteCallback = null;
        ralphLoop.onQuotaExhaustedCallback = null;
    }
    // sidebar에 참조 동기화
    if (sidebarProvider) {
        sidebarProvider.telegramService = null;
        sidebarProvider.updateState();
    }

    // 텔레그램 연결 해제 상태를 globalState에 영속 저장
    if (_extensionContext) {
        _extensionContext.globalState.update('autoAntigravity.telegramConnected', false);
    }
}

// ─── Activation ───────────────────────────────────────────────────────
function activate(context) {
    outputChannel = vscode.window.createOutputChannel('AutoAntigravity');
    const currentVersion = context.extension.packageJSON.version;
    log(`AutoAntigravity extension activating (v${currentVersion})`);

    // ─── Initialize Auto Accept ───────────────────────────────────────
    autoAccept = new AutoAcceptManager(log);
    autoAccept.initialize(context);
    // 자동 승인된 액션을 조용히 기록 → 텔레그램 /summary 로 조회
    autoAccept.onActionAccepted = (txt) => {
        autoAccept.recordAcceptedEvent(txt);
    };
    if (autoAccept.connectionManager) {
        autoAccept.connectionManager.onActionAccepted = (txt) => {
            autoAccept.recordAcceptedEvent(txt);
        };
    }

    // ─── Initialize Ralph Loop ────────────────────────────────────────
    ralphLoop = new RalphLoopManager(log);
    ralphLoop.setContext(context);
    ralphLoop.setConnectionManager(autoAccept.connectionManager);
    ralphLoop.restoreTaskFile();
    ralphLoop.onStateChange = () => {
        updateRalphStatusBar();
    };

    // ─── Code Review Watcher 초기 시작 (설정이 켜져 있으면) ───────────
    ralphLoop._startCodeReviewWatcherIfEnabled();

    // ─── 전체 작업 완료 시: 사이드바 큐 처리 + 텔레그램 알림 ──────────
    ralphLoop.onAllTasksCompleteCallback = async (sessionLabel, tasks, totalIterations) => {
        // 1) 텔레그램 알림 (연결 시)
        if (telegramService && typeof telegramService.sendSessionResult === 'function') {
            try {
                telegramService.sendSessionResult(sessionLabel, tasks, totalIterations);
            } catch (e) {
                log(`[Queue] 텔레그램 완료 알림 실패: ${e.message}`);
            }
        }

        // 2) 사이드바 큐에 항목이 있으면 다음 작업 전송 (type에 따라 분기)
        if (sidebarProvider && sidebarProvider._taskQueue.length > 0) {
            const nextItem = sidebarProvider._taskQueue.shift();
            const nextTask = nextItem.text;
            const nextMediaPaths = nextItem.mediaPaths || [];
            const itemType = nextItem.type || 'prd'; // 기본값 'prd' (하위 호환)
            log(`[Queue] 📬 큐에서 다음 작업 꺼냄 (type: ${itemType}, 남은: ${sidebarProvider._taskQueue.length}${nextMediaPaths.length > 0 ? ', 미디어 ' + nextMediaPaths.length + '개' : ''}): ${nextTask.substring(0, 80)}`);
            sidebarProvider.updateState(); // 큐 UI 갱신

            // 큐 작업에 의한 PRD 변경 시 autoStart 무관하게 자동 시작되도록 플래그 설정
            ralphLoop._forceNextAutoStart = true;
            ralphLoop.setStandaloneRunning(true);

            // Git 세션 초기화 (큐 작업도 세션 브랜치에서 진행)
            _initGitSessionIfIdle(nextTask);

            // type에 따라 프롬프트 구성: 'prd' → /write-prd 래핑, 'task'/'chat' → 텍스트 직접 전달
            const prompt = (itemType === 'task' || itemType === 'chat') ? nextTask : `/write-prd ${nextTask}`;
            const promptLabel = (itemType === 'task' || itemType === 'chat') ? '대화 프롬프트' : 'write-prd 워크플로우 프롬프트';
            try {
                ralphLoop.setStandaloneRunning(true);
                log(`[Queue] 📤 ${promptLabel} 전송 중...`);
                await ralphLoop._sendToAgent(prompt, nextMediaPaths);
                log(`[Queue] ✅ ${promptLabel} 전송 완료`);

                if (telegramService && typeof telegramService.sendMessage === 'function') {
                    const emoji = itemType === 'chat' ? '💬' : itemType === 'task' ? '💬' : '📬';
                    telegramService.sendMessage(`${emoji} ${t('tg.queue_auto_exec')} ${nextTask.substring(0, 80)}`);
                }
                
                if (itemType !== 'chat') {
                    // For non-chat tasks from queue, we wait for completion inside agent logic? No wait!
                    // _sendToAgent only sends prompt. We need to await _waitForAgentCompletion to know it's done!
                }

                await ralphLoop._waitForAgentCompletion();

                // autoStart 설정이 false이면 일회성 watcher 설정 (prd 타입만 — task/chat는 대화 직접 전달이므로 watcher 불필요)
                if (itemType !== 'task' && itemType !== 'chat') {
                    const autoStartEnabled = vscode.workspace.getConfiguration('autoAntigravity')
                        .get('ralphLoop.autoStart', false);
                    if (!autoStartEnabled) {
                        ralphLoop.enableAutoStartOnce();
                        log(`[Queue] 👁 autoStart 비활성 상태 — 일회성 watcher 활성화`);
                    }
                }

                // chat 타입: 응답 추출 → 텔레그램 전송
                if (itemType === 'chat') {
                    try {
                        const response = await ralphLoop._getLastAgentResponse();
                        if (response && telegramService) {
                            telegramService.sendMessage(`🤖 ${response}`);
                            log(`[Queue] 📤 대화 응답 텔레그램 전송 완료`);
                        } else if (telegramService) {
                            telegramService.sendMessage(t('tg.chat_extract_fail'));
                        }
                    } catch (chatErr) {
                        log(`[Queue] ⚠ 대화 응답 추출 실패: ${chatErr.message}`);
                    }
                }
                ralphLoop.setStandaloneRunning(false);
            } catch (err) {
                log(`[Queue] ❌ ${promptLabel} 전송 실패: ${err.message}`);
                ralphLoop._forceNextAutoStart = false; // 전송 실패 시 플래그 리셋
                ralphLoop.setStandaloneRunning(false);
                if (telegramService && typeof telegramService.sendMessage === 'function') {
                    telegramService.sendMessage(`${t('tg.queue_exec_failed')} ${err.message}`);
                }
            } finally {
                ralphLoop.setStandaloneRunning(false);
            }
        }
    };

    // ─── Auto Start (FileSystemWatcher) ──────────────────────────────
    const autoStartConfig = vscode.workspace.getConfiguration('autoAntigravity');
    if (autoStartConfig.get('ralphLoop.autoStart', false)) {
        ralphLoop.enableAutoStart();
    }

    // 설정 변경 시 동적으로 autoStart ON/OFF, Code Review Watcher ON/OFF
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('autoAntigravity.ralphLoop.autoStart')) {
                const enabled = vscode.workspace.getConfiguration('autoAntigravity')
                    .get('ralphLoop.autoStart', false);
                if (enabled) {
                    ralphLoop.enableAutoStart();
                } else {
                    ralphLoop.disableAutoStart();
                }
                log(`Auto Start ${enabled ? 'enabled' : 'disabled'}`);
            }
            // 코드 리뷰 설정 변경 시 워처 동적 관리
            if (e.affectsConfiguration('autoAntigravity.ralphLoop.enableCodeReview')) {
                ralphLoop._startCodeReviewWatcherIfEnabled();
                const enabled = vscode.workspace.getConfiguration('autoAntigravity')
                    .get('ralphLoop.enableCodeReview', false);
                log(`Code Review Watcher ${enabled ? 'enabled' : 'disabled'}`);
            }
        })
    );

    // ─── Register Sidebar WebviewView Provider ────────────────────────
    sidebarProvider = new RalphSidebarProvider(context, log);
    sidebarProvider.autoAccept = autoAccept;
    sidebarProvider.ralphLoop = ralphLoop;

    // Wire sidebar actions
    sidebarProvider.onToggleAutoAccept = async () => {
        await vscode.commands.executeCommand('autoAntigravity.toggleAutoAccept');
    };
    sidebarProvider.onStartRalph = () => {
        vscode.commands.executeCommand('autoAntigravity.startRalphLoop');
    };
    sidebarProvider.onStopRalph = () => {
        vscode.commands.executeCommand('autoAntigravity.stopRalphLoop');
    };
    sidebarProvider.onSelectTaskFile = () => {
        vscode.commands.executeCommand('autoAntigravity.selectTaskFile');
    };
    sidebarProvider.onToggleTelegram = async () => {
        if (telegramService) {
            disconnectTelegram();
        } else {
            connectTelegram(context);
        }
    };
    sidebarProvider.onSaveTelegramCred = async (botToken, chatId) => {
        // .env에 자격증명 저장
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            const fs = require('fs');
            const path = require('path');
            const envPath = path.join(workspaceFolders[0].uri.fsPath, '.env');
            let lines = [];
            if (fs.existsSync(envPath)) {
                lines = fs.readFileSync(envPath, 'utf-8').split('\n');
            }
            // 기존 키를 업데이트하거나 추가
            let foundToken = false, foundChat = false;
            lines = lines.map(l => {
                if (l.trim().startsWith('TELEGRAM_BOT_TOKEN=')) { foundToken = true; return `TELEGRAM_BOT_TOKEN=${botToken}`; }
                if (l.trim().startsWith('TELEGRAM_CHAT_ID=')) { foundChat = true; return `TELEGRAM_CHAT_ID=${chatId}`; }
                return l;
            });
            if (!foundToken) lines.push(`TELEGRAM_BOT_TOKEN=${botToken}`);
            if (!foundChat) lines.push(`TELEGRAM_CHAT_ID=${chatId}`);
            fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
            log(`[Telegram] .env에 자격증명 저장 완료: ${envPath}`);
        }
        // 저장 후 연결
        connectTelegram(context);
    };

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            RalphSidebarProvider.viewType,
            sidebarProvider
        )
    );

    // ─── Initialize Telemetry Service ─────────────────────────────
    telemetryService = new TelemetryService(log);
    sidebarProvider.telemetryService = telemetryService;

    // Update sidebar when quota data changes
    telemetryService.onUpdate(() => {
        if (sidebarProvider) sidebarProvider.updateState();
    });

    const pollInterval = vscode.workspace.getConfiguration('autoAntigravity')
        .get('telemetry.pollInterval', 90);
    telemetryService.startPolling(pollInterval);

    context.subscriptions.push({ dispose: () => telemetryService.dispose() });

    // ─── Initialize Telegram Service ──────────────────────────────────
    sidebarProvider.telegramService = telegramService; // 초기 null 참조
    // globalState 기반 텔레그램 자동 연결 (fallback: 기존 telegram.enabled 설정)
    const telegramGlobalState = context.globalState.get('autoAntigravity.telegramConnected');
    const shouldConnectTelegram = telegramGlobalState !== undefined
        ? telegramGlobalState  // globalState에 명시적 값이 있으면 그 값 사용
        : vscode.workspace.getConfiguration('autoAntigravity').get('telegram.enabled', false); // 한 번도 설정된 적 없으면 config fallback
    if (shouldConnectTelegram) {
        connectTelegram(context);
    }

    // ─── Status Bar Items ─────────────────────────────────────────────
    statusBarAutoAccept = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
    statusBarAutoAccept.command = 'autoAntigravity.toggleAutoAccept';
    context.subscriptions.push(statusBarAutoAccept);
    statusBarAutoAccept.show();

    statusBarRalph = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 199);
    statusBarRalph.command = 'autoAntigravity.startRalphLoop';
    context.subscriptions.push(statusBarRalph);
    statusBarRalph.show();

    // ─── Register Commands ────────────────────────────────────────────

    // Auto Accept toggle
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.toggleAutoAccept', () => {
            const enabled = autoAccept.toggle();
            log(`Auto Accept toggled: ${enabled ? 'ON' : 'OFF'}`);
            updateAutoAcceptStatusBar();
            context.globalState.update('autoAntigravity.autoAcceptEnabled', enabled);
            vscode.window.showInformationMessage(
                `AutoAntigravity — Auto Accept: ${enabled ? 'ENABLED ⚡' : 'DISABLED 🔴'}`
            );
        })
    );

    // Ralph Loop start
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.startRalphLoop', async () => {
            if (ralphLoop.getState() === LoopState.RUNNING) {
                // If already running, toggle to stop
                await ralphLoop.stop();
            } else {
                await ralphLoop.start();
            }
            updateRalphStatusBar();
        })
    );

    // Ralph Loop stop
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.stopRalphLoop', async () => {
            await ralphLoop.stop();
            updateRalphStatusBar();
        })
    );


    // Select task file
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.selectTaskFile', async () => {
            await ralphLoop.selectTaskFile();
            if (sidebarProvider) sidebarProvider.updateState();
        })
    );

    // Git Push Now
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.pushNow', async () => {
            if (ralphLoop && typeof ralphLoop.pushNow === 'function') {
                await ralphLoop.pushNow();
            }
        })
    );

    // Telegram Connect / Disconnect Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.connectTelegram', async () => {
            if (telegramService) {
                vscode.window.showInformationMessage(t('ext.tg_already_connected'));
            } else {
                connectTelegram(context);
                if (telegramService) {
                    vscode.window.showInformationMessage(t('ext.tg_connected'));
                } else {
                    vscode.window.showErrorMessage(t('ext.tg_connect_failed'));
                }
            }
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('autoAntigravity.disconnectTelegram', async () => {
            disconnectTelegram();
            vscode.window.showInformationMessage(t('ext.tg_disconnected'));
        })
    );

    // ─── Initial StatusBar Update (immediate, before CDP check) ─────
    updateAutoAcceptStatusBar();
    updateRalphStatusBar();

    // ─── CDP Check & Restore State ────────────────────────────────────
    autoAccept.checkAndFixCDP(context.extensionMode).then(() => {
        // Restore Auto Accept state (CDP 유무와 무관하게 복원 — soft-fail 방식)
        if (context.globalState.get('autoAntigravity.autoAcceptEnabled', false)) {
            autoAccept.enable();
            log('[AutoAccept] 이전 ON 상태 복원됨');
        }
        updateAutoAcceptStatusBar();
        updateRalphStatusBar();
        log('AutoAntigravity activated successfully');
    }).catch(err => {
        log(`CDP check error: ${err.message} — continuing with status bar visible`);
        // 에러 발생 시에도 상태 복원 시도
        if (context.globalState.get('autoAntigravity.autoAcceptEnabled', false)) {
            autoAccept.enable();
        }
        updateAutoAcceptStatusBar();
        updateRalphStatusBar();
    });
}

function deactivate() {
    if (telegramService) telegramService.dispose();
    if (telemetryService) telemetryService.dispose();
    if (autoAccept) autoAccept.dispose();
    if (ralphLoop) ralphLoop.dispose();
    if (outputChannel) outputChannel.dispose();
}

module.exports = { activate, deactivate };
