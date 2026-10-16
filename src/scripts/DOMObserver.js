// AutoAntigravity — DOM Observer Payload
// Generates a self-contained script injected ONCE per CDP session.
// Uses MutationObserver for zero-polling, event-driven button clicking.

/**
 * Generates the MutationObserver-based DOM clicker script.
 * @param {string[]} customTexts - Additional button texts from user config
 * @returns {string} JavaScript source to evaluate via CDP Runtime.evaluate
 */
function buildDOMObserverScript(customTexts) {
    const allTexts = [
        'run all', '모두 실행', '항상 실행', '전부 실행', 'all run', 'run all commands',
        'run', '실행', '実行', '运行', 'ausführen', 'ejecutar', 'exécuter',
        'accept', '수락', '承認', '接受',
        'always allow', '항상 허용', '常に許可', '始终允许',
        'allow this conversation', '이 대화 허용', 'この会話を許可', '允许此对话',
        'allow', '허용', '許可', '允许',
        'retry', '재시도', '再試行', '重试',
        'continue', '계속', '続行', '继续',
        'ok', '확인', 'OK',
        'confirm', '승인', '확인',
        'approve', '승인',
        'yes', '예', 'はい', '是',
        'submit', '제출', '送信', '提交', 'enviar',
        'proceed', '진행', '進行', 'proceder',
        'allow once', '한 번 허용', '1回許可', 'permitir una vez', 'permitir esta vez',
        'permitir', 'permitir siempre', 'permitir todo',
        'ejecutar', 'ejecutar todo', 'ejecutar en terminal', 'run in terminal', 'terminal run',
        'aceptar', 'aprobar', 'allow always',
        ...customTexts
    ];
    const expandTexts = [
        'expand', '확장', '展開', '展开',
        'requires input', '입력 필요', '入力が必要です', '需要输入'
    ];

    return `
(function() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return 'not-a-browser-window';
    
    // Support hot-reloading for extension debug (F5) sessions!
    if (window.__AA_OBSERVER_ACTIVE && typeof window.__AA_CLEANUP === 'function') {
        try { window.__AA_CLEANUP(); } catch(e) {}
    }
    window.__AA_OBSERVER_ACTIVE = true;

    function isAgentPanel() {
        var urlCheck = !!(location.href.includes('webview') || 
            location.href.includes('agent') || 
            location.href.includes('jetski') || 
            location.href.includes('workbench.html') || 
            location.href.includes('antigravity'));
            
        if (urlCheck) return 'Matched URL: ' + location.href;

        var selectors = ['.react-app-container', '[class*="agent"]', '[class*="webview"]', 
                         '[class*="chat"]', '[class*="composer"]', '[class*="antigravity"]', 
                         '[data-vscode-context]', '.vscode-body', '.monaco-workbench'];
        
        for (var s = 0; s < selectors.length; s++) {
            if (document.querySelector(selectors[s])) return 'Matched selector: ' + selectors[s];
        }

        // Generic VS Code theme markers
        var bodyClass = document.body.className || '';
        if (bodyClass.includes('vscode-') || bodyClass.includes('monaco-')) return 'Matched bodyClass: ' + bodyClass;
        
        // Final fallback for workbench targets: always scan if we attached successfully
        if (location.href.includes('workbench')) return 'Workbench fallback';

        try {
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                var cDoc = iframes[i].contentDocument;
                if (cDoc && cDoc.body) {
                    for (var s = 0; s < selectors.length; s++) {
                        if (cDoc.querySelector(selectors[s])) return 'Matched iframe selector: ' + selectors[s];
                    }
                    var iBodyClass = cDoc.body.className || '';
                    if (iBodyClass.includes('vscode-') || iBodyClass.includes('monaco-')) return 'Matched iframeBodyClass: ' + iBodyClass;
                }
            }
        } catch(e) {}
        return false;
    }

    var BUTTON_TEXTS = ${JSON.stringify(allTexts)};
    var EXPAND_TEXTS = ${JSON.stringify(expandTexts)};
    var COOLDOWN_MS = 5000;
    var EXPAND_COOLDOWN_MS = 8000;
    var clickCooldowns = {};

    function _domPath(el) {
        var parts = [];
        var curr = el;
        for (var i = 0; i < 4 && curr && curr !== document.body; i++) {
            var idx = 0;
            var child = curr.parentElement ? curr.parentElement.firstElementChild : null;
            while (child) {
                if (child === curr) break;
                idx++;
                child = child.nextElementSibling;
            }
            parts.unshift((curr.tagName || '') + '[' + idx + ']');
            curr = curr.parentElement;
        }
        return parts.join('/');
    }

    function closestClickable(node) {
        var el = node;
        while (el && el !== document.body) {
            var tag = (el.tagName || '').toLowerCase();
            if (tag === 'button' || tag.includes('button') || tag.includes('btn') ||
                el.getAttribute('role') === 'button' || el.classList.contains('cursor-pointer') ||
                el.onclick || el.getAttribute('tabindex') === '0') {
                return el;
            }
            el = el.parentElement;
        }
        return node;
    }

    function isVisible(el) {
        if (!el) return false;
        try {
            var style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                return false;
            }
            
            // Allow background/inactive webview targets to pass visibility check 
            // so parallel tasks can continue to click buttons even when the tab is hidden.
            var href = window.location.href || '';
            if (href.indexOf('webview') !== -1 || href.indexOf('agent') !== -1 || href.indexOf('jetski') !== -1) {
                return true;
            }

            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (e) {
            return false;
        }
    }

    function findMatchingButton(root, actionTexts, expandTexts) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        var node;
        var ALL_TEXTS = actionTexts.concat(expandTexts);

        while ((node = walker.nextNode())) {
            var nodeTag = (node.tagName || '').toLowerCase();
            
            if (node.shadowRoot) {
                var result = findMatchingButton(node.shadowRoot, actionTexts, expandTexts);
                if (result) return result;
            }
            if (nodeTag === 'iframe') {
                try {
                    if (node.contentDocument && node.contentDocument.body) {
                        var iframeResult = findMatchingButton(node.contentDocument.body, actionTexts, expandTexts);
                        if (iframeResult) return iframeResult;
                    }
                } catch(e) {}
            }

            var nodeText = (node.textContent || '').trim().toLowerCase();
            var nodeTitle = (node.getAttribute('title') || '').trim().toLowerCase();
            var nodeAria = (node.getAttribute('aria-label') || '').trim().toLowerCase();
            
            // Check data-testid and data-action first (high confidence)
            var testId = (node.getAttribute('data-testid') || node.getAttribute('data-action') || '').toLowerCase();
            if (testId.includes('alwaysallow') || testId.includes('always-allow') || testId.includes('allow')) {
                if (nodeTag === 'button' || nodeTag.includes('button') || node.getAttribute('role') === 'button' || nodeTag.includes('btn')) {
                    var clickableQuick = closestClickable(node);
                    if (clickableQuick && !clickableQuick.disabled && clickableQuick.getAttribute('aria-disabled') !== 'true' && !clickableQuick.classList.contains('loading') && !clickableQuick.querySelector('.codicon-loading')) {
                        return { node: clickableQuick, text: 'allow', isExpand: false };
                    }
                }
            }

            if (!nodeText && !nodeTitle && !nodeAria) continue;

            var matchFound = null;
            var isExpandMatch = false;

            for (var i = 0; i < ALL_TEXTS.length; i++) {
                var text = ALL_TEXTS[i];
                var tests = [nodeText];
                if (nodeTitle) tests.push(nodeTitle);
                if (nodeAria) tests.push(nodeAria);

                var isMatch = tests.some(function(t) {
                    if (!t || t.length > 60) return false;
                    if (t === text) return true;
                    if (t.startsWith(text)) {
                        // For short keywords (CJK or 'run'), match if next char is non-alphanumeric
                        if (text.length < 5) {
                            var nextChar = t[text.length];
                            return !nextChar || !/[a-zA-Z0-9]/.test(nextChar);
                        }
                        // For longer keywords, allow some suffix (e.g. 'always allow this')
                        return t.length <= text.length * 3;
                    }
                    return false;
                });

                if (isMatch) {
                    matchFound = text;
                    isExpandMatch = i >= actionTexts.length;
                    break;
                }
            }

            if (matchFound) {
                var clickable = closestClickable(node);
                var tag2 = (clickable.tagName || '').toLowerCase();

                // Safety filter to prevent unintended IDE interactions
                var RUN_KEYWORDS = ['run', '실행', '実行', '运行'];
                var isRunKeyword = RUN_KEYWORDS.indexOf(matchFound) !== -1;
                var ancestor = clickable;
                var shouldExclude = false;
                
                for (var depth = 0; depth < 15 && ancestor && ancestor !== document.body; depth++) {
                    var cls = (ancestor.className || '').toLowerCase();
                    var id = (ancestor.id || '').toLowerCase();
                    
                    // Global exclusion: NEVER auto-click anything in Quick Pick, Debug Toolbar, Debug Sidebar, or Status Bar
                    // This fixes unintended periodic debugging (e.g. clicking "Run Extension" in Quick Pick or "Continue" in debug toolbar)
                    if (cls.includes('quick-input-widget') || 
                        cls.includes('debug-toolbar') || 
                        cls.includes('debug-viewlet') ||
                        cls.includes('debug-action') ||
                        id.includes('workbench.parts.debug') ||
                        id.includes('workbench.view.debug') ||
                        id.includes('workbench.parts.statusbar')) {
                        shouldExclude = true;
                        break;
                    }
                    
                    // Strict exclusions for short 'run' keywords (to avoid IDE run buttons)
                    if (isRunKeyword) {
                        if (cls.includes('terminal') || cls.includes('run-command') ||
                            cls.includes('editor-toolbar') || cls.includes('editor-actions') ||
                            cls.includes('title-actions') || cls.includes('menubar') ||
                            id.includes('terminal') || id.includes('workbench.parts.editor')) {
                            shouldExclude = true;
                            break;
                        }
                    }
                    ancestor = ancestor.parentElement;
                }
                
                if (shouldExclude) {
                    continue;
                }
                
                var isValidButton = tag2 === 'button' || tag2.includes('button') || clickable.getAttribute('role') === 'button' ||
                    tag2.includes('btn') || clickable.classList.contains('cursor-pointer') ||
                    clickable.onclick || clickable.getAttribute('tabindex') === '0' ||
                    matchFound === 'expand' || matchFound === 'requires input';
                
                if (isValidButton) {
                    if (clickable.disabled || clickable.getAttribute('aria-disabled') === 'true' ||
                        clickable.classList.contains('loading') || clickable.querySelector('.codicon-loading')) {
                        continue;
                    }

                    if (!isVisible(clickable)) {
                        continue;
                    }
                    
                    var btnKey = _domPath(clickable) + ':' + (clickable.textContent || '').trim().toLowerCase().substring(0, 30);
                    var cooldown = isExpandMatch ? EXPAND_COOLDOWN_MS : COOLDOWN_MS;
                    var lastClick = clickCooldowns[btnKey] || 0;
                    if (lastClick && (Date.now() - lastClick < cooldown)) {
                        continue;
                    }
                    return { node: clickable, text: matchFound, isExpand: isExpandMatch };
                }
            }
        }
        return null;
    }

    var lastPrune = Date.now();
    var PRUNE_INTERVAL_MS = 30000;

    function pruneCooldowns() {
        var now = Date.now();
        if (now - lastPrune < PRUNE_INTERVAL_MS) return;
        lastPrune = now;
        var maxAge = EXPAND_COOLDOWN_MS * 2;
        var keys = Object.keys(clickCooldowns);
        for (var i = 0; i < keys.length; i++) {
            if (now - clickCooldowns[keys[i]] > maxAge) {
                delete clickCooldowns[keys[i]];
            }
        }
    }

    // Fallback: querySelectorAll('button') approach for buttons that TreeWalker might miss
    // after IDE updates that change DOM structure, shadow DOM boundaries, etc.
    function findButtonByQuerySelector(actionTexts) {
        try {
            var buttons = document.querySelectorAll('button');
            for (var i = 0; i < buttons.length; i++) {
                var btn = buttons[i];
                var btnText = (btn.textContent || '').trim().toLowerCase();
                if (!btnText || btnText.length > 50 || btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
                if (btn.classList.contains('loading') || btn.querySelector('.codicon-loading')) continue;

                for (var j = 0; j < actionTexts.length; j++) {
                    if (btnText === actionTexts[j] || btnText.includes(actionTexts[j])) {
                        var key = _domPath(btn) + ':' + btnText.substring(0, 30);
                        var lastClick = clickCooldowns[key] || 0;
                        if (lastClick && (Date.now() - lastClick < COOLDOWN_MS)) continue;
                        return btn;
                    }
                }
            }
        } catch(e) {}
        return null;
    }

    function handleInteractiveQuestions() {
        try {
            var allBtns = document.querySelectorAll('button');
            for (var i = 0; i < allBtns.length; i++) {
                var btn = allBtns[i];
                var t = (btn.textContent || '').trim().toLowerCase();
                if (t === 'submit' || t === 'enviar' || t === 'proceed' || t === 'continuar') {
                    var container = btn.closest('form, [role="dialog"], .interactive-question, [class*="question"]') || btn.parentElement;
                    if (container) {
                        var radios = container.querySelectorAll('input[type="radio"], [role="radio"]');
                        if (radios.length > 0) {
                            var anyChecked = false;
                            for (var r = 0; r < radios.length; r++) {
                                if (radios[r].checked || radios[r].getAttribute('aria-checked') === 'true') {
                                    anyChecked = true;
                                    break;
                                }
                            }
                            if (!anyChecked) {
                                radios[0].click();
                            }
                        }
                    }
                }
            }
        } catch(e) {}
    }

    function scanAndClick() {
        handleInteractiveQuestions();
        pruneCooldowns();
        var match = findMatchingButton(document.body, BUTTON_TEXTS, EXPAND_TEXTS);
        if (match) {
            var btn = match.node;
            var key = _domPath(btn) + ':' + (btn.textContent || '').trim().toLowerCase().substring(0, 30);
            clickCooldowns[key] = Date.now();
            btn.click();
            try { console.log('[AA_LOG] [AutoAccept] Aprobado: ' + match.text); } catch(e){}
            return 'clicked:' + match.text;
        }

        // Fallback: if TreeWalker-based findButton missed, try querySelectorAll approach
        var fallbackBtn = findButtonByQuerySelector(BUTTON_TEXTS);
        if (fallbackBtn) {
            var key2 = _domPath(fallbackBtn) + ':' + (fallbackBtn.textContent || '').trim().toLowerCase().substring(0, 30);
            clickCooldowns[key2] = Date.now();
            fallbackBtn.click();
            return 'clicked-fallback:' + (fallbackBtn.textContent || '').trim().toLowerCase();
        }
        return null;
    }

    // Expose for CDP-driven active polling (bypass inactive tab throttling)
    window.__AA_FORCE_SCAN = scanAndClick;

    // Only run initial scan if this is an agent panel
    if (isAgentPanel()) scanAndClick();

    // Use a 1-second throttle for DOM mutation scans. 
    // This prevents massive CPU usage inside workbench.html (main VS Code window)
    // where mutations happen on every keystroke. 
    var lastScanTime = 0;
    var scanTimeout = null;
    var SCAN_THROTTLE_MS = 1000;

    function queueScan() {
        if (scanTimeout) return;
        var now = Date.now();
        var delay = Math.max(0, SCAN_THROTTLE_MS - (now - lastScanTime));
        scanTimeout = setTimeout(function() {
            scanTimeout = null;
            lastScanTime = Date.now();
            scanAndClick();
        }, delay);
    }

    var observer = new MutationObserver(function() {
        // Only trigger the throttle queue if it matches our panel heuristics.
        if (!isAgentPanel()) return;
        queueScan();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Fallback: periodic scan every 4s using setInterval as a safety net.
    // Even if setInterval is throttled in background tabs, it still fires.
    var fallbackTimer = setInterval(function() {
        scanAndClick();
    }, 4000);

    // Cleanup function — called via CDP when AutoAccept is disabled.
    // Disconnects MutationObserver, clears interval, and resets flags
    // so that the injected script no longer consumes CPU.
    window.__AA_CLEANUP = function() {
        observer.disconnect();
        clearInterval(fallbackTimer);
        window.__AA_OBSERVER_ACTIVE = false;
        window.__AA_FORCE_SCAN = null;
        window.__AA_CLEANUP = null;
        return 'cleaned-up';
    };

    return 'observer-installed';
})()
`;
}

module.exports = { buildDOMObserverScript };
