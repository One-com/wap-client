/**
 * WAP Chat Widget — Vanilla JS SSE streaming chat client.
 *
 * No framework, no jQuery. Communicates with the WAP backend via:
 *   - Server-sent Events (POST /api/v1/chat/stream) for streaming responses.
 *   - WordPress AJAX (admin-ajax.php) for server-side auth and GDPR erasure.
 *   - Direct fetch (GET /api/v1/chat/{conversation_id}/history) for history.
 *
 * Expects WapClientConfig to be localised into the page by PHP.
 *
 * @package GroupOne\WapClient
 * @version 1.0.0
 */

/* global WapClientConfig, EventSource, fetch, AbortController */

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Config (provided by wp_localize_script in class-chat-widget.php)
    // -------------------------------------------------------------------------

    let cfg = window.WapClientConfig || {};
    let i18n = cfg.i18n || {};

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /** @type {string} Active WAP Bearer token. */
    let sessionToken = cfg.sessionToken || '';

    /** @type {Promise<string>|null} In-flight auth promise, shared across concurrent callers. */
    let authPromise = null;

    /** @type {AbortController|null} Controller for the current SSE fetch. */
    let currentAbortController = null;

    /** @type {boolean} Whether we are currently waiting for a response. */
    let isStreaming = false;

    /** @type {number} Counter for generating unique accordion IDs. */
    let accCounter = 0;

    // -------------------------------------------------------------------------
    // DOM references — resolved after DOMContentLoaded.
    // -------------------------------------------------------------------------

    let rootEl, messagesEl, chatListEl, inputEl, sendBtn, indicatorDotEl, statusTextEl, deleteDataBtn;

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    document.addEventListener('DOMContentLoaded', init);

    window.WapChat = window.WapChat || {};
    window.WapChat.init = init;

    /**
     * Initialise the chat widget.
     * Builds the DOM inside #wap-chat-root, loads history, and wires events.
     */
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

        buildUI();
        wireEvents();

        authenticate(false).then(function () { loadHistory(); }).catch(function () {});
    }

    // -------------------------------------------------------------------------
    // UI construction
    // -------------------------------------------------------------------------

    /**
     * Build and inject the chat widget HTML structure using Gravity components.
     */
    function buildUI() {
        rootEl.innerHTML = '';

        // Header bar.
        const header = el('div', 'wap-chat__header');

        // Status indicator — gv-text-indicator with dot states.
        const statusWrapper = el('div', 'gv-text-indicator');
        indicatorDotEl = el('div', 'gv-indicator gv-state-busy');
        statusTextEl = el('span', '');
        statusTextEl.textContent = i18n.reconnecting || 'Connecting…';
        statusWrapper.appendChild(indicatorDotEl);
        statusWrapper.appendChild(statusTextEl);
        header.appendChild(statusWrapper);

        // Delete data button (GDPR) — gv-button secondary condensed.
        deleteDataBtn = el('button', 'gv-button gv-button-secondary gv-mode-condensed');
        deleteDataBtn.type = 'button';
        deleteDataBtn.textContent = i18n.deleteData || 'Delete my data';
        deleteDataBtn.setAttribute('aria-label', i18n.deleteData || 'Delete my data');
        header.appendChild(deleteDataBtn);

        // Messages scroll container.
        messagesEl = el('div', 'wap-chat__messages');
        messagesEl.setAttribute('aria-label', 'Chat messages');

        // gv-chat list inside the scroll container.
        const gvChat = el('section', 'gv-chat');
        chatListEl = el('ul', 'gv-chat-list');
        gvChat.setAttribute('role', 'log');
        gvChat.setAttribute('aria-live', 'polite');
        gvChat.appendChild(chatListEl);
        messagesEl.appendChild(gvChat);

        // Input area.
        const inputArea = el('div', 'wap-chat__input-area');

        // Textarea wrapped in gv-form-option.
        const formOption = el('div', 'gv-form-option wap-chat__textarea-wrap');
        inputEl = el('textarea', 'gv-input gv-input-textarea');
        inputEl.setAttribute('rows', '3');
        inputEl.setAttribute('placeholder', i18n.placeholder || 'Ask the AI assistant…');
        inputEl.setAttribute('aria-label', i18n.placeholder || 'Ask the AI assistant…');
        formOption.appendChild(inputEl);

        // Send button — gv-button primary condensed.
        sendBtn = el('button', 'gv-button gv-button-primary gv-mode-condensed');
        sendBtn.type = 'button';
        sendBtn.textContent = i18n.send || 'Send';
        sendBtn.setAttribute('aria-label', i18n.send || 'Send');

        inputArea.appendChild(formOption);
        inputArea.appendChild(sendBtn);

        rootEl.appendChild(header);
        rootEl.appendChild(messagesEl);
        rootEl.appendChild(inputArea);
    }

    /**
     * Wire DOM event listeners.
     */
    function wireEvents() {
        sendBtn.addEventListener('click', handleSend);

        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSend();
            }
        });

        deleteDataBtn.addEventListener('click', handleDeleteData);
    }

    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------

    /** Whether the next auth call should revoke the stored App Password. */
    let pendingForceNew = false;

    /**
     * Obtain a fresh WAP session token.
     *
     * @param {boolean} forceNew Revoke stored App Password and re-provision.
     * @returns {Promise<string>}
     */
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
                if (!data || !Array.isArray(data.messages)) return;

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
        inputEl.style.height = '';

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

        /**
         * Find or create the text paragraph inside the assistant message.
         * Uses gv-chat-message-body for Gravity chat styling.
         *
         * @returns {HTMLParagraphElement}
         */
        function getOrCreateTextNode() {
            if (!textNode) {
                textNode = el('p', 'gv-chat-message-body');
                assistantEl.appendChild(textNode);
            }
            return textNode;
        }

        function processEvent(event) {
            switch (event.type) {
                case 'message_start':
                    if (event.conversationId) cfg.conversationId = event.conversationId;
                    break;

                case 'routing':
                    if (event.routing) {
                        textNode = null;
                        const routingEl = el('div', 'wap-chat__routing');
                        routingEl.textContent = event.routing === 'multi'
                            ? '⟳ Consulting multiple specialists…'
                            : '';
                        if (routingEl.textContent) {
                            assistantEl.appendChild(routingEl);
                        }
                    }
                    break;

                case 'text_delta':
                    if (event.delta) {
                        const typingEl = assistantEl.querySelector('.wap-chat__typing');
                        if (typingEl) typingEl.remove();
                        getOrCreateTextNode().textContent += event.delta;
                        scrollToBottom();
                    }
                    break;

                case 'tool_use':
                    textNode = null;
                    appendToolUse(assistantEl, event.tool || '', event.input || {});
                    break;

                case 'tool_result':
                    appendToolResult(assistantEl, event.tool || '', event.output || '');
                    textNode = null;
                    break;

                case 'message_end':
                    const doneTyping = assistantEl.querySelector('.wap-chat__typing');
                    if (doneTyping) doneTyping.remove();
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
                            const json = JSON.parse(line.slice(6));
                            processEvent(json);
                        } catch (e) {
                            // Malformed event — skip.
                        }
                    }
                }
            }
            return false;
        }

        function pump() {
            return reader.read().then(function (result) {
                if (result.done) return;
                var done = parseChunk(decoder.decode(result.value, { stream: true }));
                if (done) {
                    reader.cancel();
                    return;
                }
                return pump();
            });
        }

        return pump();
    }

    // -------------------------------------------------------------------------
    // Message DOM builders
    // -------------------------------------------------------------------------

    /**
     * Append a user message — gv-chat-message gv-chat-outgoing.
     *
     * @param {string} text
     * @returns {HTMLLIElement}
     */
    function appendUserMessage(text) {
        const li = el('li', 'gv-chat-message gv-chat-outgoing');
        const p  = el('p', 'gv-chat-message-body');
        p.textContent = text;
        li.appendChild(p);
        chatListEl.appendChild(li);
        scrollToBottom();
        return li;
    }

    /**
     * Append an assistant message placeholder with typing indicator.
     *
     * @returns {HTMLLIElement}
     */
    function appendAssistantPlaceholder() {
        const li = el('li', 'gv-chat-message gv-chat-incoming');
        const typing = el('div', 'wap-chat__typing');
        typing.setAttribute('aria-label', 'AI is thinking');
        typing.innerHTML = '<span></span><span></span><span></span>';
        li.appendChild(typing);
        chatListEl.appendChild(li);
        scrollToBottom();
        return li;
    }

    /**
     * Append a completed assistant message (history render).
     *
     * @param {string} text
     * @returns {HTMLLIElement}
     */
    function appendAssistantMessage(text) {
        const li = el('li', 'gv-chat-message gv-chat-incoming');
        const p  = el('p', 'gv-chat-message-body');
        p.textContent = text;
        li.appendChild(p);
        chatListEl.appendChild(li);
        return li;
    }

    /**
     * Append an inline error to an existing assistant message.
     *
     * @param {HTMLLIElement} assistantEl
     * @param {string}        errorMessage
     */
    function appendErrorToAssistant(assistantEl, errorMessage) {
        const typing = assistantEl.querySelector('.wap-chat__typing');
        if (typing) typing.remove();

        const errEl = el('p', 'wap-chat__error-inline');
        errEl.textContent = errorMessage;
        assistantEl.appendChild(errEl);
    }

    /**
     * Append a standalone error as a gv-notice gv-notice-alert.
     *
     * @param {string} errorMessage
     */
    function appendErrorMessage(errorMessage) {
        const li = el('li', '');
        li.setAttribute('role', 'alert');

        const notice = el('div', 'gv-notice gv-notice-alert gv-mode-condensed');
        const icon   = gvIcon('https://gravity.group-cdn.one/v5.40.0/icons/error.svg', 'gv-notice-icon');
        const content = el('p', 'gv-notice-content');
        content.textContent = errorMessage;
        notice.appendChild(icon);
        notice.appendChild(content);
        li.appendChild(notice);

        chatListEl.appendChild(li);
        scrollToBottom();
    }

    /**
     * Append a collapsible tool-use card using the Gravity accordion component.
     *
     * @param {HTMLLIElement} assistantEl
     * @param {string}        toolName
     * @param {Object}        toolInput
     */
    function appendToolUse(assistantEl, toolName, toolInput) {
        accCounter++;
        const triggerId = 'wap-acc-trigger-' + accCounter;
        const bodyId    = 'wap-acc-body-' + accCounter;

        const accordion = el('div', 'gv-accordion');
        accordion.dataset.tool = toolName;

        const item   = el('div', 'gv-acc-item');
        const header = el('h4', 'gv-acc-header');

        const trigger = el('button', 'gv-acc-trigger gv-expanded');
        trigger.id = triggerId;
        trigger.type = 'button';
        trigger.setAttribute('aria-expanded', 'true');
        trigger.setAttribute('aria-controls', bodyId);

        const title = el('span', 'gv-acc-title');
        title.textContent = (i18n.actionLabel || 'Action') + ': ' + toolName;
        trigger.appendChild(title);

        // Toggle expand/collapse on click.
        trigger.addEventListener('click', function () {
            const expanded = trigger.getAttribute('aria-expanded') === 'true';
            trigger.setAttribute('aria-expanded', String(!expanded));
            trigger.classList.toggle('gv-expanded', !expanded);
            accBody.classList.toggle('gv-hidden', expanded);
        });

        header.appendChild(trigger);

        const accBody = el('div', 'gv-acc-body');
        accBody.id = bodyId;
        accBody.setAttribute('role', 'region');
        accBody.setAttribute('aria-labelledby', triggerId);

        const content    = el('div', 'gv-acc-content');
        const inputLabel = el('strong', '');
        inputLabel.textContent = 'Input:';
        const inputPre   = el('pre', 'wap-chat__action-json');
        inputPre.textContent = JSON.stringify(toolInput, null, 2);
        content.appendChild(inputLabel);
        content.appendChild(inputPre);

        accBody.appendChild(content);
        item.appendChild(header);
        item.appendChild(accBody);
        accordion.appendChild(item);
        assistantEl.appendChild(accordion);
    }

    /**
     * Update an existing tool-use accordion with the execution result.
     *
     * @param {HTMLLIElement} assistantEl
     * @param {string}        toolName
     * @param {string|Object} output
     */
    function appendToolResult(assistantEl, toolName, output) {
        const accordions = assistantEl.querySelectorAll('.gv-accordion[data-tool="' + toolName + '"]');
        const accordion  = accordions.length ? accordions[accordions.length - 1] : null;
        if (!accordion) return;

        const content = accordion.querySelector('.gv-acc-content');
        if (!content) return;

        const resultLabel = el('strong', '');
        resultLabel.textContent = 'Result:';
        const resultPre = el('pre', 'wap-chat__action-json');
        resultPre.textContent = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        content.appendChild(resultLabel);
        content.appendChild(resultPre);

        // Prefix the title with a checkmark once the result arrives.
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

                // Clear message list and rebuild the gv-chat structure.
                messagesEl.innerHTML = '';
                const gvChat = el('section', 'gv-chat');
                chatListEl = el('ul', 'gv-chat-list');
                gvChat.appendChild(chatListEl);
                messagesEl.appendChild(gvChat);

                // Show success notice — gv-notice gv-notice-success.
                const notice  = el('div', 'gv-notice gv-notice-success');
                notice.setAttribute('role', 'status');
                const icon    = gvIcon('https://gravity.group-cdn.one/v5.40.0/icons/check_circle.svg', 'gv-notice-icon');
                const content = el('p', 'gv-notice-content');
                content.textContent = i18n.deleteSuccess || 'Your data has been deleted. Reload the page to resume.';
                notice.appendChild(icon);
                notice.appendChild(content);
                messagesEl.appendChild(notice);

                setSendDisabled(true);
                deleteDataBtn.setAttribute('disabled', 'disabled');
            })
            .catch(function (err) {
                appendErrorMessage(err.message || (i18n.errorGeneric || 'Error deleting data.'));
            });
    }

    // -------------------------------------------------------------------------
    // UI utilities
    // -------------------------------------------------------------------------

    /**
     * Create a DOM element with optional class name.
     *
     * @param {string} tag
     * @param {string} cls
     * @returns {HTMLElement}
     */
    function el(tag, cls) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        return node;
    }

    /**
     * Create a <gv-icon> custom element.
     *
     * @param {string} src CDN URL of the icon SVG.
     * @param {string} cls Optional CSS class.
     * @returns {HTMLElement}
     */
    function gvIcon(src, cls) {
        const icon = document.createElement('gv-icon');
        icon.setAttribute('src', src);
        icon.setAttribute('aria-hidden', 'true');
        if (cls) icon.className = cls;
        return icon;
    }

    /**
     * Set the connection status indicator.
     *
     * Maps states to Gravity indicator dot states:
     *   connected  → gv-state-positive (green)
     *   connecting → gv-state-busy     (amber, default)
     *   error      → gv-state-critical (red)
     *
     * @param {'connected'|'connecting'|'error'} state
     */
    function setStatus(state) {
        if (!indicatorDotEl || !statusTextEl) return;

        const stateMap = {
            connected:  { cls: 'gv-state-positive', label: 'Connected' },
            connecting: { cls: 'gv-state-busy',     label: i18n.reconnecting || 'Connecting…' },
            error:      { cls: 'gv-state-critical',  label: 'Disconnected' },
        };
        const s = stateMap[state] || stateMap.connecting;
        indicatorDotEl.className = 'gv-indicator ' + s.cls;
        statusTextEl.textContent = s.label;
    }

    /**
     * Enable or disable the send button and textarea.
     *
     * @param {boolean} disabled
     */
    function setSendDisabled(disabled) {
        sendBtn.disabled = disabled;
        inputEl.disabled = disabled;
    }

    /**
     * Scroll the messages container to the bottom.
     */
    function scrollToBottom() {
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

}());
