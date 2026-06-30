/**
 * WAP Chat Widget — Vanilla JS SSE streaming chat client.
 *
 * No framework, no jQuery. The entire UI is composed from Gravity (group-one
 * brand) UI components — see wap-chat.css header for the component list.
 *
 * Communicates with the WAP backend via:
 *   - Server-sent Events (POST /api/v1/chat/stream) for streaming responses.
 *   - WordPress AJAX (admin-ajax.php) for server-side auth and GDPR erasure.
 *   - Direct fetch (GET /api/v1/chat/{conversation_id}/history) for history.
 *
 * Expects WapClientConfig to be localised into the page by PHP.
 *
 * @package GroupOne\WapClient
 * @version 1.1.1
 */

/* global WapClientConfig, fetch, AbortController, TextDecoder */

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Config (provided by wp_localize_script in class-chat-widget.php)
    // -------------------------------------------------------------------------

    let cfg = window.WapClientConfig || {};
    let i18n = cfg.i18n || {};

    const ICON_BASE = 'https://gravity.group-cdn.one/v5.40.0/icons/';

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    let sessionToken = cfg.sessionToken || '';
    let authPromise = null;
    let currentAbortController = null;
    let isStreaming = false;
    let accCounter = 0;
    let hasMessages = false;

    // -------------------------------------------------------------------------
    // DOM references — resolved after DOMContentLoaded.
    // -------------------------------------------------------------------------

    let rootEl, chatEl, chatListEl, inputEl, sendBtn, indicatorDotEl, statusTextEl, deleteDataBtn;

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    document.addEventListener('DOMContentLoaded', init);

    window.WapChat = window.WapChat || {};
    window.WapChat.init = init;

    function init() {
        rootEl = document.getElementById('wap-chat-root');
        if (!rootEl) return;

        cfg = window.WapClientConfig || {};
        i18n = cfg.i18n || {};

        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
        }
        sessionToken = cfg.sessionToken || '';
        isStreaming = false;
        hasMessages = false;

        buildUI();
        wireEvents();
        showWelcome();

        authenticate(false).then(function () { loadHistory(); }).catch(function () {});
    }

    // -------------------------------------------------------------------------
    // UI construction — all Gravity components
    // -------------------------------------------------------------------------

    function buildUI() {
        rootEl.innerHTML = '';
        rootEl.classList.add('gv-activated');

        // ---- Header: gv-text-indicator + gv-button --------------------------
        const header = el('div', 'wap-chat__header');

        const statusWrapper = el('div', 'gv-text-indicator');
        indicatorDotEl = el('div', 'gv-indicator gv-state-busy');
        statusTextEl = el('span', '');
        statusTextEl.textContent = i18n.reconnecting || 'Connecting…';
        statusWrapper.appendChild(indicatorDotEl);
        statusWrapper.appendChild(statusTextEl);
        header.appendChild(statusWrapper);

        deleteDataBtn = el('button', 'gv-button gv-button-secondary gv-mode-condensed');
        deleteDataBtn.type = 'button';
        deleteDataBtn.textContent = i18n.deleteData || 'Delete my data';
        deleteDataBtn.setAttribute('aria-label', i18n.deleteData || 'Delete my data');
        header.appendChild(deleteDataBtn);

        // ---- gv-chat: list + footer -----------------------------------------
        chatEl = el('section', 'gv-chat');
        chatEl.setAttribute('role', 'log');
        chatEl.setAttribute('aria-live', 'polite');

        chatListEl = el('div', 'gv-chat-list');
        chatListEl.setAttribute('aria-label', 'Chat messages');

        const footer = el('footer', '');
        const footerInner = el('div', 'gv-chat-footer');

        // gv-input-ai composer: toolbar (with send button) + textarea.
        const inputAi = el('div', 'gv-input-ai');
        const inputBox = el('div', 'gv-input gv-input-textarea');

        const toolbar = el('div', 'gv-input-toolbar');
        const toolbarEnd = el('div', 'gv-toolbar-end');

        sendBtn = el('button', 'gv-button gv-button-primary gv-button-icon');
        sendBtn.type = 'button';
        sendBtn.setAttribute('aria-label', i18n.send || 'Send');
        sendBtn.title = i18n.send || 'Send';
        sendBtn.appendChild(gvIcon(ICON_BASE + 'send.svg'));
        toolbarEnd.appendChild(sendBtn);
        toolbar.appendChild(toolbarEnd);

        inputEl = el('textarea', '');
        inputEl.setAttribute('rows', '1');
        inputEl.setAttribute('placeholder', i18n.placeholder || 'Ask the AI assistant…');
        inputEl.setAttribute('aria-label', i18n.placeholder || 'Ask the AI assistant…');

        // Textarea first so the text starts at the top of the box; the toolbar
        // (with the send button) sits at the bottom-right corner.
        inputBox.appendChild(inputEl);
        inputBox.appendChild(toolbar);
        inputAi.appendChild(inputBox);
        footerInner.appendChild(inputAi);
        footer.appendChild(footerInner);

        chatEl.appendChild(chatListEl);
        chatEl.appendChild(footer);

        rootEl.appendChild(header);
        rootEl.appendChild(chatEl);
    }

    function wireEvents() {
        sendBtn.addEventListener('click', handleSend);

        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });

        inputEl.addEventListener('input', autoGrow);
        deleteDataBtn.addEventListener('click', handleDeleteData);
    }

    function autoGrow() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    }

    // -------------------------------------------------------------------------
    // Welcome / empty state — greeting message + gv-chip suggestions
    // -------------------------------------------------------------------------

    function showWelcome() {
        if (hasMessages || chatListEl.querySelector('.wap-welcome')) return;

        const msg = el('div', 'gv-chat-message gv-chat-incoming wap-welcome');
        const body = el('div', 'gv-chat-message-body');
        body.textContent = i18n.welcomeSubtitle || 'Hi! Ask me anything about your site, content, or settings.';
        msg.appendChild(body);
        chatListEl.appendChild(msg);

        const suggestions = Array.isArray(cfg.suggestions) ? cfg.suggestions : [];
        if (suggestions.length) {
            const row = el('div', 'wap-chat__suggestions wap-welcome');
            suggestions.slice(0, 4).forEach(function (text) {
                const chip = el('button', 'gv-chip');
                chip.type = 'button';
                chip.textContent = text;
                chip.addEventListener('click', function () {
                    inputEl.value = text;
                    autoGrow();
                    handleSend();
                });
                row.appendChild(chip);
            });
            chatListEl.appendChild(row);
        }
    }

    function clearWelcome() {
        chatListEl.querySelectorAll('.wap-welcome').forEach(function (n) { n.remove(); });
    }

    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------

    let pendingForceNew = false;

    function authenticate(forceNew) {
        if (forceNew) pendingForceNew = true;
        if (authPromise) return authPromise;

        var useForceNew = pendingForceNew;
        pendingForceNew = false;

        setStatus('connecting');

        const request = cfg.authStrategy === 'direct'
            ? authRequestDirect(useForceNew)
            : authRequestWordPress(useForceNew);

        authPromise = request
            .then(function (res) { return res.json(); })
            .then(function (json) {
                const data = json.success === false
                    ? throwAuthError(json)
                    : (json.data || json);
                if (!data || !data.token) {
                    throw new Error(i18n.errorGeneric || 'Auth failed');
                }
                sessionToken = data.token;
                if (data.conversationId) cfg.conversationId = data.conversationId;
                setStatus('connected');
                return sessionToken;
            })
            .catch(function (err) {
                sessionToken = '';
                setStatus('error');
                appendErrorMessage(err.message || (i18n.errorGeneric || 'Could not connect.'));
                throw err;
            })
            .finally(function () { authPromise = null; });

        return authPromise;
    }

    function throwAuthError(json) {
        throw new Error(
            json.data && json.data.message
                ? json.data.message
                : (i18n.errorGeneric || 'Auth failed')
        );
    }

    function authRequestWordPress(forceNew) {
        const data = new URLSearchParams({
            action:      'wap_client_auth',
            _ajax_nonce: cfg.authNonce || '',
            product:     cfg.product || '',
            menu_slug:   cfg.menuSlug || '',
            force_new:   forceNew ? '1' : '0',
        });

        return fetch(cfg.ajaxUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    data.toString(),
        });
    }

    function authRequestDirect(forceNew) {
        const body = {
            product:            cfg.product || '',
            mode:               cfg.mode || 'product',
            mcp_endpoint:       cfg.mcpEndpoint || '',
            wp_username:        cfg.wpUsername || '',
            wp_app_password:    cfg.wpAppPassword || '',
            site_url:           cfg.siteUrl || '',
            available_products: cfg.availableProducts || [],
            force_new:          !!forceNew,
        };
        if (cfg.pageContext) body.page_context = cfg.pageContext;

        return fetch(cfg.authEndpoint, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
    }

    // -------------------------------------------------------------------------
    // History
    // -------------------------------------------------------------------------

    function loadHistory() {
        if (!sessionToken || !cfg.conversationId) return;

        const url = cfg.wapBrowserUrl.replace(/\/$/, '') +
            '/api/v1/chat/' + encodeURIComponent(cfg.conversationId) + '/history';

        fetch(url, {
            headers: { Authorization: 'Bearer ' + sessionToken },
        })
            .then(function (res) {
                if (res.status === 401) {
                    return authenticate(true).then(function () { loadHistory(); });
                }
                return res.json();
            })
            .then(function (data) {
                if (!data || !Array.isArray(data.messages) || !data.messages.length) return;

                clearWelcome();
                data.messages.forEach(function (msg) {
                    if (msg.role === 'user') {
                        appendUserMessage(msg.content || '');
                    } else if (msg.role === 'assistant') {
                        appendAssistantMessage(msg.content || '');
                    }
                });

                setStatus('connected');
                scrollToBottom();
            })
            .catch(function () {
                setStatus('connected');
            });
    }

    // -------------------------------------------------------------------------
    // Sending messages
    // -------------------------------------------------------------------------

    function handleSend() {
        const message = inputEl.value.trim();
        if (!message || isStreaming) return;

        inputEl.value = '';
        inputEl.style.height = 'auto';

        clearWelcome();
        appendUserMessage(message);

        if (!sessionToken) {
            authenticate(false).then(function () { sendMessage(message); });
        } else {
            sendMessage(message);
        }
    }

    function sendMessage(message) {
        isStreaming = true;
        setSendDisabled(true);

        currentAbortController = new AbortController();

        const assistantEl = appendAssistantPlaceholder();

        const url = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/chat/stream';

        const chatBody = { message: message };
        if (cfg.pageContext) {
            chatBody.page_context = cfg.pageContext;
        }

        fetch(url, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                Authorization:   'Bearer ' + sessionToken,
            },
            body:    JSON.stringify(chatBody),
            signal:  currentAbortController.signal,
        })
            .then(function (res) {
                if (res.status === 401) {
                    assistantEl.remove();
                    return authenticate(true).then(function () { sendMessage(message); });
                }
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
                if (!res.body) {
                    throw new Error('ReadableStream not supported');
                }
                return readSSEStream(res.body, assistantEl);
            })
            .catch(function (err) {
                if (err.name === 'AbortError') return;
                appendErrorToAssistant(assistantEl, err.message || (i18n.errorGeneric || 'Stream error'));
            })
            .finally(function () {
                isStreaming = false;
                setSendDisabled(false);
                scrollToBottom();
            });
    }

    // -------------------------------------------------------------------------
    // SSE stream reader
    // -------------------------------------------------------------------------

    function readSSEStream(body, assistantEl) {
        const reader   = body.getReader();
        const decoder  = new TextDecoder();
        let   buffer   = '';
        let   textNode = null;
        let   rawText  = '';

        const bodyEl = getBody(assistantEl);

        function getOrCreateTextNode() {
            if (!textNode) {
                textNode = bodyEl;
                textNode.innerHTML = '';
            }
            return textNode;
        }

        function processEvent(event) {
            switch (event.type) {
                case 'message_start':
                    if (event.conversationId) cfg.conversationId = event.conversationId;
                    break;

                case 'routing':
                    if (event.routing === 'multi') {
                        textNode = null;
                        rawText = '';
                        removeLoader(bodyEl);
                        const routingEl = el('div', 'gv-stream-loader');
                        const step = el('div', 'gv-step-working');
                        step.textContent = 'Consulting multiple specialists…';
                        routingEl.appendChild(step);
                        assistantEl.appendChild(routingEl);
                    }
                    break;

                case 'text_delta':
                    if (event.delta) {
                        removeLoader(bodyEl);
                        rawText += event.delta;
                        getOrCreateTextNode().innerHTML = renderMarkdown(rawText);
                        scrollToBottom();
                    }
                    break;

                case 'tool_use':
                    textNode = null;
                    rawText = '';
                    removeLoader(bodyEl);
                    appendToolUse(assistantEl, event.tool || '', event.input || {});
                    break;

                case 'tool_result':
                    appendToolResult(assistantEl, event.tool || '', event.output || '');
                    textNode = null;
                    rawText = '';
                    break;

                case 'message_end':
                    removeLoader(bodyEl);
                    break;

                case 'error':
                    appendErrorToAssistant(assistantEl, event.message || (i18n.errorGeneric || 'Error'));
                    break;

                default:
                    break;
            }
        }

        function parseChunk(chunk) {
            buffer += chunk;
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';

            for (let ei = 0; ei < events.length; ei++) {
                const lines = events[ei].split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line === 'data: [DONE]') return true;
                    if (line.startsWith('data: ')) {
                        try {
                            processEvent(JSON.parse(line.slice(6)));
                        } catch (e) { /* malformed — skip */ }
                    }
                }
            }
            return false;
        }

        function pump() {
            return reader.read().then(function (result) {
                if (result.done) return;
                var done = parseChunk(decoder.decode(result.value, { stream: true }));
                if (done) { reader.cancel(); return; }
                return pump();
            });
        }

        return pump();
    }

    // -------------------------------------------------------------------------
    // Message DOM builders — Gravity gv-chat-message structure
    // -------------------------------------------------------------------------

    function getBody(msgEl) {
        return msgEl.querySelector('.gv-chat-message-body');
    }

    function makeMessage(direction, label) {
        const msg = el('div', 'gv-chat-message ' + (direction === 'user' ? 'gv-chat-outgoing' : 'gv-chat-incoming'));

        if (label) {
            const meta = el('div', 'gv-meta');
            const user = el('span', 'gv-meta-user');
            user.textContent = label;
            meta.appendChild(user);
            msg.appendChild(meta);
        }

        const body = el('div', 'gv-chat-message-body');
        msg.appendChild(body);
        return msg;
    }

    function appendUserMessage(text) {
        hasMessages = true;
        const msg = makeMessage('user', '');
        getBody(msg).textContent = text;
        chatListEl.appendChild(msg);
        scrollToBottom();
        return msg;
    }

    function appendAssistantPlaceholder() {
        hasMessages = true;
        const msg = makeMessage('assistant', i18n.assistantName || '');
        const loader = el('div', 'gv-stream-loader');
        const step = el('div', 'gv-step-working');
        step.textContent = i18n.thinking || 'Thinking…';
        loader.appendChild(step);
        getBody(msg).appendChild(loader);
        chatListEl.appendChild(msg);
        scrollToBottom();
        return msg;
    }

    function appendAssistantMessage(text) {
        hasMessages = true;
        const msg = makeMessage('assistant', i18n.assistantName || '');
        getBody(msg).innerHTML = renderMarkdown(text);
        chatListEl.appendChild(msg);
        return msg;
    }

    function removeLoader(container) {
        const loader = container.querySelector('.gv-stream-loader');
        if (loader) loader.remove();
    }

    function appendErrorToAssistant(assistantEl, errorMessage) {
        const bodyEl = getBody(assistantEl);
        removeLoader(bodyEl);
        // Also clear any sibling routing loader.
        removeLoader(assistantEl);

        const notice = el('div', 'gv-notice gv-notice-alert gv-mode-condensed');
        const content = el('p', 'gv-notice-content');
        content.textContent = errorMessage;
        notice.appendChild(gvIcon(ICON_BASE + 'error.svg', 'gv-notice-icon'));
        notice.appendChild(content);
        bodyEl.appendChild(notice);
    }

    function appendErrorMessage(errorMessage) {
        clearWelcome();
        const msg = el('div', 'gv-chat-message gv-chat-incoming');
        msg.setAttribute('role', 'alert');

        const notice = el('div', 'gv-notice gv-notice-alert gv-mode-condensed');
        const content = el('p', 'gv-notice-content');
        content.textContent = errorMessage;
        notice.appendChild(gvIcon(ICON_BASE + 'error.svg', 'gv-notice-icon'));
        notice.appendChild(content);
        msg.appendChild(notice);

        chatListEl.appendChild(msg);
        scrollToBottom();
    }

    // -------------------------------------------------------------------------
    // Tool-use cards — gv-accordion
    // -------------------------------------------------------------------------

    function appendToolUse(assistantEl, toolName, toolInput) {
        accCounter++;
        const triggerId = 'wap-acc-trigger-' + accCounter;
        const bodyId    = 'wap-acc-body-' + accCounter;

        const accordion = el('div', 'gv-accordion');
        accordion.dataset.tool = toolName;

        const item   = el('div', 'gv-acc-item');
        const header = el('h4', 'gv-acc-header');

        const trigger = el('button', 'gv-acc-trigger');
        trigger.id = triggerId;
        trigger.type = 'button';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', bodyId);

        const title = el('span', 'gv-acc-title');
        title.textContent = (i18n.actionLabel || 'Action') + ': ' + toolName;
        trigger.appendChild(title);
        header.appendChild(trigger);

        const accBody = el('div', 'gv-acc-body gv-hidden');
        accBody.id = bodyId;
        accBody.setAttribute('role', 'region');
        accBody.setAttribute('aria-labelledby', triggerId);

        trigger.addEventListener('click', function () {
            const expanded = trigger.getAttribute('aria-expanded') === 'true';
            trigger.setAttribute('aria-expanded', String(!expanded));
            trigger.classList.toggle('gv-expanded', !expanded);
            accBody.classList.toggle('gv-hidden', expanded);
        });

        const content    = el('div', 'gv-acc-content');
        const inputPre    = el('pre', 'wap-chat__action-json');
        inputPre.textContent = JSON.stringify(toolInput, null, 2);
        content.appendChild(inputPre);

        accBody.appendChild(content);
        item.appendChild(header);
        item.appendChild(accBody);
        accordion.appendChild(item);
        assistantEl.appendChild(accordion);
    }

    function appendToolResult(assistantEl, toolName, output) {
        const accordions = assistantEl.querySelectorAll('.gv-accordion[data-tool="' + toolName + '"]');
        const accordion  = accordions.length ? accordions[accordions.length - 1] : null;
        if (!accordion) return;

        const content = accordion.querySelector('.gv-acc-content');
        if (!content) return;

        const resultPre = el('pre', 'wap-chat__action-json');
        resultPre.textContent = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        content.appendChild(resultPre);

        const title = accordion.querySelector('.gv-acc-title');
        if (title && !title.dataset.done) {
            title.dataset.done = '1';
            title.textContent = '✓ ' + title.textContent;
        }
    }

    // -------------------------------------------------------------------------
    // GDPR
    // -------------------------------------------------------------------------

    function handleDeleteData() {
        const confirmed = window.confirm(
            i18n.deleteConfirm ||
            'This will permanently delete all your conversation history. Continue?'
        );
        if (!confirmed) return;

        if (!sessionToken) {
            appendErrorMessage(i18n.errorGeneric || 'Not connected. Please refresh and try again.');
            return;
        }

        const backendUrl = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/me/data/erase';

        fetch(backendUrl, {
            method:  'POST',
            headers: {
                Authorization:  'Bearer ' + sessionToken,
                'Content-Type': 'application/json',
            },
        })
            .then(function (res) {
                if (res.status === 401) return;
                if (!res.ok) throw new Error('HTTP ' + res.status);
            })
            .then(function () {
                if (cfg.authStrategy === 'direct') return null;

                const data = new URLSearchParams({
                    action:      'wap_client_delete_data',
                    _ajax_nonce: cfg.deleteDataNonce || '',
                });
                return fetch(cfg.ajaxUrl, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body:    data.toString(),
                }).then(function (res) { return res.json(); });
            })
            .then(function (json) {
                if (json && json.success === false) {
                    throw new Error(json.data && json.data.message ? json.data.message : (i18n.errorGeneric || 'Delete failed'));
                }

                sessionToken = '';
                hasMessages = false;

                chatListEl.innerHTML = '';

                const notice  = el('div', 'gv-notice gv-notice-success');
                notice.setAttribute('role', 'status');
                const content = el('p', 'gv-notice-content');
                content.textContent = i18n.deleteSuccess || 'Your data has been deleted. Reload the page to resume.';
                notice.appendChild(gvIcon(ICON_BASE + 'check.svg', 'gv-notice-icon'));
                notice.appendChild(content);
                chatListEl.appendChild(notice);

                setSendDisabled(true);
                deleteDataBtn.setAttribute('disabled', 'disabled');
            })
            .catch(function (err) {
                appendErrorMessage(err.message || (i18n.errorGeneric || 'Error deleting data.'));
            });
    }

    // -------------------------------------------------------------------------
    // Minimal, safe Markdown renderer
    // -------------------------------------------------------------------------

    function escapeHtml(s) {
        return s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function safeHref(url) {
        return /^(https?:|mailto:)/i.test(url) ? url : '#';
    }

    function inlineMd(text) {
        text = text.replace(/`([^`]+)`/g, function (m, c) { return '<code>' + c + '</code>'; });
        text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
            return '<a href="' + escapeHtml(safeHref(url)) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
        });
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
        text = text.replace(/_([^_]+)_/g, '<em>$1</em>');
        return text;
    }

    // A GFM table separator row: each cell is dashes with optional colons.
    function isTableSeparator(line) {
        const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
        return cells.length > 0 && cells.every(function (c) {
            return /^\s*:?-{1,}:?\s*$/.test(c);
        });
    }

    function splitTableRow(line) {
        return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) {
            return c.trim();
        });
    }

    function renderMarkdown(src) {
        if (!src) return '';
        const escaped = escapeHtml(src); // '>' becomes '&gt;' — handled below.
        const lines = escaped.split('\n');
        let html = '';
        let i = 0;
        let listType = null;

        function closeList() {
            if (listType) { html += '</' + listType + '>'; listType = null; }
        }

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            // Fenced code block
            if (/^```/.test(trimmed)) {
                closeList();
                i++;
                let code = '';
                while (i < lines.length && !/^```/.test(lines[i].trim())) {
                    code += lines[i] + '\n';
                    i++;
                }
                i++;
                html += '<pre><code>' + code.replace(/\n$/, '') + '</code></pre>';
                continue;
            }

            // Horizontal rule
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
                closeList();
                html += '<hr>';
                i++;
                continue;
            }

            // ATX heading (# .. ######)
            const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
            if (hMatch) {
                closeList();
                const level = hMatch[1].length;
                html += '<h' + level + '>' + inlineMd(hMatch[2]) + '</h' + level + '>';
                i++;
                continue;
            }

            // GFM table: header row with pipes, followed by a separator row.
            if (
                line.indexOf('|') !== -1 &&
                i + 1 < lines.length &&
                lines[i + 1].indexOf('|') !== -1 &&
                isTableSeparator(lines[i + 1])
            ) {
                closeList();
                const headers = splitTableRow(line);
                i += 2; // skip header + separator
                let table = '<table><thead><tr>';
                headers.forEach(function (h) { table += '<th>' + inlineMd(h) + '</th>'; });
                table += '</tr></thead><tbody>';
                while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) {
                    const cells = splitTableRow(lines[i]);
                    table += '<tr>';
                    cells.forEach(function (c) { table += '<td>' + inlineMd(c) + '</td>'; });
                    table += '</tr>';
                    i++;
                }
                table += '</tbody></table>';
                html += table;
                continue;
            }

            // Blockquote ('>' was escaped to '&gt;')
            if (/^\s*&gt;\s?/.test(line)) {
                closeList();
                let quote = '';
                while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
                    quote += lines[i].replace(/^\s*&gt;\s?/, '') + '\n';
                    i++;
                }
                html += '<blockquote>' + inlineMd(quote.replace(/\n$/, '')).replace(/\n/g, '<br>') + '</blockquote>';
                continue;
            }

            const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
            const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);

            if (ulMatch) {
                if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
                html += '<li>' + inlineMd(ulMatch[1]) + '</li>';
                i++;
                continue;
            }
            if (olMatch) {
                if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
                html += '<li>' + inlineMd(olMatch[1]) + '</li>';
                i++;
                continue;
            }

            closeList();

            if (line.trim() === '') { i++; continue; }

            let para = line;
            i++;
            while (
                i < lines.length &&
                lines[i].trim() !== '' &&
                !/^```/.test(lines[i].trim()) &&
                !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
                !/^#{1,6}\s+/.test(lines[i].trim()) &&
                !/^\s*&gt;\s?/.test(lines[i]) &&
                lines[i].indexOf('|') === -1 &&
                !/^\s*[-*]\s+/.test(lines[i]) &&
                !/^\s*\d+\.\s+/.test(lines[i])
            ) {
                para += '\n' + lines[i];
                i++;
            }
            html += '<p>' + inlineMd(para).replace(/\n/g, '<br>') + '</p>';
        }

        closeList();
        return html;
    }

    // -------------------------------------------------------------------------
    // UI utilities
    // -------------------------------------------------------------------------

    function el(tag, cls) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        return node;
    }

    function gvIcon(src, cls) {
        const icon = document.createElement('gv-icon');
        icon.setAttribute('src', src);
        icon.setAttribute('aria-hidden', 'true');
        if (cls) icon.className = cls;
        return icon;
    }

    function setStatus(state) {
        if (!indicatorDotEl || !statusTextEl) return;
        const stateMap = {
            connected:  { cls: 'gv-state-positive', label: 'Connected' },
            connecting: { cls: 'gv-state-busy',     label: i18n.reconnecting || 'Connecting…' },
            error:      { cls: 'gv-state-critical', label: 'Disconnected' },
        };
        const s = stateMap[state] || stateMap.connecting;
        indicatorDotEl.className = 'gv-indicator ' + s.cls;
        statusTextEl.textContent = s.label;
    }

    function setSendDisabled(disabled) {
        sendBtn.disabled = disabled;
        inputEl.disabled = disabled;
    }

    function scrollToBottom() {
        if (chatListEl) {
            chatListEl.scrollTop = chatListEl.scrollHeight;
        }
    }

}());
