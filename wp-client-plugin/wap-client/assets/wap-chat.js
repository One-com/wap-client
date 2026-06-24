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

    // Config is read live from the global so a host (e.g. the WAP admin tester)
    // can set/replace it and re-run init() to (re)connect with new values.
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

    // -------------------------------------------------------------------------
    // DOM references — resolved after DOMContentLoaded.
    // -------------------------------------------------------------------------

    let rootEl, messagesEl, inputEl, sendBtn, statusEl, deleteDataBtn;

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    document.addEventListener('DOMContentLoaded', init);

    // Expose init so standalone hosts can (re)connect after setting
    // window.WapClientConfig (e.g. the WAP admin chat tester switching roles).
    // On a WordPress page this is unused — DOMContentLoaded drives init() once.
    window.WapChat = window.WapChat || {};
    window.WapChat.init = init;

    /**
     * Initialise the chat widget.
     * Builds the DOM inside #wap-chat-root, loads history, and wires events.
     *
     * Re-runnable: re-reads window.WapClientConfig and rebuilds the UI, so a host
     * can call WapChat.init() again to reconnect with new configuration.
     */
    function init() {
        rootEl = document.getElementById('wap-chat-root');
        if (!rootEl) return;

        // Re-read config (a host may have replaced it before re-initialising).
        cfg = window.WapClientConfig || {};
        i18n = cfg.i18n || {};

        // Drop any in-flight stream / token from a previous connection.
        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
        }
        sessionToken = cfg.sessionToken || '';
        isStreaming = false;

        buildUI();
        wireEvents();

        // loadHistory() runs after authenticate() resolves and sets cfg.conversationId.
        authenticate(false).then(function () { loadHistory(); }).catch(function () {});
    }

    // -------------------------------------------------------------------------
    // UI construction
    // -------------------------------------------------------------------------

    /**
     * Build and inject the chat widget HTML structure.
     * Replaces the loading placeholder injected by PHP.
     */
    function buildUI() {
        rootEl.innerHTML = '';

        // Header bar.
        const header = el('div', 'wap-chat__header');
        statusEl = el('span', 'wap-chat__status wap-chat__status--connecting');
        statusEl.textContent = i18n.reconnecting || 'Connecting…';
        header.appendChild(statusEl);

        // Delete data button (GDPR).
        deleteDataBtn = el('button', 'wap-chat__delete-btn wap-chat__btn--ghost');
        deleteDataBtn.type = 'button';
        deleteDataBtn.textContent = i18n.deleteData || 'Delete my data';
        deleteDataBtn.setAttribute('aria-label', i18n.deleteData || 'Delete my data');
        header.appendChild(deleteDataBtn);

        // Messages area.
        messagesEl = el('div', 'wap-chat__messages');
        messagesEl.setAttribute('role', 'log');
        messagesEl.setAttribute('aria-live', 'polite');
        messagesEl.setAttribute('aria-label', 'Chat messages');

        // Input area.
        const inputArea = el('div', 'wap-chat__input-area');

        inputEl = el('textarea', 'wap-chat__input');
        inputEl.setAttribute('rows', '3');
        inputEl.setAttribute('placeholder', i18n.placeholder || 'Ask the AI assistant…');
        inputEl.setAttribute('aria-label', i18n.placeholder || 'Ask the AI assistant…');

        sendBtn = el('button', 'wap-chat__send-btn');
        sendBtn.type = 'button';
        sendBtn.textContent = i18n.send || 'Send';
        sendBtn.setAttribute('aria-label', i18n.send || 'Send');

        inputArea.appendChild(inputEl);
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
            // Ctrl+Enter or Cmd+Enter submits.
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

    /**
     * Obtain a fresh WAP session token.
     *
     * Concurrent callers share the same in-flight Promise — no polling needed.
     *
     * The token is sourced via a pluggable strategy so the same widget can run
     * both on a WordPress site and in standalone hosts (e.g. the WAP admin):
     *
     *   - default ('wp'): POST to WordPress admin-ajax.php (action=wap_client_auth).
     *     The App Password never reaches the browser and CORS is sidestepped.
     *   - 'direct': POST the WP connection details (entered by the caller) as JSON
     *     to cfg.authEndpoint, which proxies to the WAP backend's /auth/session.
     *
     * Set cfg.authStrategy = 'direct' to opt in; everything downstream of auth
     * (streaming, history, rendering) is strategy-agnostic.
     *
     * @param {boolean} forceNew Set true when re-provisioning after a 401
     *                           (revokes the stored App Password server-side,
     *                           where applicable).
     * @returns {Promise<string>} Resolves with the new session token.
     */
    /** Whether the next auth call should revoke the stored App Password. */
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
                // Both strategies normalise to { token, conversationId }.
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

    /**
     * Raise an Error from a failed WordPress AJAX envelope ({success:false}).
     *
     * @param {Object} json The parsed AJAX response.
     * @returns {never}
     */
    function throwAuthError(json) {
        throw new Error(
            json.data && json.data.message
                ? json.data.message
                : (i18n.errorGeneric || 'Auth failed')
        );
    }

    /**
     * Default strategy: authenticate via WordPress admin-ajax.php.
     *
     * @param {boolean} forceNew Revoke the stored App Password and re-provision.
     * @returns {Promise<Response>}
     */
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

    /**
     * Direct strategy: POST WP connection details as JSON to cfg.authEndpoint.
     *
     * Used by standalone hosts (e.g. the WAP admin chat tester) where there is
     * no WordPress AJAX layer. The endpoint itself enforces access control.
     *
     * @param {boolean} forceNew Request a fresh session (re-auth after 401).
     * @returns {Promise<Response>}
     */
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

    /**
     * Load conversation history from the WAP backend on widget init.
     * Renders all previous messages in the correct order.
     */
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
                // History load failure is non-fatal; widget still works.
                setStatus('connected');
            });
    }

    // -------------------------------------------------------------------------
    // Sending messages
    // -------------------------------------------------------------------------

    /**
     * Handle the send button click / keyboard shortcut.
     */
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

    /**
     * Send a message to the WAP backend and stream the response.
     *
     * Uses fetch with a ReadableStream body reader instead of the native
     * EventSource API because POST with a body is not supported by EventSource.
     *
     * @param {string} message The user message to send.
     */
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
                    // Token expired or revoked — re-auth and retry.
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

    /**
     * Read and process a WAP SSE stream from a ReadableStream.
     *
     * Handles the following event types (from spec section 5.5):
     *   text_delta   — streamed text tokens from the LLM
     *   tool_use     — agent is calling a tool
     *   tool_result  — tool execution result
     *   message_end  — stream complete (includes token usage)
     *   error        — error event from the backend
     *
     * @param {ReadableStream} body       The response body stream.
     * @param {HTMLElement}    assistantEl The assistant message container to fill.
     * @returns {Promise<void>}
     */
    function readSSEStream(body, assistantEl) {
        const reader   = body.getReader();
        const decoder  = new TextDecoder();
        let   buffer   = '';
        let   textNode = null; // <p> element for accumulating text_delta chunks.

        /**
         * Find or create the text paragraph inside the assistant bubble.
         * New tool_use events get their own block; text continues in a <p>.
         *
         * @returns {HTMLParagraphElement}
         */
        function getOrCreateTextNode() {
            if (!textNode) {
                textNode = el('p', 'wap-chat__text');
                assistantEl.querySelector('.wap-chat__bubble').appendChild(textNode);
            }
            return textNode;
        }

        /**
         * Process a single parsed SSE event object.
         *
         * @param {Object} event Parsed JSON from the SSE data field.
         */
        function processEvent(event) {
            switch (event.type) {
                case 'message_start':
                    // Sync the real backend conversationId so history calls use the correct thread_id.
                    if (event.conversationId) cfg.conversationId = event.conversationId;
                    break;

                case 'routing':
                    // Orchestrator routing decision — render as a subtle info line.
                    if (event.routing) {
                        textNode = null; // Routing info starts a new visual block.
                        const routingEl = el('div', 'wap-chat__routing');
                        routingEl.textContent = event.routing === 'multi'
                            ? '⟳ Consulting multiple specialists…'
                            : '';
                        if (routingEl.textContent) {
                            assistantEl.querySelector('.wap-chat__bubble').appendChild(routingEl);
                        }
                    }
                    break;

                case 'text_delta':
                    // Append streamed text chunk. Remove typing indicator on first token.
                    if (event.delta) {
                        const typingEl = assistantEl.querySelector('.wap-chat__typing');
                        if (typingEl) typingEl.remove();
                        getOrCreateTextNode().textContent += event.delta;
                        scrollToBottom();
                    }
                    break;

                case 'tool_use':
                    // Agent is calling a tool — render as a collapsible action card.
                    textNode = null; // Next text will go in a new <p>.
                    appendToolUse(assistantEl, event.tool || '', event.input || {});
                    break;

                case 'tool_result':
                    // Tool execution result — update the matching action card.
                    appendToolResult(assistantEl, event.tool || '', event.output || '');
                    textNode = null; // Text after a tool result starts fresh.
                    break;

                case 'message_end':
                    // Stream complete. Remove typing indicator if nothing was emitted.
                    const doneTyping = assistantEl.querySelector('.wap-chat__typing');
                    if (doneTyping) doneTyping.remove();
                    break;

                case 'error':
                    appendErrorToAssistant(assistantEl, event.message || (i18n.errorGeneric || 'Error'));
                    break;

                default:
                    // Unknown event type — silently ignore for forward-compatibility.
                    break;
            }
        }

        /**
         * Parse the accumulated SSE buffer into individual events and process them.
         *
         * @param {string} chunk Raw text chunk from the stream.
         * @returns {boolean} true if the [DONE] sentinel was received.
         */
        function parseChunk(chunk) {
            buffer += chunk;
            // SSE spec: events are separated by blank lines (\n\n).
            const events = buffer.split('\n\n');
            buffer = events.pop() || ''; // Keep any incomplete event.

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

        // Read the stream chunk by chunk; stop when [DONE] is received.
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
     * Append a user message bubble to the messages list.
     *
     * @param {string} text Message content.
     * @returns {HTMLElement} The appended element.
     */
    function appendUserMessage(text) {
        const wrapper = el('div', 'wap-chat__message wap-chat__message--user');
        const bubble  = el('div', 'wap-chat__bubble');
        bubble.textContent = text;
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        scrollToBottom();
        return wrapper;
    }

    /**
     * Append an assistant message bubble placeholder (filled by SSE stream).
     *
     * @returns {HTMLElement} The appended wrapper element (passed to stream reader).
     */
    function appendAssistantPlaceholder() {
        const wrapper = el('div', 'wap-chat__message wap-chat__message--assistant');
        const bubble  = el('div', 'wap-chat__bubble');
        // Typing indicator.
        const typing = el('div', 'wap-chat__typing');
        typing.setAttribute('aria-label', 'AI is thinking');
        typing.innerHTML = '<span></span><span></span><span></span>';
        bubble.appendChild(typing);
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        scrollToBottom();
        return wrapper;
    }

    /**
     * Append a completed assistant message (used when rendering history).
     *
     * @param {string} text Full message content.
     * @returns {HTMLElement} The appended element.
     */
    function appendAssistantMessage(text) {
        const wrapper = el('div', 'wap-chat__message wap-chat__message--assistant');
        const bubble  = el('div', 'wap-chat__bubble');
        const p       = el('p', 'wap-chat__text');
        p.textContent = text;
        bubble.appendChild(p);
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        return wrapper;
    }

    /**
     * Append an error message to an existing assistant bubble.
     *
     * @param {HTMLElement} assistantEl  The assistant wrapper element.
     * @param {string}      errorMessage Error text to display.
     */
    function appendErrorToAssistant(assistantEl, errorMessage) {
        // Remove typing indicator if still present.
        const typing = assistantEl.querySelector('.wap-chat__typing');
        if (typing) typing.remove();

        const errEl = el('p', 'wap-chat__error-inline');
        errEl.textContent = errorMessage;
        assistantEl.querySelector('.wap-chat__bubble').appendChild(errEl);
    }

    /**
     * Append a standalone error message.
     *
     * @param {string} errorMessage Error text to display.
     */
    function appendErrorMessage(errorMessage) {
        const wrapper = el('div', 'wap-chat__message wap-chat__message--error');
        wrapper.setAttribute('role', 'alert');
        const bubble = el('div', 'wap-chat__bubble');
        bubble.textContent = errorMessage;
        wrapper.appendChild(bubble);
        messagesEl.appendChild(wrapper);
        scrollToBottom();
    }

    /**
     * Append a collapsible tool-use card to an assistant bubble.
     *
     * The card shows the tool name and is expanded to show the input params.
     * It will be updated by appendToolResult() when the result arrives.
     *
     * @param {HTMLElement} assistantEl Parent assistant wrapper element.
     * @param {string}      toolName    MCP tool name.
     * @param {Object}      toolInput   Tool input parameters.
     */
    function appendToolUse(assistantEl, toolName, toolInput) {
        const card     = el('details', 'wap-chat__action-card');
        card.dataset.tool = toolName;

        const summary = el('summary', 'wap-chat__action-summary');
        const label   = el('span', 'wap-chat__action-label');
        label.textContent = (i18n.actionLabel || 'Action') + ': ' + toolName;
        const toggle  = el('span', 'wap-chat__action-toggle');
        toggle.setAttribute('aria-hidden', 'true');
        summary.appendChild(label);
        summary.appendChild(toggle);

        const body = el('div', 'wap-chat__action-body');

        const inputSection = el('div', 'wap-chat__action-input');
        const inputLabel   = el('strong', '');
        inputLabel.textContent = 'Input:';
        const inputPre     = el('pre', 'wap-chat__action-json');
        inputPre.textContent = JSON.stringify(toolInput, null, 2);
        inputSection.appendChild(inputLabel);
        inputSection.appendChild(inputPre);

        body.appendChild(inputSection);
        card.appendChild(summary);
        card.appendChild(body);

        assistantEl.querySelector('.wap-chat__bubble').appendChild(card);
    }

    /**
     * Update an existing tool-use card with the execution result.
     *
     * Finds the card by tool name and appends the result section.
     *
     * @param {HTMLElement} assistantEl Parent assistant wrapper element.
     * @param {string}      toolName    MCP tool name (matches the card's data-tool).
     * @param {string|Object} output    Tool execution output.
     */
    function appendToolResult(assistantEl, toolName, output) {
        // Find the most recent card for this tool (last match, in case same tool is called twice).
        const cards = assistantEl.querySelectorAll('.wap-chat__action-card[data-tool="' + toolName + '"]');
        const card  = cards.length ? cards[cards.length - 1] : null;

        if (!card) return;

        const body = card.querySelector('.wap-chat__action-body');
        if (!body) return;

        const resultSection = el('div', 'wap-chat__action-result');
        const resultLabel   = el('strong', '');
        resultLabel.textContent = 'Result:';
        const resultPre     = el('pre', 'wap-chat__action-json');

        const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        resultPre.textContent = outputStr;

        resultSection.appendChild(resultLabel);
        resultSection.appendChild(resultPre);
        body.appendChild(resultSection);

        // Mark the card as completed.
        card.classList.add('wap-chat__action-card--done');
    }

    // -------------------------------------------------------------------------
    // GDPR
    // -------------------------------------------------------------------------

    /**
     * Handle the "Delete my data" button click.
     *
     * Step 1: POST /api/v1/me/data/erase directly from JS (Bearer token, no PHP relay).
     * Step 2: POST to wap_client_delete_data AJAX to clean up local App Passwords.
     */
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
                if (res.status === 401) {
                    // Session already gone — still clean up locally.
                    return;
                }
                if (!res.ok) {
                    throw new Error('HTTP ' + res.status);
                }
            })
            .then(function () {
                // Clean up local WordPress state (App Passwords) server-side.
                // Standalone hosts (direct strategy) have no WP AJAX layer to
                // clean up, so the backend erase above is the whole story.
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
                messagesEl.innerHTML = '';
                const notice = el('div', 'wap-chat__notice wap-chat__notice--success');
                notice.setAttribute('role', 'status');
                notice.textContent = i18n.deleteSuccess || 'Your data has been deleted. Reload the page to resume.';
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
     * Create a DOM element with a class name.
     *
     * @param {string} tag   HTML tag name.
     * @param {string} cls   CSS class name (empty string for no class).
     * @returns {HTMLElement}
     */
    function el(tag, cls) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        return node;
    }

    /**
     * Set the connection status indicator text and modifier class.
     *
     * @param {'connected'|'connecting'|'error'} state Status state.
     */
    function setStatus(state) {
        if (!statusEl) return;
        statusEl.className = 'wap-chat__status wap-chat__status--' + state;

        const labels = {
            connected:  '● Connected',
            connecting: '○ ' + (i18n.reconnecting || 'Connecting…'),
            error:      '✕ Disconnected',
        };
        statusEl.textContent = labels[state] || state;
    }

    /**
     * Enable or disable the send button and textarea.
     *
     * @param {boolean} disabled Whether to disable the controls.
     */
    function setSendDisabled(disabled) {
        sendBtn.disabled   = disabled;
        inputEl.disabled   = disabled;
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
