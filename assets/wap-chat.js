/**
 * WAP Chat Widget — Vanilla JS SSE streaming chat client.
 *
 * No framework, no jQuery. The entire UI is composed from Gravity (group-one
 * brand) UI components — see wap-chat.css header for the component list.
 *
 * Platform-agnostic core: the widget talks to the WAP backend directly
 * (POST /api/v1/chat/stream for streaming, GET /api/v1/chat/{id}/history for
 * history) and delegates everything platform-specific to injectable hooks:
 *
 *   getSession(opts)   REQUIRED contract — async, resolves {token,
 *                      conversationId}. Called on load and again with
 *                      {forceNew: true} after a 401. The WordPress adapter
 *                      (wap-client PHP) provides a default implementation via
 *                      admin-ajax (the GRND and Application Password never
 *                      touch the browser). A SaaS host (e.g. partners.one)
 *                      supplies its own that calls its own backend, which
 *                      mints a GRND and returns it as the token — see
 *                      docs/integrating-a-saas-host.md.
 *   consent            OPTIONAL — {get, set} pair persisting the user's T&C
 *                      consent in host storage. get() resolves a boolean;
 *                      set(true) records acceptance. When a hook is available
 *                      the first chat is gated behind an in-widget consent
 *                      prompt. The WordPress adapter stores consent in user
 *                      meta via admin-ajax; SaaS hosts inject their own pair.
 *                      Hosts that provide neither get no gate (opt-in).
 *   eraseLocalData()   OPTIONAL — async host-side cleanup after GDPR erasure
 *                      (the WordPress adapter revokes App Passwords here).
 *   i18n               OPTIONAL — string overrides; English defaults built in.
 *   root               OPTIONAL — Element or CSS selector to mount into;
 *                      defaults to #wap-chat-root.
 *   layout             OPTIONAL — presentation framing; see resolveLayout() and
 *                      docs/integrating-a-saas-host.md. Defaults = boxed panel.
 *   readOnly           OPTIONAL — replay mode. Renders `transcript` and stops:
 *                      no getSession call, no consent gate, no analytics, and
 *                      sending is refused. Used by the WAP admin conversation
 *                      browser to review a past conversation; see
 *                      docs/admin-ui.md → Conversations. NOTE: init() merges
 *                      options over the previous window.WapClientConfig, so a
 *                      page that mounts a replay and then a live widget must
 *                      pass readOnly: false explicitly on the live mount.
 *   transcript         OPTIONAL — read with readOnly. Array of
 *                      {role: 'user'|'assistant', content} in the shape
 *                      GET /chat/{id}/history returns, so a replay and a live
 *                      reload of the same thread render identically.
 *
 * Initialise with WapChat.init({...}) — options merge over window.WapClientConfig,
 * so WordPress keeps using wp_localize_script while SaaS hosts pass options
 * directly. Timestamps honour cfg.timeFormat (PHP date() tokens).
 *
 * @package GroupOne\WapClient
 * @version 2.2.0
 */

/* global WapClientConfig, fetch, AbortController, TextDecoder */

(function () {
    'use strict';

    // -------------------------------------------------------------------------
    // Config (provided by wp_localize_script in class-chat-widget.php)
    // -------------------------------------------------------------------------

    let cfg = window.WapClientConfig || {};

    // English defaults so the core renders without any host-provided i18n
    // (WordPress overrides these with pre-translated strings; SaaS hosts pass
    // their own via WapChat.init({i18n: {...}})).
    const DEFAULT_I18N = {
        assistantName:   'AI Assistant',
        you:             'You',
        welcomeTitle:    'How can I help?',
        welcomeSubtitle: 'Ask me anything about your site, content, or settings.',
        agentSelector:   'Assistant',
        hint:            'Enter to send · Shift+Enter for a new line',
        placeholder:     'Ask the AI assistant…',
        send:            'Send',
        newChat:         'New chat',
        thinking:        'Thinking…',
        consulting:      'Consulting multiple specialists…',
        loadingHistory:  'Loading your conversation…',
        reconnecting:    'Connecting…',
        connected:       'Connected',
        disconnected:    'Disconnected',
        actionLabel:     'Action',
        showDetails:     'Show details',
        hideDetails:     'Hide details',
        termsLabel:      'Terms & Conditions',
        // Footer legal notice. {terms} and {privacy} are replaced with the
        // Terms of Use / Privacy Policy links (see buildMetaBar()).
        aiLegalNotice:   'This tool uses AI to generate content. Accuracy and legal compliance are not guaranteed. By using this tool you agree to {terms} and acknowledge {privacy}.',
        termsOfUseLabel: 'Terms of Use',
        privacyLabel:    'Privacy Policy',
        deleteData:      'Delete my data',
        deleteTitle:     'Delete your data?',
        cancel:          'Cancel',
        deleteConfirm:   'This will permanently delete all your conversation history with the AI assistant. This action cannot be undone.',
        deleteSuccess:   'Your data has been deleted.',
        errorGeneric:    'An error occurred. Please try again.',
        errorRateLimit:  'Too many requests. Please wait before sending another message.',
        errorAuthFailed: 'Could not connect to the AI assistant. Please reload the page, or contact support if this continues.',
        errorRetry:      'Try again',
        errorQuota:      'You have reached your monthly message limit. It resets at the start of next month.',
        quotaRemaining:  '{remaining} of {total} messages left',
        quotaResetsAt:   'Resets on {date} at {time}',
        quotaLow:        'Only {remaining} of {total} messages left this month. Your quota renews on {date} at {time}.',
        quotaExhausted:  'Limit reached. Your quota will renew on {date} at {time}.',
        quotaBlocked:    'Message limit reached',
        errorReference:  'Reference:',
        consentTitle:    'Before you start',
        consentText:     'Please review and accept the Terms & Conditions for the AI assistant.',
        consentAgree:    'Agree and continue',
        consentRequired: 'You need to accept the Terms & Conditions to use the AI assistant.',
        consentReview:   'Review Terms & Conditions',
        columnLabel:     'AI assistant',
        openAssistant:   'Open the AI assistant',
        closeAssistant:  'Hide the AI assistant',
        readOnly:        'Read-only',
    };

    function mergeI18n(overrides) {
        return Object.assign({}, DEFAULT_I18N, overrides || {});
    }

    let i18n = mergeI18n(cfg.i18n);

    // Opt-in per-agent overrides from GET /api/v1/agents/welcome. Outside `cfg`
    // because `cfg` is frozen in init(). Empty means "use the host's values".
    const agentWelcome = {
        welcomeTitle: '',
        welcomeMessage: '',
        promptSuggestions: [],
    };

    // Normalise cfg.layout (see docs/integrating-a-saas-host.md for the keys).
    // Defaults reproduce the boxed 900px panel; applied by applyLayout().
    function resolveLayout(raw) {
        const l = (raw && typeof raw === 'object') ? raw : {};

        const width = l.width === 'fluid' ? 'fluid' : 'boxed';

        // A fluid shell has nothing to expand to → toggle defaults 'off';
        // boxed defaults to the full-window overlay.
        let expandToggle = l.expandToggle;
        if (expandToggle !== 'off' && expandToggle !== 'container' && expandToggle !== 'window') {
            expandToggle = width === 'fluid' ? 'off' : 'window';
        }

        const align = (l.align === 'center' || l.align === 'right') ? l.align : 'left';

        return {
            width:          width,
            expandToggle:   expandToggle,
            innerWidth:     typeof l.innerWidth === 'string' ? l.innerWidth : '',
            align:          align,
            height:         typeof l.height === 'string' ? l.height : '',
            chrome:         l.chrome === 'flat' ? 'flat' : 'card',
            accent:         typeof l.accent === 'string' ? l.accent : '',
            keepScrollbar:  l.keepScrollbar !== false,
            showHeader:     l.showHeader !== false,
            showNewChat:    l.showNewChat !== false,
            showSettings:   l.showSettings !== false,
            showDeleteData: l.showDeleteData !== false,
        };
    }

    const CSS_LENGTH = /^\d+(\.\d+)?(px|rem|em|ch|vw|vh|vmin|vmax|%)$/;

    function cssLength(value, fallback) {
        const str = (typeof value === 'string') ? value.trim() : '';
        return CSS_LENGTH.test(str) ? str : fallback;
    }

    // Normalise cfg.column. Null when not mounted as a docked column.
    function resolveColumn(raw) {
        if (!raw || typeof raw !== 'object') return null;

        const c = raw;

        return {
            id:           (typeof c.id === 'string' && c.id) ? c.id : 'default',
            side:         c.side === 'left' ? 'left' : 'right',
            width:        cssLength(c.width, '400px'),
            mode:         c.mode === 'overlay' ? 'overlay' : 'push',
            breakpoint:   cssLength(c.breakpoint, '960px'),
            defaultState: c.defaultState === 'expanded' ? 'expanded' : 'collapsed',
            showLauncher: c.showLauncher !== false,
            persist:      c.persist !== false,
            label:        typeof c.label === 'string' && c.label ? c.label : '',
            stateNonce:   typeof c.stateNonce === 'string' ? c.stateNonce : '',
        };
    }

    const GRAVITY_VERSION = 'v5.40.0';
    const GRAVITY_CDN_BASE = 'https://gravity.group-cdn.one/' + GRAVITY_VERSION + '/';
    const GRAVITY_STYLESHEET_URL = GRAVITY_CDN_BASE + 'css/brands/group-one.min.css';
    const GRAVITY_RUNTIME_URL = GRAVITY_CDN_BASE + 'index.umd.js';

    const ICON_BASE = GRAVITY_CDN_BASE + 'icons/';
    const LOADER_SPINNER_SRC = GRAVITY_CDN_BASE + 'loaders/spinner.svg';

    // Ceiling on the pre-init event queue. It only drains from initMixpanel(), and
    // trackingInit() can bail permanently (no loader URL) with mpRequested already
    // set — so without a cap the queue would grow for the life of the page. Past
    // the cap we drop the NEWEST events: the early ones, Page Viewed included,
    // are the funnel-critical ones worth keeping.
    const MIXPANEL_QUEUE_MAX = 100;

    // EU ingest, matching the wap_client_mixpanel_api_host PHP default. Hosts
    // that build WapClientConfig themselves (npm/SaaS) may omit mixpanelApiHost,
    // and a WP filter can return a value esc_url_raw() rejects, so this fallback
    // has to exist — reading it undeclared throws a ReferenceError that
    // initMixpanel()'s catch would swallow, silently queueing every event.
    const DEFAULT_MIXPANEL_API_HOST = 'https://api-eu.mixpanel.com';

    // Small, light-touch icons used as visual aids across the UI.
    const ICON = {
        send:      ICON_BASE + 'arrow_forward.svg',
        assistant: ICON_BASE + 'auto_awesome.svg',
        newChat:   ICON_BASE + 'add.svg',
        delete:    ICON_BASE + 'delete.svg',
        terms:     ICON_BASE + 'description.svg',
        error:     ICON_BASE + 'error.svg',
        success:   ICON_BASE + 'check_circle.svg',
        close:     ICON_BASE + 'close.svg',
        scrollDown: ICON_BASE + 'arrow_downward.svg',
        info:       ICON_BASE + 'info.svg',
        warning:    ICON_BASE + 'warning.svg',
        settings:   ICON_BASE + 'settings.svg',
        fullscreen: ICON_BASE + 'fullscreen.svg',
        fullscreenExit: ICON_BASE + 'fullscreen_exit.svg',
        panelCloseRight: ICON_BASE + 'right_panel_close.svg',
        panelCloseLeft:  ICON_BASE + 'left_panel_close.svg',
        language:   ICON_BASE + 'language.svg',
        expand:     ICON_BASE + 'expand_more.svg',
        // Gravity's fixed conversational-button icons: send + stop-generating.
        stop:       ICON_BASE + 'stop_fill.svg',
    };

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    let sessionToken = cfg.sessionToken || '';
    // Session state, not config: cfg is frozen in init(), so this can't live on it.
    let conversationId = cfg.conversationId || '';
    let authPromise = null;
    let currentAbortController = null;
    let isStreaming = false;
    let flushStreamRender = null;
    let accCounter = 0;
    let hasMessages = false;
    // Set while an ask_user question card is on screen and unanswered; called to
    // dismiss that card when the user answers or types a normal message instead.
    let pendingQuestionCleanup = null;
    // Monotonic id source so each rendered question's radio/checkbox group gets a
    // unique `name` (multiple questions can coexist in one thread's history).
    let questionSeq = 0;
    let selectionGeneration = 0;
    let handoffTransitionGeneration = null;

    // T&C consent state. True when no consent hook is configured (gate is
    // opt-in); false until the hook's get() resolves true otherwise.
    let consentGranted = true;
    let consentHook = null;

    // Monthly quota snapshot from GET /chat/quota (WPIN-8805); null when unknown.
    let quota = null;
    // Warn once the remaining share drops to this fraction of the allowance.
    const QUOTA_LOW_RATIO = 0.1;

    // Mixpanel client-side analytics state. Inert unless cfg.mixpanelToken is
    // set; the SDK is loaded lazily on the first (consented) track call.
    let mpRequested = false;   // loader requested (guards re-entry)
    let mpInited = false;      // mixpanel.init() done for our named instance
    let mpIdentified = false;  // identify() called with the user id
    let mpQueue = [];          // events awaiting the loader stub
    let pageViewTracked = false;

    // -------------------------------------------------------------------------
    // DOM references — resolved after DOMContentLoaded.
    // -------------------------------------------------------------------------

    let rootEl, chatEl, chatListEl, inputEl, sendBtn, indicatorDotEl, statusTextEl, deleteDataBtn, newChatBtn;
    let agentSelectEl, agentSelectWrapEl;
    // Empty means "let the backend decide" (page_context / product default).
    let selectedAgentRole = '';
    let settingsBtn, fullscreenBtn, footerEl, scrollBtnEl;
    let quotaMeterEl, quotaNoticeEl, quotaNoticeIconEl, quotaNoticeTextEl;

    // Whether the widget is expanded via the header toggle; target ('window' vs
    // 'container') comes from the resolved layout — see resolveLayout().
    let isFullscreen = false;

    // Normalised presentation layout from cfg.layout (set in init()); defaults
    // reproduce the boxed 900px panel.
    let layout = {};

    // Docked-column state; `column` is null for every non-column embed.
    let column = null;
    let columnEl, columnPanelEl, columnLauncherEl, columnScrimEl, columnCloseBtn, columnHeadingEl;
    let columnCollapsed = true;
    let columnStateHook = null;
    // Resolved mode — drops to overlay below the configured breakpoint.
    let columnMode = 'push';
    let columnMediaQuery = null;
    // Bumped on every build/teardown; an async state restore compares against it
    // before touching anything.
    let columnEpoch = 0;
    let columnUserToggled = false;
    let columnPendingRead = null;
    let columnReturnFocusEl = null;
    let columnWriteTimer = null;
    let columnWriteLatest = null;

    // Touch-primary devices — iPad/iPhone/Android — have no hover and never
    // fire :focus-visible on tap, so the tooltip reveal rules above don't
    // show tooltips for touch users. We force-show them on click instead.
    // Computed once at module load; doesn't change at runtime.
    const isTouchPrimary = typeof window.matchMedia === 'function'
        && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

    // Monotonic id source for wiring tooltips to their trigger buttons.
    let tipCounter = 0;

    // Whether the view is "stuck" to the bottom (auto-follows new content). Set
    // true after the user sends; cleared when the user scrolls up.
    let stickToBottom = true;

    // Listeners bound outside rootEl, recorded so a re-init or destroy() can
    // remove them instead of stacking a second copy on every mount.
    let teardowns = [];

    function on(target, type, handler, options) {
        if (!target || typeof target.addEventListener !== 'function') return;
        target.addEventListener(type, handler, options);
        teardowns.push(function () {
            target.removeEventListener(type, handler, options);
        });
    }

    function runTeardowns() {
        const pending = teardowns;
        teardowns = [];
        pending.forEach(function (fn) {
            try { fn(); } catch (e) { /* ignore */ }
        });
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    // Auto-init for the script-tag embed, suppressed once init()/mount() has run
    // explicitly — an ESM host that mounts before parsing ends would get two.
    let explicitInit = false;

    document.addEventListener('DOMContentLoaded', function (e) {
        if (explicitInit) return;
        init(e);
    });

    window.WapChat = window.WapChat || {};
    window.WapChat.init = init;
    window.WapChat.mount = mount;
    window.WapChat.destroy = destroy;

    function init(options) {
        // WapChat.init(options) merges over the localized config so SaaS hosts
        // can configure the widget entirely from JS. Guard against the
        // DOMContentLoaded Event object arriving as the first argument.
        if (options && typeof options === 'object' && !(options instanceof Event)) {
            explicitInit = true;
            window.WapClientConfig = Object.assign({}, window.WapClientConfig || {}, options);
            // Freeze after the first merge so a later third-party script
            // (analytics, ad tags, another plugin) cannot silently override
            // security-relevant fields like wapBrowserUrl, mcpEndpoint,
            // authNonce, or the getSession function. Shallow freeze is
            // enough: leaves are primitives, Functions, or Promises and none
            // mutate the config object. Object.freeze is a no-op when the
            // object is already frozen.
            try { Object.freeze(window.WapClientConfig); } catch (e) { /* ignore */ }
        }

        // Nothing module-level is touched until the mount point is known good, so
        // a re-init with an unresolvable root leaves the previous mount intact.
        const nextCfg = window.WapClientConfig || {};
        const nextRoot = resolveRoot(nextCfg.root);
        if (!nextRoot) return;

        runTeardowns();

        cfg = nextCfg;
        i18n = mergeI18n(cfg.i18n);
        // Re-mount must not show a previous agent's welcome content.
        agentWelcome.welcomeTitle = '';
        agentWelcome.welcomeMessage = '';
        agentWelcome.promptSuggestions = [];
        layout = resolveLayout(cfg.layout);
        column = resolveColumn(cfg.column);
        rootEl = nextRoot;

        ensureGravityLoaded();

        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
        }
        sessionToken = cfg.sessionToken || '';
        conversationId = cfg.conversationId || '';
        isStreaming = false;
        hasMessages = false;
        // A re-init (the admin tester's reconnect) must not carry the previous
        // mount's manual selection into this one — loadAgents() prefers
        // selectedAgentRole over the server's reported `current`, so a stale
        // value here pins the new mount to the old role.
        selectedAgentRole = '';
        // buildUI() rebuilds the DOM from scratch, so any prior expanded state
        // is gone — keep the flag in step so the toggle icon starts correct.
        isFullscreen = false;
        // One Page Viewed per mount. Reset here (not module scope) so a genuine
        // re-init — e.g. the admin tester's re-connect — counts as a new view,
        // while the mp* SDK flags persist so the library loads only once. cfg is
        // already the new config above, so the super-props pick up this mount's
        // page rather than the first mount's.
        pageViewTracked = false;
        trackingSyncSuperProps();

        buildUI();
        wireEvents();
        installViewportHandler();

        // Before anything renders, so a collapsed column never flashes open.
        if (column) buildColumn();

        showLoading();

        // Replay mode: render the supplied transcript and stop. No session auth,
        // no network calls, no consent gate — there is nothing to send. Used by
        // the WAP admin conversation browser to review a past conversation.
        if (cfg.readOnly) {
            renderReadOnly();
            return;
        }

        // T&C gate (runs in parallel with auth): when a consent hook is
        // available and the user hasn't consented yet, the composer stays
        // disabled behind an in-chat consent prompt until they accept.
        initConsent();

        bootSession();
    }

    /**
     * Authenticate, then rehydrate the thread from the server (the backend is
     * the source of truth — see GET /chat/{id}/history). Only fall back to the
     * welcome state once we know the thread is genuinely empty, so a reload
     * restores the conversation instead of flashing the welcome.
     *
     * Shared by init() and the Try again button on the terminal auth notice, so
     * a retry rebuilds exactly the same state a fresh page load would.
     */
    function bootSession() {
        // Captured per boot: a manual agent switch (or a Stop) during the initial
        // load advances the generation, and the stale responses must not paint.
        const generation = selectionGeneration;
        authenticate(false)
            .then(function () {
                return Promise.all([
                    loadHistory(undefined, generation),
                    loadAgentWelcome(undefined, generation),
                    loadAgents(),
                    loadQuota(),
                ]);
            })
            .catch(function () {})
            .then(function () {
                if (selectionGeneration === generation) finishInitialLoad();
            });
    }

    /**
     * Render cfg.transcript as a finished conversation and lock the composer.
     *
     * Entries are the {role, content} shape the history endpoint returns, so a
     * replay and a live reload of the same thread render identically.
     */
    function renderReadOnly() {
        // A replay has no consent gate to satisfy — there is nothing to send and
        // no analytics to emit (track() short-circuits on readOnly). Leaving
        // consentGranted false would make finishInitialLoad() drop a "you need to
        // accept the T&Cs" reminder into someone else's transcript. Sending is
        // blocked by the disabled composer plus handleSend()'s own readOnly guard.
        consentGranted = true;
        setSendDisabled(true);
        inputEl.setAttribute('placeholder', i18n.readOnly || 'Read-only');
        inputEl.setAttribute('aria-label', i18n.readOnly || 'Read-only');

        clearLoading();
        const transcript = Array.isArray(cfg.transcript) ? cfg.transcript : [];
        transcript.forEach(function (msg) {
            if (!msg || typeof msg !== 'object') return;
            const when = parseTimestamp(msg.timestamp || msg.created_at || msg.createdAt || msg.time);
            if (msg.role === 'user') {
                appendUserMessage(msg.content || '', when);
            } else if (msg.role === 'assistant') {
                appendAssistantMessage(msg.content || '', when);
            }
        });

        setStatus('readOnly');
        finishInitialLoad();
        scrollToBottom(true);
    }

    function ensureGravityLoaded() {
        if (cfg.loadGravity === false || typeof document === 'undefined') return;
        var head = document.head || document.getElementsByTagName('head')[0];
        if (!head) return;

        var hasStyle = !!document.querySelector(
            'link[rel="stylesheet"][href*="gravity.group-cdn.one"], link[data-wap-gravity="style"]'
        );
        if (!hasStyle) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = GRAVITY_STYLESHEET_URL;
            link.setAttribute('data-wap-gravity', 'style');
            link.addEventListener('load', function () {
                if (inputEl) autoGrow();
            });
            head.insertBefore(link, head.firstChild);
        }

        var runtimeRegistered = typeof window.customElements !== 'undefined'
            && typeof window.customElements.get === 'function'
            && !!window.customElements.get('gv-loader');
        var hasRuntime = runtimeRegistered || !!document.querySelector(
            'script[src*="gravity.group-cdn.one"], script[data-wap-gravity="runtime"]'
        );
        if (!hasRuntime) {
            var script = document.createElement('script');
            script.src = GRAVITY_RUNTIME_URL;
            script.defer = true;
            script.setAttribute('data-wap-gravity', 'runtime');
            head.appendChild(script);
        }
    }

    // -------------------------------------------------------------------------
    // Analytics — Mixpanel client-side events (governed: Page Viewed / Button
    // Clicked). Inert unless cfg.mixpanelToken is set; every call is gated on
    // consent. Mandatory governed props (application / brand / page) are
    // registered as super-properties. See the Mixpanel Taxonomy Governance
    // guide and WAP Product Core Principles → Data.
    // -------------------------------------------------------------------------

    // Stable logical page for the chat surface (query params stripped). Prefer
    // an explicit config value; otherwise derive from product + pageContext.
    function resolveTrackingPage() {
        if (cfg.mixpanelPage) return cfg.mixpanelPage;
        var product = cfg.product ? '/' + cfg.product : '';
        var ctx = cfg.pageContext ? '/' + cfg.pageContext : '';
        return '/wap' + product + ctx;
    }

    // conversationId is "{user_id}:{role}"; its user_id prefix is the same
    // distinct_id the server-side Agent Work events use, so both sides of the
    // funnel land on one Mixpanel profile.
    function currentDistinctId() {
        if (conversationId && conversationId.indexOf(':') > -1) {
            return conversationId.split(':')[0];
        }
        return '';
    }

    function mixpanelSuperProps() {
        var props = {
            application: cfg.mixpanelApplication || 'wap',
            page: resolveTrackingPage(),
        };
        // brand is a governed mandatory prop but has no WP-family mapping yet —
        // only send it when the host configured a value (see MR notes).
        if (cfg.mixpanelBrand) props.brand = cfg.mixpanelBrand;
        return props;
    }

    // Resolve our named instance on every call, never cache it: the loader's
    // queueing stub is REPLACED by the real instance once the library finishes
    // loading, so a cached reference would go stale and silently drop events.
    function mpInstance() {
        return (window.mixpanel && window.mixpanel.wap) || null;
    }

    function maybeIdentify() {
        if (mpIdentified) return;
        var inst = mpInstance();
        var id = currentDistinctId();
        if (!inst || !id) return;
        try { inst.identify(id); mpIdentified = true; } catch (e) { /* ignore */ }
    }

    function initMixpanel() {
        if (mpInited) return;
        try {
            if (!window.mixpanel || typeof window.mixpanel.init !== 'function') return;
            // Named instance ('wap') so we never clobber — or get clobbered by —
            // another plugin's default Mixpanel instance on the same WP page.
            window.mixpanel.init(cfg.mixpanelToken, {
                api_host: cfg.mixpanelApiHost || DEFAULT_MIXPANEL_API_HOST,
                persistence: 'localStorage',
                // We fire the governed Page Viewed ourselves.
                track_pageview: false,
            }, 'wap');
            var inst = mpInstance();
            if (!inst) return;
            mpInited = true;
            inst.register(mixpanelSuperProps());
            maybeIdentify();
            // Flush anything captured before the loader stub existed. Calls made
            // after this point go straight to the stub, which queues them itself
            // until the library lands.
            var queued = mpQueue;
            mpQueue = [];
            queued.forEach(function (item) { emit(item.event, item.props); });
        } catch (e) { /* analytics must never break the widget */ }
    }

    // Ensure the Mixpanel loader snippet is present. The WordPress plugin
    // enqueues it as a dependency, so window.mixpanel (the queueing stub) is
    // normally already defined; other hosts can point cfg.mixpanelLoaderUrl at
    // the vendored copy instead. We never load from a third-party CDN — both the
    // loader and the library live in assets/vendor/.
    //
    // Note we load the LOADER, never the library directly: the library is the
    // snippet-companion build and needs the stub the loader creates. The loader
    // fetches the library from MIXPANEL_CUSTOM_LIB_URL.
    function trackingInit() {
        if (mpRequested || !cfg.mixpanelToken || typeof document === 'undefined') return;
        mpRequested = true;
        if (window.mixpanel && typeof window.mixpanel.init === 'function') {
            // Stub (or full library) already present — init straight away.
            initMixpanel();
            return;
        }
        if (!cfg.mixpanelLoaderUrl) return; // no local loader available → stay disabled
        // The loader locates the library ONLY via MIXPANEL_CUSTOM_LIB_URL — its
        // upstream CDN default is emptied in our vendored copy. Injecting it
        // without a library URL would leave its inner script tag with an empty
        // src, which resolves to the current document URL: the browser would
        // re-request the page and try to parse the HTML as JS. A host that sets
        // mixpanelLoaderUrl but not mixpanelLibUrl stays disabled instead.
        if (!cfg.mixpanelLibUrl && typeof window.MIXPANEL_CUSTOM_LIB_URL === 'undefined') return;
        var head = document.head || document.getElementsByTagName('head')[0];
        if (!head) return;
        if (cfg.mixpanelLibUrl && typeof window.MIXPANEL_CUSTOM_LIB_URL === 'undefined') {
            // The loader reads this global to locate the library.
            window.MIXPANEL_CUSTOM_LIB_URL = cfg.mixpanelLibUrl;
        }
        var script = document.createElement('script');
        script.src = cfg.mixpanelLoaderUrl;
        script.async = true;
        script.setAttribute('data-wap-mixpanel', '1');
        // The loader defines the stub synchronously on execution, so init() is
        // safe as soon as it has run; queued calls flush when the library lands.
        script.addEventListener('load', initMixpanel);
        head.appendChild(script);
    }

    function emit(eventName, props) {
        var inst = mpInstance();
        if (!inst || typeof inst.track !== 'function') return;
        try { inst.track(eventName, props || {}); } catch (e) { /* ignore */ }
    }

    // Public tracking entry. No-ops without a token or consent; ensures the
    // loader is present on first use and queues events until it is.
    function track(eventName, props) {
        // A read-only replay is an admin reviewing someone else's conversation —
        // never the end user's own session, so it must not emit product events.
        if (cfg.readOnly) return;
        if (!cfg.mixpanelToken || !consentGranted) return;
        if (!mpRequested) trackingInit();
        if (mpInited) {
            maybeIdentify();
            emit(eventName, props || {});
        } else if (mpQueue.length < MIXPANEL_QUEUE_MAX) {
            mpQueue.push({ event: eventName, props: props || {} });
        }
    }

    function trackPageView() {
        if (pageViewTracked || !consentGranted) return;
        pageViewTracked = true;
        track('Page Viewed', {});
    }

    function trackButtonClick(buttonName, extra) {
        var props = { button_name: buttonName };
        if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) props[k] = extra[k]; } }
        track('Button Clicked', props);
    }

    // Super-props are registered once, when the SDK comes up. A re-mount can
    // resolve a different product / pageContext / mixpanelPage, so re-register to
    // keep `page` in step with the fresh Page Viewed that init() arms — otherwise
    // the second mount's view reports the first mount's page. No-op until the SDK
    // is up: initMixpanel() registers the current values itself.
    function trackingSyncSuperProps() {
        if (!mpInited) return;
        var inst = mpInstance();
        if (!inst || typeof inst.register !== 'function') return;
        try { inst.register(mixpanelSuperProps()); } catch (e) { /* ignore */ }
    }

    // Drop the local analytics identity. Called from the GDPR erase path, so the
    // "Delete my data" button also takes the client-side identifier with it:
    // reset() clears the SDK's mp_<token>_wap persistence entry — distinct_id
    // (the WAP user_id), the registered super-props and any un-flushed batch —
    // and mints a fresh anonymous $device: id.
    //
    // persistence.clear() wipes the super-props too, so the governed mandatory
    // ones MUST be re-registered here; otherwise every later event on this page
    // ships without application/page/brand. Both reset and register are in the
    // loader stub's function list, so this is safe before the library lands.
    function trackingResetIdentity() {
        // Queued pre-init events were captured under the erased identity.
        mpQueue = [];
        mpIdentified = false;
        var inst = mpInstance();
        if (!inst) return;
        try {
            if (typeof inst.reset === 'function') inst.reset();
            if (typeof inst.register === 'function') inst.register(mixpanelSuperProps());
        } catch (e) { /* analytics must never break the erase flow */ }
    }

    // Resolve the mount container: an Element, a CSS selector, the default
    // #wap-chat-root, or the documented [data-wap-chat-column] mount point.
    function resolveRoot(root) {
        if (root && typeof root === 'object' && root.nodeType === 1) {
            return root;
        }
        if (typeof root === 'string' && root) {
            return document.querySelector(root);
        }

        const byId = document.getElementById('wap-chat-root');
        if (byId) return byId;

        const host = document.querySelector('[data-wap-chat-column]');
        if (!host) return null;

        const existing = host.querySelector('.wap-chat-root');
        if (existing) return existing;

        const created = el('div', 'wap-chat-root');
        // On the node, not in a module flag, so it survives a re-init's teardown.
        created.setAttribute('data-wap-root-owned', '');
        host.appendChild(created);
        return created;
    }

    // -------------------------------------------------------------------------
    // UI construction — all Gravity components
    // -------------------------------------------------------------------------

    function buildUI() {
        rootEl.innerHTML = '';
        // The widget's own CSS is scoped under .wap-chat-root and Gravity's
        // under .gv-activated. The WordPress adapter renders wap-chat-root in
        // its PHP template, but a custom `root` (npm/SaaS embeds) is an
        // arbitrary element — ensure both classes are present either way.
        rootEl.classList.add('wap-chat-root', 'gv-activated');
        applyLayout();

        // Null button refs before rebuilding so a now-hidden one leaves no
        // stale ref to a detached node.
        newChatBtn = settingsBtn = deleteDataBtn = fullscreenBtn = null;
        indicatorDotEl = statusTextEl = null;

        // ---- Header: status indicator + optional icon actions ---------------
        // Optional (layout.showHeader); each action is gated too.
        let header = null;
        if (layout.showHeader) {
            header = el('div', 'wap-chat__header');

            const statusWrapper = el('div', 'gv-text-indicator');
            indicatorDotEl = el('div', 'gv-indicator gv-state-busy');
            statusTextEl = el('span', '');
            statusTextEl.textContent = i18n.reconnecting || 'Connecting…';
            statusWrapper.appendChild(indicatorDotEl);
            statusWrapper.appendChild(statusTextEl);
            header.appendChild(statusWrapper);

            // Right-aligned header actions — icon-only, each with a Gravity
            // tooltip revealed on hover/focus.
            const actions = el('div', 'wap-chat__actions gv-flex gv-items-center gv-gap-xs');

            if (layout.showNewChat) {
                newChatBtn = iconAction(ICON.newChat, i18n.newChat || 'New chat', i18n.newChat || 'New chat');
                actions.appendChild(newChatBtn.parentNode);
            }

            if (layout.showSettings) {
                settingsBtn = iconAction(ICON.settings, i18n.settings || 'Chat settings', i18n.settings || 'Chat settings');
                actions.appendChild(settingsBtn.parentNode);
            }

            // Delete + expand sit at the right edge; their tooltips are right-
            // aligned ('end') so they don't clip against the shell edge.
            if (layout.showDeleteData) {
                deleteDataBtn = iconAction(ICON.delete, i18n.deleteData || 'Delete my data', i18n.deleteTooltip || 'Delete data for this chat session', 'end');
                deleteDataBtn.classList.add('wap-icon-btn--danger');
                actions.appendChild(deleteDataBtn.parentNode);
            }

            if (layout.expandToggle !== 'off') {
                fullscreenBtn = iconAction(ICON.fullscreen, i18n.fullscreen || 'Full screen', i18n.fullscreen || 'Full screen', 'end');
                actions.appendChild(fullscreenBtn.parentNode);
            }

            header.appendChild(actions);
        }

        // ---- gv-chat: list + footer -----------------------------------------
        chatEl = el('section', 'gv-chat');
        chatEl.setAttribute('role', 'log');
        chatEl.setAttribute('aria-live', 'polite');

        chatListEl = el('ul', 'gv-chat-list');
        chatListEl.setAttribute('aria-label', 'Chat messages');

        const footer = el('footer', '');
        footerEl = footer;
        const footerInner = el('div', 'gv-chat-footer');

        // gv-input-ai composer: toolbar (with send button) + textarea.
        const inputAi = el('div', 'gv-form-option gv-input-ai');
        const inputBox = el('div', 'gv-input gv-input-textarea');

        const toolbar = el('div', 'gv-input-toolbar gv-mode-condensed');
        toolbar.setAttribute('role', 'toolbar');

        const toolbarEnd = el('div', 'gv-toolbar-end');

        // Hidden until GET /chat/agents answers, so a slow or failed lookup
        // leaves the composer as it is rather than showing an empty box.
        agentSelectWrapEl = el(
            'div',
            'gv-input gv-input-select gv-input-sm gv-mode-condensed gv-min-w-0 gv-children-min-w-0 wap-agent-select'
        );
        agentSelectEl = el('select', '');
        agentSelectWrapEl.hidden = true;
        agentSelectEl.setAttribute('aria-label', i18n.agentSelector || 'Assistant');
        agentSelectWrapEl.appendChild(agentSelectEl);
        agentSelectWrapEl.appendChild(gvIcon(ICON.expand));
        toolbarEnd.appendChild(agentSelectWrapEl);

        sendBtn = el('button', 'gv-button gv-button-primary gv-button-icon');
        sendBtn.type = 'button';
        sendBtn.setAttribute('aria-label', i18n.send || 'Send');
        sendBtn.title = i18n.send || 'Send';
        sendBtn.appendChild(gvIcon(ICON.send));
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

        // Gravity's conversational "scroll to bottom" pattern: a secondary icon
        // button inside .gv-chat-scroll-bottom, placed in the footer before the
        // chat footer. Gravity's own CSS positions it above the footer and
        // reveals it when the `.gv-show-scroll` class is on the .gv-chat section.
        const scrollBottom = el('div', 'gv-chat-scroll-bottom');
        scrollBtnEl = el('button', 'gv-button gv-button-icon gv-button-secondary gv-mode-condensed');
        scrollBtnEl.type = 'button';
        scrollBtnEl.setAttribute('aria-label', i18n.scrollDown || 'Scroll to bottom');
        scrollBtnEl.appendChild(gvIcon(ICON.scrollDown));
        scrollBtnEl.addEventListener('click', onScrollBtnClick);
        scrollBottom.appendChild(scrollBtnEl);

        // wap-quota-notice mirrors Gravity's addon notice onto the top edge of
        // the composer (Gravity specifies it for the bottom edge).
        quotaNoticeEl = el('div', 'gv-notice gv-notice-addon gv-mode-condensed wap-quota-notice');
        quotaNoticeEl.setAttribute('role', 'status');
        quotaNoticeEl.hidden = true;
        quotaNoticeIconEl = gvIcon(ICON.warning, 'gv-notice-icon');
        quotaNoticeTextEl = el('p', 'gv-notice-content');
        quotaNoticeEl.appendChild(quotaNoticeIconEl);
        quotaNoticeEl.appendChild(quotaNoticeTextEl);

        const composerStack = el('div', 'wap-composer-stack');
        composerStack.appendChild(quotaNoticeEl);
        composerStack.appendChild(inputAi);
        footerInner.appendChild(composerStack);
        footer.appendChild(scrollBottom);
        footer.appendChild(footerInner);

        // The scroll container may be the list or the section — listen on both;
        // only the one that actually scrolls will emit events.
        chatListEl.addEventListener('scroll', updateScrollState);
        chatEl.addEventListener('scroll', updateScrollState);

        chatEl.appendChild(chatListEl);
        chatEl.appendChild(footer);

        if (header) rootEl.appendChild(header);
        rootEl.appendChild(chatEl);
        rootEl.appendChild(buildMetaBar());
    }

    // Translate the resolved layout into classes + CSS vars on the shell. The
    // stylesheet owns the actual rules; this only flips switches. Idempotent.
    function applyLayout() {
        // Clear runtime expand state from a prior build (init() resets isFullscreen).
        rootEl.classList.remove('wap-fullscreen', 'wap-expanded');

        rootEl.classList.toggle('wap-width-fluid', layout.width === 'fluid');
        rootEl.classList.toggle('wap-chrome-flat', layout.chrome === 'flat');
        rootEl.classList.toggle('wap-hide-scrollbar', !layout.keepScrollbar);

        rootEl.classList.remove('wap-align-left', 'wap-align-center', 'wap-align-right');
        rootEl.classList.add('wap-align-' + layout.align);

        // Inner-column cap; empty → 100% via the CSS var default.
        if (layout.innerWidth) {
            rootEl.style.setProperty('--wap-inner-width', layout.innerWidth);
        } else {
            rootEl.style.removeProperty('--wap-inner-width');
        }

        // 'fill' → class (100% of parent); a length → inline height wins over the
        // stylesheet's viewport math; '' → default.
        //
        // min-height must move with it. The stylesheet floors the shell at
        // min-height: 480px for the standalone desktop page, and used height is
        // clamp(min-height, height, max-height) — so without this an explicit
        // height below 480px silently rendered as 480px. That floor is only
        // lifted by the phone media queries or the 'fill' class, neither of
        // which applies to an embed sized by its host container.
        rootEl.classList.toggle('wap-height-fill', layout.height === 'fill');
        if (layout.height && layout.height !== 'fill') {
            rootEl.style.height = layout.height;
            rootEl.style.minHeight = layout.height;
        } else {
            rootEl.style.removeProperty('height');
            rootEl.style.removeProperty('min-height');
        }

        if (layout.accent) {
            // primary → button bg + icons; surface-highlight → bubbles/avatar
            // (tinted); on-accent → legible arrow on dark accents.
            rootEl.style.setProperty('--color-primary', layout.accent);
            rootEl.style.setProperty('--color-surface-highlight',
                'color-mix(in srgb, ' + layout.accent + ' 14%, #fff)');
            rootEl.style.setProperty('--wap-on-accent', contrastColor(layout.accent));
            rootEl.setAttribute('data-wap-accent', '');
        } else {
            rootEl.style.removeProperty('--color-primary');
            rootEl.style.removeProperty('--color-surface-highlight');
            rootEl.style.removeProperty('--wap-on-accent');
            rootEl.removeAttribute('data-wap-accent');
        }
    }

    // Black or white for content on top of `color`, by sRGB luminance. Lets the
    // browser normalise any colour form (hex/rgb/hsl/named) to rgb via a probe.
    function contrastColor(color) {
        let r = 0, g = 0, b = 0;
        try {
            const probe = document.createElement('span');
            probe.style.color = color;
            probe.style.display = 'none';
            document.body.appendChild(probe);
            const resolved = getComputedStyle(probe).color; // "rgb(r, g, b)"
            document.body.removeChild(probe);
            const parts = resolved.match(/[\d.]+/g);
            if (parts && parts.length >= 3) {
                r = +parts[0]; g = +parts[1]; b = +parts[2];
            }
        } catch (e) { /* fall back to the dark default below */ }
        const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return luminance > 0.6 ? '#111111' : '#ffffff';
    }

    // Bottom meta bar: AI + legal notice with inline Terms of Use / Privacy Policy
    // links (left, muted) + wap-client version (right). Built from Gravity utility
    // classes + tokens. The notice is one i18n template with {terms}/{privacy} slots
    // so it stays translatable as a single sentence with locale-specific word order.
    function buildMetaBar() {
        const bar = el('div', 'wap-chat__meta-bar gv-flex gv-flex-wrap gv-items-start gv-justify-between gv-gap-sm');

        const notice = el('div', 'wap-legal-notice gv-caption-sm gv-flex-1');

        // A link when the host configured the URL; otherwise the label as plain
        // text so the sentence still reads correctly. Gravity styles bare anchors
        // as underlined links, so no class is needed for the affordance.
        const legalPart = function (url, label) {
            if (!url) return document.createTextNode(label);
            const link = el('a', '');
            link.href = safeHref(url);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = label;
            return link;
        };

        const template = i18n.aiLegalNotice || DEFAULT_I18N.aiLegalNotice;
        template.split(/(\{terms\}|\{privacy\})/).forEach(function (part) {
            if (part === '{terms}') {
                notice.appendChild(legalPart(cfg.termsUrl, i18n.termsOfUseLabel || 'Terms of Use'));
            } else if (part === '{privacy}') {
                notice.appendChild(legalPart(cfg.privacyUrl, i18n.privacyLabel || 'Privacy Policy'));
            } else if (part) {
                notice.appendChild(document.createTextNode(part));
            }
        });
        bar.appendChild(notice);

        quotaMeterEl = el('span', 'wap-quota-meter gv-caption-sm gv-flex-shrink-0');
        quotaMeterEl.hidden = true;
        bar.appendChild(quotaMeterEl);

        const right = el('span', 'wap-version gv-caption-sm gv-font-mono gv-flex-shrink-0');
        right.textContent = cfg.version ? 'v' + cfg.version : '';
        bar.appendChild(right);

        return bar;
    }

    // Build a borderless icon-only header action using Gravity's tooltip anatomy:
    // a gv-tooltip-button trigger paired with a gv-tooltip revealed on hover/focus
    // (positioning is pinned by our CSS so it works without Gravity's JS layer).
    // Returns the <button>; its parentNode is the gv-tooltip-container to append.
    function iconAction(iconSrc, label, tooltipText, align) {
        tipCounter += 1;
        const tipId = 'wap-tip-' + tipCounter;

        // align 'end' pins the tooltip to the trigger's right edge so a wide
        // tooltip near the header's right edge is not clipped by the shell.
        const end = align === 'end';
        const container = el('div', 'gv-tooltip-container wap-tip' + (end ? ' wap-tip--end' : ''));

        const btn = el('button', 'gv-tooltip-button wap-icon-btn');
        btn.type = 'button';
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-describedby', tipId);
        btn.appendChild(gvIcon(iconSrc));

        const tip = el('div', 'gv-tooltip gv-mode-condensed ' + (end ? 'gv-arrow-top-right' : 'gv-arrow-top-center'));
        tip.id = tipId;
        tip.setAttribute('role', 'tooltip');
        tip.appendChild(elText('p', tooltipText));

        container.appendChild(btn);
        container.appendChild(tip);

        // Dismiss the tooltip once the button is activated — otherwise it lingers
        // (the button keeps focus/hover after a click). The suppression clears on
        // the next mouseleave or blur so hover/keyboard reveal works again.
        btn.addEventListener('click', function () {
            container.classList.add('wap-tip-hide');
            if (isTouchPrimary) {
                // On touch-primary devices, briefly force-show the tooltip so
                // the user can read the action label — hover/focus-visible
                // never fire on tap. Cleared after 1.5s; mouseleave/blur will
                // also clear it via the existing handlers.
                container.classList.add('wap-tip-force');
                setTimeout(function () { container.classList.remove('wap-tip-force'); }, 1500);
            }
        });
        btn.addEventListener('blur', function () { container.classList.remove('wap-tip-hide'); });
        container.addEventListener('mouseleave', function () {
            container.classList.remove('wap-tip-hide');
            container.classList.remove('wap-tip-force');
        });

        return btn;
    }

    function wireEvents() {
        sendBtn.addEventListener('click', onSendBtnClick);
        if (agentSelectEl) agentSelectEl.addEventListener('change', onAgentChange);

        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend('keyboard');
            }
        });

        inputEl.addEventListener('input', autoGrow);
        // Header actions are optional — wire only what was built.
        if (deleteDataBtn) deleteDataBtn.addEventListener('click', function () { trackButtonClick('delete_data'); handleDeleteData(); });
        if (newChatBtn) newChatBtn.addEventListener('click', function () { trackButtonClick('new_chat'); handleNewChat(); });
        if (settingsBtn) settingsBtn.addEventListener('click', function () { trackButtonClick('settings'); openSettings(); });
        if (fullscreenBtn) fullscreenBtn.addEventListener('click', function () { trackButtonClick('fullscreen'); toggleFullscreen(); });

        // Escape exits full screen — but only when no dialog/panel is open, so it
        // doesn't fight the modal's own Escape-to-close handler.
        on(document, 'keydown', function (e) {
            if (e.key !== 'Escape' || !isFullscreen) return;
            if (rootEl.querySelector('.gv-modal, .wap-settings')) return;
            toggleFullscreen();
        });

        // Start collapsed to a single line; autoGrow expands as the user types.
        autoGrow();
    }

    // New chat is confirmed first (it clears the current conversation). On an
    // empty conversation there is nothing to lose, so we skip straight to it.
    function handleNewChat() {
        if (!hasMessages) {
            startNewChat();
            return;
        }
        showConfirm({
            title:        i18n.newChatTitle || 'Start a new chat?',
            message:      i18n.newChatConfirm || 'This clears the current conversation and its history. Anything I’ve remembered about you is kept.',
            confirmLabel: i18n.newChat || 'New chat',
            cancelLabel:  i18n.cancel || 'Cancel',
        }).then(function (confirmed) {
            if (confirmed) startNewChat();
        });
    }

    // Start a brand-new conversation: abort any stream, drop the current thread,
    // provision a fresh session (force_new) and reset to the welcome state.
    function startNewChat() {
        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
        }
        isStreaming = false;
        hasMessages = false;
        conversationId = '';
        pendingQuestionCleanup = null;
        chatListEl.innerHTML = '';
        applyComposerLock();
        setStreamingUI(false); // reset Stop → Send if a stream was aborted.
        if (deleteDataBtn) deleteDataBtn.removeAttribute('disabled');
        showLoading();

        // This force_new is the user asking for a clean thread, not a rejected
        // credential — it must not eat into the 401 re-auth budget.
        reauthAttempts = 0;

        authenticate(true)
            .then(function () { return Promise.all([loadAgents(), loadQuota()]); })
            .catch(function () {})
            .then(function () { finishInitialLoad(); });
    }

    const INPUT_MAX_HEIGHT = 160;

    function autoGrow() {
        inputEl.style.height = 'auto';
        const needed = inputEl.scrollHeight;
        inputEl.style.height = Math.min(needed, INPUT_MAX_HEIGHT) + 'px';
        inputEl.style.overflowY = needed > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
    }

    // The shell height reads from a CSS variable (--wap-vh) that we update
    // from window.visualViewport. This handles the iOS on-screen keyboard,
    // which neither vh nor dvh shrinks for, and orientation changes without a
    // JS-resize race. rAF-throttled because resize fires continuously while
    // the keyboard animates open on iOS.
    function installViewportHandler() {
        if (!window.visualViewport) return;

        let raf = 0;
        function update() {
            raf = 0;
            rootEl.style.setProperty('--wap-vh', window.visualViewport.height + 'px');
            // The scroll-affordance button depends on chat height — recompute
            // so it appears/hides correctly after a keyboard open or rotation.
            if (typeof updateScrollBtn === 'function') {
                updateScrollBtn();
            }
        }
        function schedule() {
            if (raf) return;
            raf = window.requestAnimationFrame(update);
        }

        on(window.visualViewport, 'resize', schedule);
        on(window.visualViewport, 'scroll', schedule);
        teardowns.push(function () {
            if (raf) window.cancelAnimationFrame(raf);
        });
        update();
    }

    // -------------------------------------------------------------------------
    // Docked column — a shell around the widget, not a second widget.
    //
    // Deliberately not gv-sidedrawer: that component is modal (role="dialog" +
    // aria-modal + trap) and a pushing column is not. See the README's "Gravity
    // note" and accessibility contract.
    // -------------------------------------------------------------------------

    function buildColumn() {
        columnEl = columnHost();
        if (!columnEl) {
            column = null;
            return;
        }

        const epoch = ++columnEpoch;
        columnUserToggled = false;

        columnEl.classList.add('wap-chat-column', 'gv-activated');
        columnEl.setAttribute('data-wap-column-side', column.side);
        columnEl.style.setProperty('--wap-column-width', column.width);
        // Carries the push transition for the column's whole lifetime; see the
        // stylesheet's host-inset block.
        document.documentElement.classList.add('wap-column-host');

        const label = column.label || i18n.columnLabel || 'AI assistant';
        const panelId = 'wap-chat-column-panel-' + (columnEl.id || ++tipCounter);

        columnPanelEl = el('div', 'wap-chat-column__panel');
        columnPanelEl.id = panelId;

        // Names the region, and gives aria-labelledby a target in dialog mode.
        columnHeadingEl = el('h2', 'gv-sr-only');
        columnHeadingEl.id = panelId + '-title';
        columnHeadingEl.textContent = label;

        // Same helper as New chat / Settings / Delete, so the dismiss control is
        // one of the header actions rather than a second kind of button.
        const closeLabel = i18n.closeAssistant || 'Hide the AI assistant';
        columnCloseBtn = iconAction(
            'left' === column.side ? ICON.panelCloseLeft : ICON.panelCloseRight,
            closeLabel,
            closeLabel,
            'end'
        );

        const anchor = rootEl.parentNode;
        columnPanelEl.appendChild(columnHeadingEl);
        if (anchor === columnEl) {
            columnEl.insertBefore(columnPanelEl, rootEl);
        } else {
            columnEl.appendChild(columnPanelEl);
        }
        columnPanelEl.appendChild(rootEl);

        // With layout.showHeader:false there is no row to join; the stylesheet
        // then floats it over the panel corner (.wap-chat-column--no-header).
        // parentNode is iconAction()'s .gv-tooltip-container.wap-tip wrapper, which
        // the --no-header rule below styles by name. Unwrap the helper and this
        // append becomes a silent no-op.
        const closeWrap = columnCloseBtn.parentNode;
        const actionsRow = rootEl.querySelector('.wap-chat__actions');
        if (actionsRow) {
            actionsRow.appendChild(closeWrap);
        } else {
            columnEl.classList.add('wap-chat-column--no-header');
            columnPanelEl.appendChild(closeWrap);
        }

        columnScrimEl = el('div', 'wap-chat-column__scrim');
        columnScrimEl.setAttribute('aria-hidden', 'true');
        columnEl.insertBefore(columnScrimEl, columnPanelEl);

        // ---- Launcher: the collapsed-state affordance -----------------------
        if (column.showLauncher) {
            // Gravity's circular icon-only button is the documented
            // floating-action affordance, and avoids gv-button's mobile width:100%.
            columnLauncherEl = el('button', 'gv-button gv-button-icon gv-button-primary wap-chat-column__launcher');
            columnLauncherEl.type = 'button';
            columnLauncherEl.setAttribute('aria-controls', panelId);
            columnLauncherEl.setAttribute('aria-expanded', 'false');
            columnLauncherEl.title = label;
            columnLauncherEl.appendChild(gvIcon(ICON.assistant));
            columnEl.appendChild(columnLauncherEl);
        }

        wireColumnEvents();
        syncColumnMode();

        resolveColumnStateHook();

        // persist:false on every restore path: the state came FROM the store, and
        // on a re-mount columnCollapsed still holds the previous mount's value.
        const seeded = columnEl.getAttribute('data-wap-column-state');
        let initial = (seeded === 'expanded' || seeded === 'collapsed') ? seeded : null;

        // A synchronous hook can be read before first paint, so the JS path gets
        // the same no-flash guarantee as the server-seeded PHP path. An async
        // hook's Promise is kept for readColumnState() rather than discarded —
        // dropping it costs a second round-trip and an escaping rejection.
        columnPendingRead = null;
        if (null === initial && columnStateHook) {
            let probe = null;
            try {
                probe = columnStateHook.get();
            } catch (e) {
                probe = null;
            }
            if (probe && typeof probe.then === 'function') {
                columnPendingRead = probe;
            } else if (probe === 'expanded' || probe === 'collapsed') {
                initial = probe;
            }
        }

        // Known baseline for the `changed` comparison in applyColumnState().
        columnCollapsed = true;
        applyColumnState(initial || column.defaultState, { animate: false, focus: false, persist: false });

        if (null === initial) {
            readColumnState().then(function (state) {
                // Torn down, or the user already chose — either way, stand down.
                if (epoch !== columnEpoch || !columnEl || columnUserToggled) return;
                if (state && state !== currentColumnState()) {
                    applyColumnState(state, { animate: false, focus: false, persist: false });
                }
            }).catch(function () { /* best effort — the default state stands */ });
        }

        // Last, so runTeardowns() collects this build before init() starts the
        // next one and a second mount cannot strand this panel on the page.
        teardowns.push(destroyColumn);
    }

    // The [data-wap-chat-column] mount point when the host provided one,
    // otherwise a wrapper of our own around rootEl.
    function columnHost() {
        const explicit = rootEl.closest ? rootEl.closest('[data-wap-chat-column]') : null;
        if (explicit) return explicit;

        const parent = rootEl.parentNode;
        if (!parent || parent.nodeType !== 1) return null;

        const wrapper = el('div', '');
        wrapper.setAttribute('data-wap-chat-column', column.id);
        wrapper.setAttribute('data-wap-column-owned', '');
        parent.insertBefore(wrapper, rootEl);
        wrapper.appendChild(rootEl);
        return wrapper;
    }

    // Every listener goes through on() — node removal alone leaves the
    // document-level handlers below bound.
    function wireColumnEvents() {
        if (columnLauncherEl) {
            on(columnLauncherEl, 'click', function () {
                // Read the state before toggling: the launcher is hidden while the
                // panel is open, so in practice this is always 'expand', but the
                // direction is recorded rather than assumed.
                trackButtonClick('column_launcher', {
                    button_context: columnCollapsed ? 'expand' : 'collapse',
                });
                toggleColumn(true);
            });
        }
        on(columnCloseBtn, 'click', function () {
            trackButtonClick('column_close');
            applyColumnState('collapsed', { focus: true });
        });
        on(columnScrimEl, 'click', function () {
            if ('overlay' === columnMode) applyColumnState('collapsed', { focus: true });
        });

        // Only where the panel owns the key: push mode is non-modal, so Escape
        // aimed at the host's own UI must reach it. Fullscreen, a gv-modal and the
        // settings sheet each own Escape ahead of the column.
        on(document, 'keydown', function (e) {
            if (e.key !== 'Escape' || columnCollapsed) return;
            if ('overlay' !== columnMode && !columnPanelEl.contains(document.activeElement)) return;
            if (isFullscreen) return;
            if (rootEl.querySelector('.gv-modal, .wap-settings')) return;
            e.preventDefault();
            // preventDefault() alone does not stop a host keydown handler.
            e.stopPropagation();
            applyColumnState('collapsed', { focus: true });
        });

        // Overlay mode only — a pushing panel is non-modal.
        on(document, 'keydown', function (e) {
            if (e.key !== 'Tab' || columnCollapsed || 'overlay' !== columnMode) return;
            trapColumnFocus(e);
        }, true);
    }

    // Below the configured breakpoint the column is always an overlay. Bound
    // fresh per build: destroyColumn() nulls columnMediaQuery, so a re-init
    // re-binds rather than short-circuiting on a stale, unlistened query.
    function syncColumnMode() {
        if (!columnMediaQuery && typeof window.matchMedia === 'function') {
            const query = window.matchMedia('(max-width: ' + column.breakpoint + ')');
            columnMediaQuery = query;
            const onChange = function () {
                resolveColumnMode();
                // Re-apply the same state so the mode switch takes effect.
                applyColumnState(currentColumnState(), { animate: false, focus: false, persist: false });
            };
            // Safari < 14 only has the deprecated listener API.
            if (typeof query.addEventListener === 'function') {
                on(query, 'change', onChange);
            } else if (typeof query.addListener === 'function') {
                query.addListener(onChange);
                teardowns.push(function () { query.removeListener(onChange); });
            }
        }
        resolveColumnMode();
    }

    function resolveColumnMode() {
        if (!columnEl) return;
        const narrow = !!(columnMediaQuery && columnMediaQuery.matches);
        columnMode = (narrow || 'overlay' === column.mode) ? 'overlay' : 'push';
        columnEl.setAttribute('data-wap-column-mode', columnMode);
        // The breakpoint is configurable, so the class carries the full-bleed
        // switch that a static media query cannot.
        columnEl.classList.toggle('wap-chat-column--narrow', narrow);
    }

    function currentColumnState() {
        return columnCollapsed ? 'collapsed' : 'expanded';
    }

    // Single writer for the column's visual + a11y state.
    //   animate:false  suppress the slide (initial restore, breakpoint flip)
    //   focus:true     move focus, as a user action would
    //   persist:false  don't write the preference
    function applyColumnState(state, opts) {
        // column:false, or buildColumn() bailed on a missing host.
        if (!columnEl || !column) return;

        const options = opts || {};
        const collapse = 'expanded' !== state;
        const changed = collapse !== columnCollapsed;

        // Captured before the panel takes focus, so collapsing can hand it back.
        if (changed && !collapse && options.focus) {
            const active = document.activeElement;
            columnReturnFocusEl = (active && active !== document.body) ? active : null;
        }

        columnCollapsed = collapse;

        columnEl.classList.toggle('wap-column-animate', false !== options.animate);
        columnEl.setAttribute('data-wap-column-state', currentColumnState());

        if ('overlay' === columnMode && !collapse) {
            columnPanelEl.setAttribute('role', 'dialog');
            columnPanelEl.setAttribute('aria-modal', 'true');
            columnPanelEl.setAttribute('aria-labelledby', columnHeadingEl.id);
        } else {
            columnPanelEl.setAttribute('role', 'complementary');
            columnPanelEl.removeAttribute('aria-modal');
            columnPanelEl.setAttribute('aria-labelledby', columnHeadingEl.id);
        }

        // The stylesheet also applies visibility:hidden, which is what keeps the
        // controls untabbable in browsers without `inert`.
        if (collapse) {
            columnPanelEl.setAttribute('aria-hidden', 'true');
            columnPanelEl.setAttribute('inert', '');
        } else {
            columnPanelEl.removeAttribute('aria-hidden');
            columnPanelEl.removeAttribute('inert');
        }

        if (columnLauncherEl) {
            columnLauncherEl.setAttribute('aria-expanded', collapse ? 'false' : 'true');
            columnLauncherEl.setAttribute(
                'aria-label',
                collapse
                    ? (i18n.openAssistant || 'Open the AI assistant')
                    : (i18n.closeAssistant || 'Hide the AI assistant')
            );
            columnLauncherEl.hidden = !collapse;
        }

        applyColumnPush();

        if (options.focus) {
            if (collapse) {
                focusColumnTrigger();
            } else {
                // Composer first; the dismiss button while it is still disabled.
                const target = (inputEl && !inputEl.disabled) ? inputEl : columnCloseBtn;
                try { target.focus(); } catch (e) { /* ignore */ }
            }
        }

        // A persisting change is user- or host-driven, so it also cancels any
        // restore still in flight.
        if (changed && false !== options.persist) {
            columnUserToggled = true;
            writeColumnState(currentColumnState());
        }
    }

    // The element that opened the panel, else the launcher. Never columnCloseBtn:
    // the panel is inert and visibility:hidden by now, so focus() would no-op and
    // focus would land on <body>.
    function focusColumnTrigger() {
        const saved = columnReturnFocusEl;
        columnReturnFocusEl = null;

        const restorable = saved
            && (saved.isConnected !== false)
            && !(columnPanelEl && columnPanelEl.contains(saved));

        const target = restorable
            ? saved
            : ((columnLauncherEl && !columnLauncherEl.hidden) ? columnLauncherEl : null);

        if (target) {
            try { target.focus(); } catch (e) { /* ignore */ }
        }
    }

    function toggleColumn(fromUser) {
        applyColumnState(columnCollapsed ? 'expanded' : 'collapsed', { focus: !!fromUser });
    }

    // Publish the inset as a custom property on <html>; the stylesheet decides
    // which host containers absorb it.
    function applyColumnPush() {
        if (!column) return;

        const root = document.documentElement;
        const pushing = 'push' === columnMode && !columnCollapsed;

        if (pushing) {
            // Clamped as the panel's own width is, so an oversized `width` cannot
            // inset the host further than the panel actually covers.
            root.style.setProperty('--wap-column-push', 'min(' + column.width + ', 100vw)');
        } else {
            root.style.removeProperty('--wap-column-push');
        }
        root.classList.toggle('wap-column-pushing', pushing);
        root.setAttribute('data-wap-column-side', column.side);
        root.classList.toggle('wap-column-locked', 'overlay' === columnMode && !columnCollapsed);
    }

    // Tab-only — siblings are not `inert`, so a virtual cursor and find-in-page
    // still reach the page behind the scrim.
    function trapColumnFocus(e) {
        if (!columnPanelEl) return;

        const focusables = columnPanelEl.querySelectorAll([
            'a[href]:not([tabindex="-1"])',
            'area[href]',
            'button:not([disabled])',
            'textarea:not([disabled])',
            'input:not([disabled]):not([type="hidden"])',
            'select:not([disabled])',
            'iframe',
            'audio[controls]',
            'video[controls]',
            'summary',
            '[contenteditable]:not([contenteditable="false"])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(', '));
        const visible = Array.prototype.filter.call(focusables, function (node) {
            return node.offsetWidth > 0 || node.offsetHeight > 0 || node === document.activeElement;
        });
        if (!visible.length) return;

        const first = visible[0];
        const last = visible[visible.length - 1];

        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        } else if (!columnPanelEl.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
        }
    }

    // ---- Persistence --------------------------------------------------------

    // Per browser profile, not per account — the WordPress path uses user meta.
    // From the resolved config, not the DOM: a TypeError here would be swallowed
    // by localColumnState's catch and read as a quota error.
    function columnStorageKey() {
        const id = (column && column.id) || 'default';
        return 'wap:column:' + (cfg.product || 'wap') + ':' + id;
    }

    const localColumnState = {
        get: function () {
            try { return window.localStorage.getItem(columnStorageKey()); } catch (e) { return null; }
        },
        set: function (state) {
            try { window.localStorage.setItem(columnStorageKey(), state); } catch (e) { /* quota/private mode */ }
        },
    };

    // WordPress adapter: per-user user meta through admin-ajax.
    function wordPressColumnState(nonce) {
        function request(body) {
            const params = new URLSearchParams();
            params.set('action', 'wap_client_column_state');
            params.set('_ajax_nonce', nonce);
            params.set('id', column.id);
            Object.keys(body).forEach(function (k) { params.set(k, body[k]); });

            return fetch(cfg.ajaxUrl, {
                method:      'POST',
                headers:     { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:        params.toString(),
                credentials: 'same-origin',
            })
                // An expired nonce must not read as "no preference": a falsy
                // `success` treated as null would silently drop every later set()
                // for the life of the page, and a wp-admin tab routinely outlives
                // a 12–24h nonce.
                .then(function (res) {
                    if (!res.ok) throw new Error('wap column state: HTTP ' + res.status);
                    return res.json();
                })
                .then(function (json) {
                    if (!json || !json.success) throw new Error('wap column state: request rejected');
                    return json.data ? json.data.state : null;
                })
                .catch(function (e) {
                    // Degrade, don't go silent: the preference stops following the
                    // account but still survives a reload.
                    if (columnStateHook === wpHook) columnStateHook = localColumnState;
                    if (window.console && window.console.warn) window.console.warn(e.message);
                    return null;
                });
        }

        const wpHook = {
            get: function () { return request({ op: 'get' }); },
            set: function (state) { return request({ op: 'set', state: state }); },
        };

        return wpHook;
    }

    function resolveColumnStateHook() {
        columnStateHook = null;
        if (!column || !column.persist) return;

        if (cfg.columnState && typeof cfg.columnState.get === 'function') {
            columnStateHook = cfg.columnState;
            return;
        }
        const nonce = wordPressStateNonce();
        columnStateHook = (nonce && cfg.ajaxUrl) ? wordPressColumnState(nonce) : localColumnState;
    }

    // cfg.column.stateNonce is the contract; the WapClientColumn_<id> global is a
    // fallback for a host rendering the mount point against an older adapter.
    function wordPressStateNonce() {
        if (column.stateNonce) return column.stateNonce;

        const global = window['WapClientColumn_' + column.id.replace(/-/g, '_')];
        return (global && typeof global.stateNonce === 'string') ? global.stateNonce : '';
    }

    function readColumnState() {
        if (!columnStateHook) return Promise.resolve(null);
        // Reuses the probe's Promise, so one mount is one round-trip.
        const pending = columnPendingRead;
        columnPendingRead = null;

        return Promise.resolve()
            .then(function () { return pending || columnStateHook.get(); })
            .then(function (state) {
                return (state === 'expanded' || state === 'collapsed') ? state : null;
            })
            .catch(function () { return null; });
    }

    // Trailing edge only: two POSTs from a double-click have no ordering
    // guarantee, so user meta could settle on the older value.
    function writeColumnState(state) {
        if (!columnStateHook || typeof columnStateHook.set !== 'function') return;

        columnWriteLatest = state;
        if (columnWriteTimer) return;

        columnWriteTimer = window.setTimeout(function () {
            columnWriteTimer = null;
            const value = columnWriteLatest;
            columnWriteLatest = null;
            if (!columnStateHook || typeof columnStateHook.set !== 'function') return;
            try {
                Promise.resolve(columnStateHook.set(value)).catch(function () { /* best effort */ });
            } catch (e) { /* a lost preference must never break the UI */ }
        }, 250);
    }

    // So a collapse immediately followed by an SPA route change is not lost.
    function flushColumnState() {
        if (!columnWriteTimer) return;
        window.clearTimeout(columnWriteTimer);
        columnWriteTimer = null;

        const value = columnWriteLatest;
        columnWriteLatest = null;
        if (!value || !columnStateHook || typeof columnStateHook.set !== 'function') return;
        try {
            Promise.resolve(columnStateHook.set(value)).catch(function () { /* best effort */ });
        } catch (e) { /* ignore */ }
    }

    // ---- Public mount surface ----------------------------------------------
    function mount(target, options) {
        const host = (target && typeof target === 'object' && target.nodeType === 1)
            ? target
            : (typeof target === 'string' ? document.querySelector(target) : null);

        if (!host) {
            if (window.console && window.console.warn) {
                window.console.warn('WapChat.mount: no element found for the given target.');
            }
            return null;
        }

        const opts = Object.assign({}, options || {});

        // column:false opts back out to a plain in-place embed.
        opts.column = (false === opts.column) ? null : Object.assign({}, opts.column || {});

        const columnId = (opts.column && opts.column.id) ? String(opts.column.id) : 'default';

        let container = host.querySelector('[data-wap-chat-column]');
        if (!container) {
            container = el('div', '');
            container.setAttribute('data-wap-chat-column', columnId);
            container.setAttribute('data-wap-column-owned', '');
            host.appendChild(container);
        }

        let root = container.querySelector('.wap-chat-root');
        if (!root) {
            root = el('div', 'wap-chat-root');
            root.setAttribute('data-wap-root-owned', '');
            container.appendChild(root);
        }

        opts.root = root;

        init(opts);

        // focus defaults to false — a host collapsing on a route change must not
        // steal it. Pass {focus: true} from a real click handler.
        return {
            expand:      function (o) { applyColumnState('expanded', focusOpt(o)); },
            collapse:    function (o) { applyColumnState('collapsed', focusOpt(o)); },
            toggle:      function (o) { toggleColumn(!!(o && o.focus)); },
            isCollapsed: function () { return columnCollapsed; },
            root:        root,
            destroy:     destroy,
        };
    }

    function focusOpt(o) {
        return { focus: !!(o && o.focus) };
    }

    function destroyColumn() {
        flushColumnState();

        columnEpoch += 1;
        columnUserToggled = false;
        columnPendingRead = null;

        const root = document.documentElement;
        root.style.removeProperty('--wap-column-push');
        root.classList.remove('wap-column-pushing', 'wap-column-locked', 'wap-column-host');
        root.removeAttribute('data-wap-column-side');

        if (columnEl) {
            const owned = columnEl.hasAttribute('data-wap-column-owned');
            if (rootEl && columnPanelEl && columnPanelEl.contains(rootEl)) {
                try {
                    if (owned && columnEl.parentNode) {
                        columnEl.parentNode.insertBefore(rootEl, columnEl);
                    } else if (!owned) {
                        columnEl.appendChild(rootEl);
                    }
                } catch (e) { /* ignore */ }
            }

            if (columnScrimEl) columnScrimEl.remove();
            if (columnLauncherEl) columnLauncherEl.remove();
            if (columnPanelEl) columnPanelEl.remove();

            if (owned) {
                columnEl.remove();
            } else {
                // A host-provided mount point is theirs — hand it back clean.
                columnEl.classList.remove(
                    'wap-chat-column',
                    'gv-activated',
                    'wap-column-animate',
                    'wap-chat-column--narrow',
                    'wap-chat-column--no-header'
                );
                columnEl.removeAttribute('data-wap-column-state');
                columnEl.removeAttribute('data-wap-column-mode');
                columnEl.removeAttribute('data-wap-column-side');
                columnEl.style.removeProperty('--wap-column-width');
            }
        }

        column = null;
        columnEl = columnPanelEl = columnLauncherEl = columnScrimEl = columnCloseBtn = columnHeadingEl = null;
        columnMediaQuery = null;
        columnStateHook = null;
        columnReturnFocusEl = null;
        columnCollapsed = true;
        columnMode = 'push';
    }

    function destroy() {
        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
        }
        isStreaming = false;
        isFullscreen = false;

        runTeardowns();
        destroyColumn();

        if (rootEl) {
            rootEl.innerHTML = '';
            if (rootEl.hasAttribute('data-wap-root-owned')) rootEl.remove();
        }
        rootEl = null;
    }

    // -------------------------------------------------------------------------
    // Welcome / empty state — greeting message + gv-chip suggestions
    // -------------------------------------------------------------------------

    function showWelcome() {
        if (hasMessages || chatListEl.querySelector('.wap-welcome')) return;

        // Centred empty state: sparkle mark, greeting title, muted subtitle and
        // (optionally) suggestion chips — mirrors the Gravity conversational
        // empty state rather than a left-aligned assistant bubble.
        const wrap = el('li', 'wap-welcome wap-empty');

        const icon = gvIcon(ICON.assistant, 'wap-empty__icon');
        icon.setAttribute('aria-hidden', 'true');
        wrap.appendChild(icon);

        // Precedence: agent override → host config → built-in default.
        const title = el('h2', 'wap-empty__title');
        title.textContent = agentWelcome.welcomeTitle || i18n.welcomeTitle || DEFAULT_I18N.welcomeTitle;
        wrap.appendChild(title);

        const sub = el('p', 'wap-empty__subtitle');
        sub.textContent = agentWelcome.welcomeMessage || i18n.welcomeSubtitle || DEFAULT_I18N.welcomeSubtitle;
        wrap.appendChild(sub);

        const suggestions = agentWelcome.promptSuggestions.length
            ? agentWelcome.promptSuggestions
            : (Array.isArray(cfg.suggestions) ? cfg.suggestions : []);
        if (suggestions.length) {
            const row = el('div', 'wap-chat__suggestions');
            suggestions.slice(0, 4).forEach(function (text) {
                const chip = el('button', 'gv-chip');
                chip.type = 'button';
                chip.setAttribute('aria-pressed', 'false');
                chip.textContent = text;
                chip.addEventListener('click', function () {
                    trackButtonClick('suggestion_chip', { button_context: text });
                    // Copy the prompt into the composer and focus it (caret at
                    // end) so the user can edit before sending, rather than
                    // firing it off immediately. Sending stays an explicit act.
                    inputEl.value = text;
                    autoGrow();
                    inputEl.focus();
                    try { inputEl.setSelectionRange(text.length, text.length); } catch (e) { /* ignore */ }
                });
                row.appendChild(chip);
            });
            wrap.appendChild(row);
        }

        chatListEl.appendChild(wrap);
    }

    function clearWelcome() {
        chatListEl.querySelectorAll('.wap-welcome').forEach(function (n) { n.remove(); });
    }

    // Initial-load spinner (gv-stream-loader) shown while we authenticate and
    // fetch history, so a reload doesn't flash the empty/welcome state.
    function showLoading() {
        if (chatListEl.querySelector('.wap-loading')) return;
        const row = el('li', 'gv-chat-message gv-chat-incoming wap-loading');
        const body = el('div', 'gv-chat-message-body');
        const loader = el('div', 'gv-stream-loader gv-stack-space-sm');
        loader.appendChild(makeStep(i18n.loadingHistory || 'Loading your conversation…', false));
        body.appendChild(loader);
        row.appendChild(body);
        chatListEl.appendChild(row);
    }

    function clearLoading() {
        chatListEl.querySelectorAll('.wap-loading').forEach(function (n) { n.remove(); });
    }

    // Called once after auth + history settle: drop the spinner and, only if no
    // history rendered and no error is showing, present the welcome state.
    function finishInitialLoad() {
        clearLoading();
        if (!hasMessages && !chatListEl.querySelector('.gv-notice')) {
            showWelcome();
        }
        // Re-assert the consent reminder if the list was rebuilt (e.g. New
        // chat) while consent is still pending — clearing the list removed
        // it. The modal itself lives outside the list and is unaffected.
        if (!consentGranted && !rootEl.querySelector('.wap-consent-modal')) {
            showConsentReminder();
        }
        // The conversational UI has settled — record the view. No-ops if consent
        // is still pending; grantConsent() fires it once consent is given.
        trackPageView();
    }

    // -------------------------------------------------------------------------
    // Authentication
    // -------------------------------------------------------------------------

    let pendingForceNew = false;

    /**
     * Budget for 401-driven re-authentication.
     *
     * A WAP 401 means "this GRND was rejected", and the cure is one forced
     * re-mint — but that round is expensive: the host revokes and re-mints an
     * Application Password, re-fetches WAP's wrap key, re-seals the credential
     * and re-runs the brand issuer exchange. When the rejection is
     * deterministic (issuer signing key absent from WAP's JWKS, JWKS fetch
     * blocked to WAP's egress, wrong issuer environment, clock skew, wrap key
     * rotated out) minting another token cannot help, so an unbounded retry
     * hammers the site and the issuer forever while the user only ever sees the
     * status pill flip between Connecting… and Connected.
     *
     * The budget is CONSECUTIVE, reset by any non-401 response: GRNDs are
     * short-lived (an hour by default) and the widget holds one in memory, so a
     * long-lived tab legitimately re-auths on expiry over and over — a lifetime
     * cap would break normal use.
     */
    const MAX_REAUTH_ATTEMPTS = 2;
    let reauthAttempts = 0;

    /**
     * The error raised once the re-auth budget is spent. The flag lets callers
     * tell a dead credential apart from a transient failure, so only this case
     * shows the terminal notice.
     */
    function authExhaustedError() {
        const err = new Error(
            i18n.errorAuthFailed
                || 'Could not connect to the AI assistant. Please reload the page, or contact support if this continues.'
        );
        err.wapAuthExhausted = true;
        return err;
    }

    /**
     * Single 401 policy for every WAP call.
     *
     * Returns a promise when this response is ours to handle — either
     * "re-authenticated, here is your retry" or a rejection because the budget
     * is spent — and null when the response belongs to the caller. The retry
     * thunk runs only after a successful re-auth, so callers can put cleanup
     * that must not happen on a terminal failure inside it.
     *
     * @param {Response} res   The WAP response.
     * @param {Function} retry Re-issues the same call.
     * @returns {Promise|null}
     */
    function handleAuthFailure(res, retry) {
        if (res.status !== 401) {
            // WAP accepted this GRND, so whatever went wrong before is behind
            // us — restore the full budget for the next credential.
            reauthAttempts = 0;
            return null;
        }
        if (reauthAttempts >= MAX_REAUTH_ATTEMPTS) {
            // The credential is dead as of now, so own the status here — each
            // caller then only decides how to render the message (in-chat
            // notice, inside the assistant bubble, or not at all).
            setStatus('error');
            return Promise.reject(authExhaustedError());
        }
        reauthAttempts++;
        return authenticate(true).then(retry);
    }

    function authenticate(forceNew) {
        if (forceNew) pendingForceNew = true;
        if (authPromise) return authPromise;

        var useForceNew = pendingForceNew;
        pendingForceNew = false;

        setStatus('connecting');

        // getSession is the platform contract: hosts resolve {token,
        // conversationId} however their platform requires. WordPress pages get
        // the built-in admin-ajax implementation as the default.
        const getSession = typeof cfg.getSession === 'function'
            ? cfg.getSession
            : wordPressGetSession;

        authPromise = Promise.resolve(getSession({ forceNew: useForceNew }))
            .then(function (data) {
                if (!data || !data.token) {
                    throw new Error(i18n.errorGeneric || 'Auth failed');
                }
                sessionToken = data.token;
                if (data.conversationId) conversationId = data.conversationId;
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

    /**
     * Default getSession for WordPress pages: server-side auth via admin-ajax.
     * PHP obtains the GRND (TokenManager + provider) and the Application
     * Password, exchanges them with WAP, and returns only the session token —
     * no credential ever reaches the browser.
     *
     * SaaS example (partners.one) — pass your own instead:
     *   WapChat.init({
     *     wapBrowserUrl: 'https://wap.group.one',
     *     getSession: function (opts) {
     *       // Your backend mints a GRND for the logged-in user (see
     *       // docs/integrating-a-saas-host.md) and returns it as the token —
     *       // WAP verifies it per call; there is no session exchange.
     *       return fetch('/api/assistant/session', { method: 'POST' })
     *         .then(function (r) { return r.json(); });
     *     },
     *   });
     */
    function wordPressGetSession(opts) {
        const data = new URLSearchParams({
            action:      'wap_client_auth',
            _ajax_nonce: cfg.authNonce || '',
            product:     cfg.product || '',
            menu_slug:   cfg.menuSlug || '',
            force_new:   opts && opts.forceNew ? '1' : '0',
        });

        return fetch(cfg.ajaxUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    data.toString(),
        })
            .then(function (res) { return res.json(); })
            .then(function (json) {
                return json.success === false ? throwAuthError(json) : (json.data || json);
            });
    }

    // -------------------------------------------------------------------------
    // T&C consent gate
    // -------------------------------------------------------------------------

    /**
     * Resolve the consent hook: hosts inject {get, set} like getSession; on
     * WordPress pages the built-in admin-ajax pair is the default. Returns
     * null when no hook is available — the gate is then skipped entirely.
     */
    function resolveConsentHook() {
        if (cfg.consent && typeof cfg.consent.get === 'function' && typeof cfg.consent.set === 'function') {
            return cfg.consent;
        }
        if (cfg.ajaxUrl && cfg.consentNonce) {
            return wordPressConsent;
        }
        return null;
    }

    // Default consent storage for WordPress pages: user meta via admin-ajax
    // (action wap_client_consent), so acceptance is per user and per product.
    const wordPressConsent = {
        get: function () {
            return wpConsentRequest('get').then(function (data) {
                return !!(data && data.granted);
            });
        },
        set: function () {
            return wpConsentRequest('grant');
        },
    };

    function wpConsentRequest(op) {
        const data = new URLSearchParams({
            action:      'wap_client_consent',
            _ajax_nonce: cfg.consentNonce || '',
            product:     cfg.product || '',
            op:          op,
        });

        return fetch(cfg.ajaxUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body:    data.toString(),
        })
            .then(function (res) { return res.json(); })
            .then(function (json) {
                if (json.success === false) {
                    throw new Error(json.data && json.data.message ? json.data.message : (i18n.errorGeneric || 'Consent check failed'));
                }
                return json.data || json;
            });
    }

    // Check stored consent and gate the composer until it resolves true. Fails
    // closed: an unreachable store shows the gate (accepting retries set()).
    function initConsent() {
        consentHook = resolveConsentHook();
        if (!consentHook) {
            consentGranted = true;
            return;
        }

        consentGranted = false;
        setSendDisabled(true);

        Promise.resolve(consentHook.get())
            .then(function (granted) {
                if (granted) {
                    grantConsent();
                } else {
                    showConsentGate();
                }
            })
            .catch(function () { showConsentGate(); });
    }

    function grantConsent() {
        consentGranted = true;
        applyComposerLock();
        rootEl.querySelectorAll('.wap-consent-gate, .wap-consent-modal').forEach(function (n) { n.remove(); });
        inputEl.focus();
        // Consent may resolve after finishInitialLoad(), which then skipped the
        // view — fire it now that tracking is allowed (dedup-guarded).
        trackPageView();
    }

    // Entry point for the gate: auto-opens the consent modal over the widget.
    function showConsentGate() {
        if (!consentHook || consentGranted) return;
        openConsentModal();
    }

    /**
     * Blocking T&C consent dialog (Gravity gv-modal, same anatomy as the
     * delete confirmation). "Agree and continue" records consent via the
     * hook and unlocks the composer. Dismissing (X / overlay / Escape /
     * Cancel) leaves the composer locked and drops a reminder notice in the
     * chat with a button to reopen the dialog.
     */
    function openConsentModal() {
        if (rootEl.querySelector('.wap-consent-modal')) return;

        const overlay = el('div', 'gv-modal wap-consent-modal');

        const content = el('div', 'gv-modal-content');
        content.setAttribute('role', 'dialog');
        content.setAttribute('aria-modal', 'true');

        const closeBtn = el('button', 'gv-modal-close');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', i18n.cancel || 'Close');
        closeBtn.appendChild(gvIcon(ICON.close));

        const body = el('div', 'gv-modal-body');
        const title = el('h2', 'gv-modal-title');
        title.id = 'wap-consent-title';
        title.textContent = i18n.consentTitle || 'Before you start';
        const msg = el('p', '');
        msg.appendChild(elText('span', (i18n.consentText || 'Please review and accept the Terms & Conditions for the AI assistant.') + ' '));
        if (cfg.termsUrl) {
            const link = el('a', '');
            link.href = safeHref(cfg.termsUrl);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = i18n.termsLabel || 'Terms & Conditions';
            msg.appendChild(link);
        }
        body.appendChild(title);
        body.appendChild(msg);
        content.setAttribute('aria-labelledby', title.id);

        // Inline error slot for a failed consent write (kept inside the
        // dialog so the user can simply retry).
        const errorSlot = el('div', '');
        body.appendChild(errorSlot);

        const actions = el('div', 'gv-button-group');
        const cancelBtn = el('button', 'gv-button gv-button-cancel');
        cancelBtn.type = 'button';
        cancelBtn.textContent = i18n.cancel || 'Cancel';
        const agreeBtn = el('button', 'gv-button gv-button-primary');
        agreeBtn.type = 'button';
        agreeBtn.textContent = i18n.consentAgree || 'Agree and continue';
        actions.appendChild(cancelBtn);
        actions.appendChild(agreeBtn);

        content.appendChild(closeBtn);
        content.appendChild(body);
        content.appendChild(actions);
        overlay.appendChild(content);
        rootEl.appendChild(overlay);

        const focusables = [agreeBtn, cancelBtn, closeBtn];
        const prevFocus = document.activeElement;

        function cleanup() {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            if (prevFocus && prevFocus.focus) {
                try { prevFocus.focus(); } catch (e) { /* ignore */ }
            }
        }

        function dismiss() {
            cleanup();
            showConsentReminder();
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                dismiss();
            } else if (e.key === 'Tab') {
                const first = focusables[0];
                const last = focusables[focusables.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault(); last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault(); first.focus();
                }
            }
        }

        function showError(message) {
            errorSlot.innerHTML = '';
            const notice = el('div', 'gv-notice gv-notice-alert gv-mode-condensed');
            const p = el('p', 'gv-notice-content');
            p.textContent = message;
            notice.appendChild(gvIcon(ICON.error, 'gv-notice-icon'));
            notice.appendChild(p);
            errorSlot.appendChild(notice);
        }

        agreeBtn.addEventListener('click', function () {
            agreeBtn.disabled = true;
            cancelBtn.disabled = true;
            Promise.resolve(consentHook.set(true))
                .then(function () {
                    cleanup();
                    grantConsent();
                })
                .catch(function (err) {
                    agreeBtn.disabled = false;
                    cancelBtn.disabled = false;
                    showError(err.message || (i18n.errorGeneric || 'Could not record consent.'));
                });
        });
        cancelBtn.addEventListener('click', dismiss);
        closeBtn.addEventListener('click', dismiss);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) dismiss();
        });
        document.addEventListener('keydown', onKey, true);

        agreeBtn.focus();
    }

    // Shown after the modal is dismissed without consent: an info notice in
    // the chat explaining why the composer is locked, with a reopen button.
    // Gravity "notice with button" anatomy: variant modifier on the root,
    // type-matching icon, gv-button-neutral placed after the content.
    function showConsentReminder() {
        if (consentGranted || chatListEl.querySelector('.wap-consent-gate')) return;

        const row = el('li', 'gv-chat-message gv-chat-incoming wap-consent-gate');
        const notice = el('div', 'gv-notice gv-notice-info gv-mode-condensed');
        const content = el('p', 'gv-notice-content');
        content.textContent = i18n.consentRequired || 'You need to accept the Terms & Conditions to use the AI assistant.';
        notice.appendChild(gvIcon(ICON.info, 'gv-notice-icon'));
        notice.appendChild(content);

        const reviewBtn = el('button', 'gv-button gv-button-neutral');
        reviewBtn.type = 'button';
        reviewBtn.textContent = i18n.consentReview || 'Review Terms & Conditions';
        reviewBtn.addEventListener('click', function () {
            row.remove();
            openConsentModal();
        });
        notice.appendChild(reviewBtn);

        row.appendChild(notice);
        chatListEl.appendChild(row);
        scrollToBottom(true);
    }

    // -------------------------------------------------------------------------
    // Terminal auth failure
    // -------------------------------------------------------------------------

    /**
     * Shown once the re-auth budget (MAX_REAUTH_ATTEMPTS) is spent: WAP keeps
     * rejecting freshly minted GRNDs, which is a backend/configuration problem
     * no further minting will fix. Same Gravity "notice with button" anatomy as
     * showConsentReminder() — variant modifier on the root, type-matching icon,
     * gv-button-neutral after the content — with the button granting a fresh
     * budget so the user can retry without reloading the page.
     *
     * Idempotent: history, welcome content and the agent list can all exhaust
     * in the same round and must not stack three identical notices.
     */
    function showAuthFailure() {
        setStatus('error');
        if (chatListEl.querySelector('.wap-auth-failure')) return;

        clearLoading();

        const row = el('li', 'gv-chat-message gv-chat-incoming wap-auth-failure');
        row.setAttribute('role', 'alert');

        const notice = el('div', 'gv-notice gv-notice-alert gv-mode-condensed');
        const content = el('p', 'gv-notice-content');
        content.textContent = i18n.errorAuthFailed
            || 'Could not connect to the AI assistant. Please reload the page, or contact support if this continues.';
        notice.appendChild(gvIcon(ICON.error, 'gv-notice-icon'));
        notice.appendChild(content);

        const retryBtn = el('button', 'gv-button gv-button-neutral');
        retryBtn.type = 'button';
        retryBtn.textContent = i18n.errorRetry || 'Try again';
        retryBtn.addEventListener('click', function () {
            row.remove();
            // An explicit user gesture earns a fresh budget — the underlying
            // misconfiguration may well have been fixed since.
            reauthAttempts = 0;
            showLoading();
            bootSession();
        });
        notice.appendChild(retryBtn);

        row.appendChild(notice);
        chatListEl.appendChild(row);
        scrollToBottom(true);
    }

    // -------------------------------------------------------------------------
    // Agent selector (WPIN-8684)
    // -------------------------------------------------------------------------

    // Populate the composer's dropdown from GET /chat/agents, which scopes the
    // list to the connected agent's family. Failure is non-fatal.
    function loadAgents() {
        if (!sessionToken || !agentSelectEl) return Promise.resolve(null);

        let url = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/chat/agents';
        if (cfg.pageContext) {
            url += '?page_context=' + encodeURIComponent(cfg.pageContext);
        }

        return fetch(url, { headers: { Authorization: 'Bearer ' + sessionToken } })
            .then(function (res) {
                // GRNDs are short-lived, so a reload often races an expired one.
                // Same bounded 401 recovery as every other WAP call.
                const handoff = handleAuthFailure(res, loadAgents);
                if (handoff) return handoff;
                return res.ok ? res.json() : null;
            })
            .then(function (data) {
                if (!data || !Array.isArray(data.agents)) return null;
                renderAgentOptions(data.agents, data.current);
                return data;
            })
            .catch(function () { return null; });
    }

    function renderAgentOptions(agents, current) {
        if (!agentSelectEl) return;

        // An explicit earlier choice wins, so re-rendering after a re-auth
        // doesn't reset it; `current` covers first load.
        const active = selectedAgentRole || current || '';

        agentSelectEl.innerHTML = '';
        agents.forEach(function (agent) {
            const opt = el('option', '');
            opt.value = agent.role;
            // Bare name: the family prefix is identical on every option and
            // would eat the width that distinguishes them.
            opt.textContent = agent.name || agent.displayName || agent.role;
            opt.title = agent.displayName || agent.name || agent.role;
            // On the option, not via select.value — that is a silent no-op when
            // the role isn't in the list, leaving the wrong agent showing.
            if (agent.role === active) opt.selected = true;
            agentSelectEl.appendChild(opt);
        });

        selectedAgentRole = agentSelectEl.value || '';
        const chosen = agents.filter(function (a) { return a.role === selectedAgentRole; })[0];
        agentSelectEl.title = chosen ? chosen.displayName || chosen.name || '' : '';

        agentSelectEl.disabled = false;
        agentSelectWrapEl.classList.remove('gv-disabled');
        agentSelectWrapEl.hidden = agents.length === 0;
    }

    // Each agent has its own server-side thread ("{user_id}:{role}"), so
    // switching drops what's on screen and rehydrates from the new one.
    function switchAgent(role) {
        if (!role) return Promise.resolve(false);
        const generation = selectionGeneration;
        const keepStop = handoffTransitionGeneration === generation;
        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
            currentAbortController = null;
        }
        isStreaming = keepStop;
        setStreamingUI(keepStop);

        const option = Array.prototype.find.call(agentSelectEl.options, function (candidate) {
            return candidate.value === role;
        });
        if (!option) return Promise.resolve(false);
        agentSelectEl.value = role;
        selectedAgentRole = role;
        const displayName = option.title || option.text || option.textContent;
        agentSelectEl.title = displayName;
        i18n.assistantName = displayName;
        // Fires on every effective switch — manual dropdown *and* accepted
        // handoffs both funnel through here. Lets an embedding page (e.g. the
        // admin chat tester's Connection panel) keep its own role indicator in
        // sync without polling the widget's internal state.
        window.dispatchEvent(new CustomEvent('wap:agentchange', { detail: { role: role, displayName: displayName } }));
        hasMessages = false;
        conversationId = '';
        // Also discards any pending ask_user question — its choice card belongs
        // to the previous agent's paused run.
        pendingQuestionCleanup = null;
        chatListEl.innerHTML = '';
        // Clear the old overrides so a failed refetch falls back to the i18n
        // defaults rather than mislabelling the new agent.
        agentWelcome.welcomeTitle = '';
        agentWelcome.welcomeMessage = '';
        agentWelcome.promptSuggestions = [];
        showLoading();

        return Promise.all([loadHistory(role, generation), loadAgentWelcome(role, generation), loadQuota()])
            .catch(function () {})
            .then(function () {
                if (selectionGeneration !== generation) return false;
                finishInitialLoad();
                return true;
            });
    }

    function onAgentChange() {
        const role = agentSelectEl.value;
        if (!role || role === selectedAgentRole) return;
        selectionGeneration++;
        switchAgent(role);
    }

    // -------------------------------------------------------------------------
    // Monthly quota (WPIN-8805)
    // -------------------------------------------------------------------------

    function loadQuota() {
        if (cfg.readOnly || !sessionToken) return Promise.resolve();

        const params = [];
        if (cfg.pageContext) params.push('page_context=' + encodeURIComponent(cfg.pageContext));
        if (selectedAgentRole) params.push('agent_role=' + encodeURIComponent(selectedAgentRole));

        let url = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/chat/quota';
        if (params.length) url += '?' + params.join('&');

        return fetch(url, { headers: { Authorization: 'Bearer ' + sessionToken } })
            .then(function (res) {
                // The retry re-enters loadQuota() and applies its own answer;
                // falling through would clear the snapshot it just stored.
                const handoff = handleAuthFailure(res, loadQuota);
                if (handoff) return handoff;
                if (!res.ok) return applyQuota(null);
                return res.json().then(applyQuota);
            })
            .catch(function () { applyQuota(null); });
    }

    // null is the fail-open state: no indicator, nothing locked.
    function applyQuota(data) {
        quota = null;
        if (data && data.enabled === true) {
            const remaining = Number(data.remaining);
            const total = Number(data.total);
            if (isFinite(remaining) && isFinite(total) && total > 0) {
                quota = {
                    remaining: Math.max(0, Math.min(remaining, total)),
                    total: total,
                    resetAt: parseTimestamp(data.resetAt),
                };
            }
        }
        renderQuota();
    }

    function isQuotaExhausted() {
        return !!quota && quota.remaining <= 0;
    }

    function isQuotaLow() {
        return !!quota && quota.remaining > 0 &&
            quota.remaining <= Math.max(1, Math.ceil(quota.total * QUOTA_LOW_RATIO));
    }

    function renderQuota() {
        if (!quotaMeterEl || !quotaNoticeEl) return;

        const at = quota && quota.resetAt;
        const vars = {
            remaining: quota ? String(quota.remaining) : '',
            total: quota ? String(quota.total) : '',
            date: at ? formatDate(at) : '',
            time: at ? formatTime(at) : '',
        };
        const spent = isQuotaExhausted();

        quotaMeterEl.hidden = !quota;
        if (quota) {
            quotaMeterEl.textContent = interpolate(i18n.quotaRemaining, vars);
            quotaMeterEl.title = vars.date ? interpolate(i18n.quotaResetsAt, vars) : '';
            quotaMeterEl.classList.toggle('wap-quota-meter--low', isQuotaLow());
            quotaMeterEl.classList.toggle('wap-quota-meter--spent', spent);
        }

        // The notice interrupts only when there is something to act on.
        quotaNoticeEl.hidden = !spent && !isQuotaLow();
        if (!quotaNoticeEl.hidden) {
            quotaNoticeEl.classList.toggle('gv-notice-alert', spent);
            quotaNoticeEl.classList.toggle('gv-notice-warning', !spent);
            quotaNoticeEl.setAttribute('aria-live', spent ? 'assertive' : 'polite');
            quotaNoticeIconEl.setAttribute('src', spent ? ICON.error : ICON.warning);
            quotaNoticeTextEl.textContent = interpolate(
                spent ? (vars.date ? i18n.quotaExhausted : i18n.errorQuota) : i18n.quotaLow,
                vars
            );
        }

        applyComposerLock();
    }

    // Consent and a spent quota lock independently, so every unlock path has to
    // re-ask both. Streaming is left alone — setStreamingUI() owns the composer
    // while a response is in flight.
    function applyComposerLock() {
        if (cfg.readOnly || !inputEl || isStreaming) return;

        const spent = isQuotaExhausted();
        setSendDisabled(!consentGranted || spent);

        const placeholder = spent ? i18n.quotaBlocked : i18n.placeholder;
        inputEl.setAttribute('placeholder', placeholder);
        inputEl.setAttribute('aria-label', placeholder);
    }

    // -------------------------------------------------------------------------
    // History
    // -------------------------------------------------------------------------

    function loadHistory(role, generation, threadId) {
        if (!sessionToken) return Promise.resolve();
        const requestedRole = role === undefined ? selectedAgentRole : role;
        const requestedThreadId = threadId === undefined ? conversationId : threadId;
        const isCurrent = function () {
            return generation === undefined || selectionGeneration === generation;
        };

        const base = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/chat/';
        let url;
        if (requestedThreadId) {
            url = base + encodeURIComponent(requestedThreadId) + '/history';
        } else {
            url = base + 'history';
            const params = [];
            if (cfg.pageContext) {
                params.push('page_context=' + encodeURIComponent(cfg.pageContext));
            }
            if (requestedRole) {
                params.push('agent_role=' + encodeURIComponent(requestedRole));
            }
            if (params.length) url += '?' + params.join('&');
        }

        return fetch(url, {
            headers: { Authorization: 'Bearer ' + sessionToken },
        })
            .then(function (res) {
                // Retry through the shared bounded-budget helper, but re-issue the
                // request for the SAME role/thread: a retry that fell back to the
                // default role would silently load the wrong conversation.
                const handoff = handleAuthFailure(res, function () {
                    if (!isCurrent()) return null;
                    return loadHistory(requestedRole, generation, requestedThreadId);
                });
                if (handoff) return handoff;
                return res.json();
            })
            .then(function (data) {
                if (!data || !isCurrent()) return;
                let messages = Array.isArray(data.messages) ? data.messages : [];
                if (!messages.length && !data.pendingQuestion) return;

                if (data.pendingQuestion && messages.length) {
                    const last = messages[messages.length - 1];
                    if (last && last.role === 'assistant' &&
                        (last.content || '').trim() === String(data.pendingQuestion.question || '').trim()) {
                        messages = messages.slice(0, -1);
                    }
                }

                clearWelcome();
                clearLoading();
                messages.forEach(function (msg) {
                    const when = parseTimestamp(msg.timestamp || msg.created_at || msg.createdAt || msg.time);
                    if (msg.role === 'user') {
                        appendUserMessage(msg.content || '', when);
                    } else if (msg.role === 'assistant') {
                        appendAssistantMessage(msg.content || '', when);
                    } else if (msg.role === 'handoff') {
                        appendHandoffMessage(msg.sourceAgent || '', msg.content || '', when);
                    }
                });

                if (data.pendingQuestion) {
                    hasMessages = true;
                    const assistantEl = makeMessage('assistant');
                    chatListEl.appendChild(assistantEl);
                    // focus:false — restoring history must not pull the caret
                    // (and the page scroll) into the chat on load.
                    appendQuestion(assistantEl, data.pendingQuestion, { focus: false });
                }

                setStatus('connected');
                scrollToBottom(true);
            })
            .catch(function (err) {
                // A spent re-auth budget is terminal — say so instead of
                // painting "Connected" over a credential WAP keeps rejecting.
                if (err && err.wapAuthExhausted) {
                    showAuthFailure();
                    return;
                }
                if (isCurrent()) setStatus('connected');
            });
    }

    // -------------------------------------------------------------------------
    // Per-agent welcome content — failure is non-fatal (host defaults render).
    // -------------------------------------------------------------------------

    function loadAgentWelcome(role, generation) {
        if (!sessionToken) return Promise.resolve();
        if (!cfg.wapBrowserUrl) return Promise.resolve();
        const requestedRole = role === undefined ? selectedAgentRole : role;
        const isCurrent = function () {
            return generation === undefined || selectionGeneration === generation;
        };

        // page_context AND agent_role must match loadHistory()/send(), or the
        // welcome screen describes a different agent than the one answering.
        let url = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/agents/welcome';
        const wparams = [];
        if (cfg.pageContext) {
            wparams.push('page_context=' + encodeURIComponent(cfg.pageContext));
        }
        if (requestedRole) {
            wparams.push('agent_role=' + encodeURIComponent(requestedRole));
        }
        if (wparams.length) url += '?' + wparams.join('&');
        return fetch(url, {
            headers: { Authorization: 'Bearer ' + sessionToken },
        })
            .then(function (res) {
                // Same as loadHistory: the retry must re-request this role, not
                // whatever the selector defaults to.
                const handoff = handleAuthFailure(res, function () {
                    if (!isCurrent()) return null;
                    return loadAgentWelcome(requestedRole, generation);
                });
                if (handoff) return handoff;
                if (!res.ok) return null;
                return res.json();
            })
            .then(function (data) {
                if (!data || typeof data !== 'object' || !isCurrent()) return;
                if (typeof data.welcomeTitle === 'string') {
                    agentWelcome.welcomeTitle = data.welcomeTitle.trim();
                }
                if (typeof data.welcomeMessage === 'string') {
                    agentWelcome.welcomeMessage = data.welcomeMessage.trim();
                }
                if (Array.isArray(data.promptSuggestions)) {
                    agentWelcome.promptSuggestions = data.promptSuggestions
                        .filter(function (s) { return typeof s === 'string' && s.trim().length > 0; })
                        .slice(0, 4)
                        .map(function (s) { return s.trim(); });
                }
            })
            .catch(function () {});
    }

    // -------------------------------------------------------------------------
    // Sending messages
    // -------------------------------------------------------------------------

    // `source` is how the send was triggered ('keyboard' | 'button') — tracked as
    // button_context so the two paths stay distinguishable.
    function handleSend(source) {
        // readOnly is checked independently of the disabled composer: a replay
        // must not send even if something re-enables the input.
        if (cfg.readOnly) return;

        const message = inputEl.value.trim();
        if (!message || isStreaming || !consentGranted || isQuotaExhausted()) return;

        // Fired here, past the guards, rather than on the button's click: Enter is
        // the primary send path and bypasses the button entirely (undercount),
        // while the button stays enabled on an empty composer, where handleSend
        // bails above (overcount). This point is exactly "a message was sent".
        trackButtonClick('send', { button_context: source || 'button' });

        inputEl.value = '';
        autoGrow();

        clearWelcome();
        // Drop any transient notice (e.g. the delete confirmation) on first send.
        chatListEl.querySelectorAll('.wap-transient').forEach(function (n) { n.remove(); });
        // Typing instead of answering an open ask_user question dismisses its card.
        if (pendingQuestionCleanup) pendingQuestionCleanup();
        appendUserMessage(message);

        if (!sessionToken) {
            authenticate(false).then(function () { sendMessage(message); });
        } else {
            sendMessage(message);
        }
    }

    // Shared SSE request driver for both the initial /chat/stream turn and the
    // /chat/resume continuation. `path` is the API path; `requestBody` the JSON
    // payload. A 401 refresh retries the same captured payload and role once.
    function streamRequest(path, requestBody, options) {
        options = options || {};
        const url = cfg.wapBrowserUrl.replace(/\/$/, '') + path;

        const payload = Object.assign({}, requestBody);
        if (cfg.pageContext) {
            payload.page_context = cfg.pageContext;
        }
        // Validated server-side against this session's family.
        const agentRole = Object.prototype.hasOwnProperty.call(options, 'agentRole')
            ? options.agentRole
            : selectedAgentRole;
        if (agentRole) {
            payload.agent_role = agentRole;
        }
        // Per-site MCP endpoint — authoritatively known by the browser via
        // home_url. The backend uses this (after a cross-tenant guard) to route
        // tool calls to the right site on OneHop multi-tenant clusters where the
        // GRND's signed sub is the cluster domain, not the per-site prefix.
        if (cfg.mcpEndpoint) {
            payload.mcp_endpoint = cfg.mcpEndpoint;
        }

        const body = JSON.stringify(payload);

        function attempt(canRetry) {
            isStreaming = true;
            setStreamingUI(true);
            const controller = new AbortController();
            currentAbortController = controller;
            const assistantEl = appendAssistantPlaceholder();

            return fetch(url, {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    Authorization:   'Bearer ' + sessionToken,
                },
                body:    body,
                signal:  controller.signal,
            })
            .then(function (res) {
                if (res.status === 401 && canRetry) {
                    assistantEl.remove();
                    return authenticate(true).then(function () {
                        if (controller.signal.aborted) {
                            return {
                                ok: false,
                                phase: 'aborted',
                                code: 'aborted',
                                message: '',
                                sawMessageStart: false,
                            };
                        }
                        return attempt(false);
                    });
                }
                if (!res.ok) {
                    // Non-2xx bodies become a STRUCTURED failure result rather than a
                    // throw: the handoff continuation inspects {code, sawDone, sawError}
                    // to decide whether to restore the source agent, and a thrown error
                    // would bypass that decision entirely.
                    return res.json().catch(function () { return {}; }).then(function (data) {
                        const detail = data && data.detail ? data.detail : data || {};
                        const code = detail.error || 'stream_failed';
                        // 429 covers two different limits: waiting helps with the
                        // per-minute one but not with a spent monthly quota, so read
                        // the error code rather than guessing from the status.
                        let message = detail.message;
                        if (!message && res.status === 429) {
                            message = code === 'monthly_quota_exceeded'
                                ? (i18n.errorQuota || 'You have reached your monthly message limit. It resets at the start of next month.')
                                : (i18n.errorRateLimit || 'Too many requests. Please wait before sending another message.');
                        }
                        const failure = {
                            ok: false,
                            phase: 'http',
                            status: res.status,
                            code: code,
                            message: message || i18n.errorGeneric,
                            sawMessageStart: false,
                        };
                        appendErrorToAssistant(assistantEl, failure.message);
                        return failure;
                    });
                }
                if (!res.body) {
                    throw new Error('ReadableStream not supported');
                }
                return readSSEStream(res.body, assistantEl).then(function (result) {
                    if (!result.sawDone && !result.sawError) {
                        appendErrorToAssistant(assistantEl, i18n.errorGeneric);
                    }
                    return Object.assign({
                        ok: result.sawDone && !result.sawError,
                        phase: 'sse',
                    }, result);
                });
            })
            .catch(function (err) {
                if (flushStreamRender) flushStreamRender();
                if (err.name === 'AbortError') {
                    // Stop pressed: freeze spinners/loaders (else the placeholder
                    // spins forever); keep partial text, drop the bubble if empty.
                    const bodyEl = getBody(assistantEl);
                    sealStepLoader(assistantEl);
                    removeLoader(assistantEl); // clear any sibling routing loader
                    if (!bodyEl.textContent.trim()) assistantEl.remove();
                    return {
                        ok: false,
                        phase: 'aborted',
                        code: 'aborted',
                        message: '',
                        sawMessageStart: false,
                    };
                }
                const message = err.message || (i18n.errorGeneric || 'Stream error');
                appendErrorToAssistant(assistantEl, message);
                return {
                    ok: false,
                    phase: 'network',
                    code: 'stream_failed',
                    message: message,
                    sawMessageStart: false,
                };
            })
            .finally(function () {
                flushStreamRender = null;
                if (currentAbortController === controller) {
                    currentAbortController = null;
                    if (handoffTransitionGeneration !== selectionGeneration) {
                        isStreaming = false;
                        setStreamingUI(false);
                    }
                    scrollToBottom();
                }
                updateScrollBtn();
                loadQuota();
            });
        }

        return attempt(true);
    }

    function sendMessage(message) {
        return streamRequest('/api/v1/chat/stream', { message: message }, {});
    }

    // Resume a run paused at an ask_user question, sending the user's answer.
    function resumeWithAnswer(answer) {
        return streamRequest('/api/v1/chat/resume', { answer: answer }, {})
            .then(maybeContinueHandoff);
    }

    function maybeContinueHandoff(result) {
        if (!result || !result.handoff || result.sawDone !== true || result.sawError !== false) {
            return result;
        }

        const handoff = result.handoff;
        const sourceRole = handoff.sourceRole || selectedAgentRole;
        const sourceOption = Array.prototype.find.call(agentSelectEl.options, function (option) {
            return option.value === sourceRole;
        });
        const sourceName = handoff.sourceAgent
            || (sourceOption && (sourceOption.title || sourceOption.text))
            || i18n.assistantName;
        const sourceAgentId = handoff.sourceAgentId;
        const generation = ++selectionGeneration;
        let token = handoff.handoffToken;
        handoff.handoffToken = '';
        handoffTransitionGeneration = generation;
        isStreaming = true;
        setStreamingUI(true);

        return loadAgents().then(function (data) {
            if (selectionGeneration !== generation) return result;
            const exactTarget = data && data.agents.find(function (agent) {
                return agent.role === handoff.targetRole && agent.agentId === handoff.targetAgentId;
            });
            if (!exactTarget) {
                appendErrorMessage(i18n.errorGeneric);
                return result;
            }
            return switchAgent(handoff.targetRole).then(function (switched) {
                if (!switched || selectionGeneration !== generation) return result;
                appendHandoffMessage(sourceName, handoff.brief || '');
                return streamRequest(
                    '/api/v1/chat/stream',
                    { handoff_token: token },
                    { agentRole: handoff.targetRole }
                ).then(function (targetResult) {
                    if (targetResult && targetResult.ok === false
                        && targetResult.sawMessageStart !== true) {
                        return restoreAfterHandoffFailure(
                            targetResult, sourceRole, sourceAgentId, generation
                        );
                    }
                    return targetResult;
                });
            });
        }).finally(function () {
            token = null;
            if (handoffTransitionGeneration === generation) {
                handoffTransitionGeneration = null;
                if (selectionGeneration === generation) {
                    isStreaming = false;
                    setStreamingUI(false);
                }
            }
        });
    }

    function restoreAfterHandoffFailure(result, sourceRole, sourceAgentId, generation) {
        if (selectionGeneration !== generation) return Promise.resolve(result);
        return loadAgents().then(function (data) {
            if (selectionGeneration !== generation) return result;
            const available = data && Array.isArray(data.agents) ? data.agents : [];
            const exactSource = available.some(function (agent) {
                return agent.role === sourceRole && agent.agentId === sourceAgentId;
            });
            const currentIsValid = data && available.some(function (agent) {
                return agent.role === data.current;
            });
            const restoreRole = exactSource ? sourceRole : (currentIsValid ? data.current : '');
            const showFailure = function () {
                if (selectionGeneration !== generation) return result;
                appendErrorMessage(result.message || i18n.errorGeneric);
                return result;
            };
            return restoreRole ? switchAgent(restoreRole).then(showFailure) : showFailure();
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
        const result = {
            sawDone: false,
            sawError: false,
            sawMessageStart: false,
            handoff: null,
        };

        const bodyEl = getBody(assistantEl);

        let rafId = 0;
        let dirty = false;

        function getOrCreateTextNode() {
            if (!textNode) {
                textNode = el('div', 'wap-chat-message-text');
                textNode.setAttribute('translate', 'no');
                bodyEl.appendChild(textNode);
            }
            return textNode;
        }

        function renderNow() {
            rafId = 0;
            if (!dirty) return;
            dirty = false;
            reconcileMarkdown(getOrCreateTextNode(), renderMarkdown(rawText));
            updateScrollBtn();
        }

        function scheduleRender() {
            dirty = true;
            if (!rafId) rafId = window.requestAnimationFrame(renderNow);
        }

        function flushRender() {
            if (rafId) {
                window.cancelAnimationFrame(rafId);
                rafId = 0;
            }
            renderNow();
        }

        flushStreamRender = flushRender;

        function processEvent(event) {
            switch (event.type) {
                case 'message_start':
                    result.sawMessageStart = true;
                    if (event.conversationId) {
                        conversationId = event.conversationId;
                        // The user id is now known (conversationId prefix) — tie
                        // client events to the same profile as the server side.
                        maybeIdentify();
                    }
                    if (event.agentName) {
                        // Persist the real agent name so subsequent bubbles and
                        // the "About this chat" row pick it up via makeMessage,
                        // then update the current bubble's already-rendered label.
                        i18n.assistantName = event.agentName;
                        const label = assistantEl.querySelector('.wap-meta-author');
                        if (label) label.textContent = event.agentName;
                    }
                    break;

                case 'routing':
                    if (event.routing === 'multi') {
                        flushRender();
                        textNode = null;
                        rawText = '';
                        removeLoader(bodyEl);
                        const routingEl = el('div', 'gv-stream-loader gv-stack-space-sm');
                        routingEl.appendChild(makeStep(i18n.consulting || 'Consulting multiple specialists…', false));
                        assistantEl.appendChild(routingEl);
                    }
                    break;

                case 'status':
                    // Backend sends a coarse, tool-agnostic key (never the tool
                    // name); we localize it and add it as a new checklist row.
                    // The previously-active row flips to "done" and stays
                    // visible.
                    appendStepRow(assistantEl, statusText(event.key));
                    break;

                case 'text_delta':
                    if (event.delta) {
                        sealStepLoader(assistantEl);
                        rawText += event.delta;
                        scheduleRender();
                    }
                    break;

                case 'tool_use':
                    flushRender();
                    textNode = null;
                    rawText = '';
                    appendToolUse(assistantEl, event.tool || '', event.input || {});
                    break;

                case 'tool_result':
                    flushRender();
                    appendToolResult(assistantEl, event.tool || '', event.output || '');
                    textNode = null;
                    rawText = '';
                    break;

                case 'question':
                    flushRender();
                    if (textNode && event.question &&
                        rawText.trim() === String(event.question).trim()) {
                        textNode.remove();
                    }
                    textNode = null;
                    rawText = '';
                    sealStepLoader(assistantEl);
                    appendQuestion(assistantEl, event);
                    break;

                case 'message_end':
                    sealStepLoader(assistantEl);
                    flushRender();
                    break;

                case 'agent_handoff':
                    result.handoff = event;
                    break;

                case 'error':
                    result.sawError = true;
                    result.code = event.code || 'stream_failed';
                    result.message = event.message || (i18n.errorGeneric || 'Error');
                    flushRender();
                    appendErrorToAssistant(assistantEl, result.message, event.traceId, event.timestamp);
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
                    if (line === 'data: [DONE]') {
                        result.sawDone = true;
                        if (result.handoff && !result.sawError) {
                            removeLoader(bodyEl);
                            if (!bodyEl.textContent.trim()) assistantEl.remove();
                        } else {
                            sealStepLoader(assistantEl);
                        }
                        return true;
                    }
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
            return reader.read().then(function (read) {
                if (read.done) { flushRender(); return result; }
                var done = parseChunk(decoder.decode(read.value, { stream: true }));
                if (done) { flushRender(); reader.cancel(); return result; }
                return pump();
            });
        }

        return pump().catch(function (err) {
            if (err.name === 'AbortError') throw err;
            result.sawError = true;
            appendErrorToAssistant(assistantEl, i18n.errorGeneric);
            return result;
        });
    }

    // -------------------------------------------------------------------------
    // Message DOM builders — Gravity gv-chat-message structure
    // -------------------------------------------------------------------------

    function getBody(msgEl) {
        return msgEl.querySelector('.gv-chat-message-body');
    }

    // Build a gv-chat-message with a gv-meta row (author + timestamp), matching
    // Gravity's conversational chat pattern. Incoming (assistant) turns get a
    // small AI icon before the author name as a visual aid.
    function makeMessage(direction, date) {
        const incoming = direction !== 'user';
        const msg = el('li', 'gv-chat-message ' + (incoming ? 'gv-chat-incoming' : 'gv-chat-outgoing'));

        const meta = el('div', 'gv-meta');

        const user = el('span', 'gv-meta-user');
        if (incoming) {
            user.appendChild(gvIcon(ICON.assistant, 'wap-icon-sm'));
        }
        user.appendChild(elText('span',
            incoming ? (i18n.assistantName || 'AI Assistant') : (i18n.you || 'You'),
            'wap-meta-author'
        ));
        meta.appendChild(user);

        const timeStr = formatTime(date instanceof Date ? date : new Date());
        if (timeStr) {
            const time = el('span', 'gv-meta-time');
            time.textContent = timeStr;
            meta.appendChild(time);
        }
        msg.appendChild(meta);

        const body = el('div', 'gv-chat-message-body');
        msg.appendChild(body);
        return msg;
    }

    function appendUserMessage(text, date) {
        hasMessages = true;
        const msg = makeMessage('user', date);
        getBody(msg).textContent = text;
        chatListEl.appendChild(msg);
        scrollToBottom(true);
        return msg;
    }

    function appendAssistantPlaceholder() {
        hasMessages = true;
        const msg = makeMessage('assistant');
        const loader = el('div', 'gv-stream-loader gv-stack-space-sm');
        const step = makeStep(i18n.thinking || 'Thinking…', false);
        step.setAttribute(STEP_PLACEHOLDER_ATTR, '');
        loader.appendChild(step);
        getBody(msg).appendChild(loader);
        chatListEl.appendChild(msg);
        scrollToBottom(true);
        return msg;
    }

    function appendAssistantMessage(text, date) {
        hasMessages = true;
        const msg = makeMessage('assistant', date);
        getBody(msg).innerHTML = renderMarkdown(text);
        chatListEl.appendChild(msg);
        return msg;
    }

    function appendHandoffMessage(sourceAgent, content, date) {
        hasMessages = true;
        const row = el('li', 'gv-chat-message gv-chat-incoming');
        const notice = el('div', 'gv-notice gv-notice-info gv-mode-condensed');
        const text = el('p', 'gv-notice-content');
        const heading = el('strong', '');
        heading.textContent = 'Handoff from ' + sourceAgent;
        text.appendChild(heading);
        text.appendChild(document.createElement('br'));
        text.appendChild(document.createTextNode(content));
        notice.appendChild(gvIcon(ICON.info, 'gv-notice-icon'));
        notice.appendChild(text);
        row.appendChild(notice);
        if (date) row.setAttribute('data-timestamp', date.toISOString());
        chatListEl.appendChild(row);
        scrollToBottom(true);
        return row;
    }

    function removeLoader(container) {
        const loader = container.querySelector('.gv-stream-loader');
        if (loader) loader.remove();
    }

    // Resolve a coarse status key from the backend to a localized label.
    function statusText(key) {
        return (key && i18n[key]) || i18n.working || i18n.thinking || 'Working…';
    }

    // Marks the opening "Thinking…" step. The first real step repurposes it in
    // place, and a turn that never runs one drops the whole loader — so the
    // checklist never shows a sealed, meaningless "Thinking… ✓".
    const STEP_PLACEHOLDER_ATTR = 'data-wap-placeholder';

    // One Gravity stream-loader step. Gravity draws the state indicator from the
    // class via a ::before, so there is no icon element to build; the label is a
    // leading text node plus a screen-reader-only status suffix, per the
    // component anatomy. data-label mirrors the label for cheap dedupe/relabel.
    function makeStep(text, done) {
        const span = el('span', done ? 'gv-step-done' : 'gv-step-working');
        span.setAttribute('data-label', text);
        span.appendChild(document.createTextNode(text));
        span.appendChild(elText('span',
            done ? (i18n.stepDone || ', done') : (i18n.stepWorking || ', in progress'),
            'gv-sr-only'));
        return span;
    }

    function relabelStep(span, text) {
        span.setAttribute('data-label', text);
        span.firstChild.textContent = text; // leading text node (label)
    }

    function setStepDone(span) {
        span.className = 'gv-step-done';
        const sr = span.querySelector('.gv-sr-only');
        if (sr) sr.textContent = i18n.stepDone || ', done';
    }

    function setStepWorking(span) {
        span.className = 'gv-step-working';
        const sr = span.querySelector('.gv-sr-only');
        if (sr) sr.textContent = i18n.stepWorking || ', in progress';
    }

    function findStepByLabel(loader, text) {
        const steps = loader.children;
        for (let i = 0; i < steps.length; i++) {
            if (steps[i].getAttribute('data-label') === text) return steps[i];
        }
        return null;
    }

    // Append (or re-activate) a step in the assistant message's checklist. Each
    // distinct label appears at most once per turn: a repeated or interleaved
    // action re-activates its existing step instead of stacking a duplicate, so
    // the list stays short when the agent runs many tools repeatedly (WPIN-8731).
    function appendStepRow(assistantEl, text) {
        const bodyEl = getBody(assistantEl);
        let loader = bodyEl.querySelector('.gv-stream-loader');
        if (!loader) {
            loader = el('div', 'gv-stream-loader gv-stack-space-sm');
            bodyEl.appendChild(loader);
        }

        const working = loader.querySelector('.gv-step-working');
        if (working) {
            if (working.hasAttribute(STEP_PLACEHOLDER_ATTR)) {
                working.removeAttribute(STEP_PLACEHOLDER_ATTR);
                relabelStep(working, text);
                scrollToBottom();
                return;
            }
            if (working.getAttribute('data-label') === text) return; // already the live step
            setStepDone(working);
        }

        const existing = findStepByLabel(loader, text);
        if (existing) {
            setStepWorking(existing); // re-activate in place
        } else {
            loader.appendChild(makeStep(text, false));
        }
        scrollToBottom();
    }

    // Called when the turn's prose starts or the turn ends. The completed
    // checklist stays visible above the answer; a placeholder-only loader goes.
    function sealStepLoader(assistantEl) {
        const bodyEl = getBody(assistantEl);
        const loader = bodyEl.querySelector('.gv-stream-loader');
        if (!loader) return;
        const working = loader.querySelector('.gv-step-working');
        if (working && working.hasAttribute(STEP_PLACEHOLDER_ATTR)) {
            loader.remove();
            return;
        }
        if (working) setStepDone(working);
    }

    // traceId/timestamp (from the backend's generic catch-all error event only,
    // see chat.py) let the user reference this specific failure when reporting
    // it — it's the same id attached to the corresponding Sentry event.
    function appendErrorToAssistant(assistantEl, errorMessage, traceId, timestamp) {
        const bodyEl = getBody(assistantEl);
        sealStepLoader(assistantEl); // don't leave a step spinning forever if a tool call errors
        // Also clear any sibling routing loader.
        removeLoader(assistantEl);

        const notice = el('div', 'gv-notice gv-notice-alert gv-mode-condensed');
        const content = el('p', 'gv-notice-content');
        content.textContent = errorMessage;
        notice.appendChild(gvIcon(ICON_BASE + 'error.svg', 'gv-notice-icon'));
        notice.appendChild(content);

        if (traceId) {
            const date = parseTimestamp(timestamp);
            const timeStr = date ? formatPreciseTime(date) : '';
            const refLine = el('p', 'gv-meta-time gv-notice-content');
            refLine.textContent = (i18n.errorReference || 'Reference:') + ' ' + traceId + (timeStr ? ' · ' + timeStr : '');
            notice.appendChild(refLine);
        }

        bodyEl.appendChild(notice);
    }

    function appendErrorMessage(errorMessage) {
        clearWelcome();
        const msg = el('li', 'gv-chat-message gv-chat-incoming');
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

    // Tool activity is intentionally NOT surfaced in the chat — we never reveal
    // which MCP ability the assistant is calling. No-op: every client tool call
    // is immediately followed by a coarse `status` event (see appendStepRow()),
    // so that event alone drives the checklist. Adding a generic "Working…" row
    // here too produced a duplicate "Working… / <specific>" pair per tool call
    // that stacked up on parallel/repeated calls (WPIN-8731).
    function appendToolUse() {}

    // No-op: results are never displayed. The next text_delta (the model's
    // answer) clears the working indicator and renders the prose.
    function appendToolResult() {}

    // -------------------------------------------------------------------------
    // Interactive questions — ask_user (Gravity Micro-interface)
    // -------------------------------------------------------------------------

    // Blank and duplicate options are not real choices — ["Yes", "Yes", ""] is
    // one option, not three. Mirrors normalise_choices() in
    // app/lib/agent_runtime/tools.py so both ends count the same way.
    //
    // Choices arrive either as bare strings or as {label, value} objects (a
    // handoff confirmation's display text vs. its routing token), so each entry
    // goes through normalizeChoice() first and de-duplication runs on the value
    // the run would resume with — two rows that merely read alike but resume
    // different agents are two real choices.
    function normaliseChoices(raw) {
        const seen = Object.create(null);
        const cleaned = [];
        (Array.isArray(raw) ? raw : []).forEach(function (choice) {
            const normalized = normalizeChoice(choice);
            const label = normalized.label.trim();
            const value = normalized.value.trim();
            if (!label || !value) return;
            const key = value.toLowerCase();
            if (seen[key]) return;
            seen[key] = true;
            cleaned.push({ label: label, value: value });
        });
        return cleaned;
    }

    // Render an ask_user question as a Gravity Micro-interface below the question
    // text; answering resumes the paused run via /chat/resume.
    // event: { question, choices: string[], multi_select: bool, allow_free_text: bool, threadId }
    // opts: { focus: bool } — false when restoring a question from history, so a
    // page load never yanks focus (and scroll) into the chat.
    function appendQuestion(assistantEl, event, opts) {
        const bodyEl = getBody(assistantEl);

        if (event.question) {
            const q = el('div', 'wap-chat__question-text');
            q.innerHTML = renderMarkdown(event.question);
            bodyEl.appendChild(q);
        }

        const choices = normaliseChoices(event.choices);
        const multi = !!event.multi_select;
        const allowFreeText = event.allow_free_text !== false;
        const autoFocus = !(opts && opts.focus === false);
        // Unique group name so questions coexisting in thread history don't collide.
        const groupName = 'wap-q-' + (++questionSeq);

        // The card holding whatever answer affordance we render — a choice
        // picker, or (below 2 real choices) a bare free-text composer.
        let card = null;
        // Neutralise the card once answered/dismissed so a late click can't answer
        // twice; the question text above stays as history.
        let answered = false;
        function neutralize() {
            answered = true;
            if (card) {
                card.setAttribute('aria-disabled', 'true');
                card.querySelectorAll('input, button, textarea').forEach(function (n) { n.disabled = true; });
                card.remove();
            }
            pendingQuestionCleanup = null;
        }
        // label is what the user sees echoed back; value is what the run resumes
        // with. They differ for a handoff confirmation, whose value is a routing
        // token — see Choice.to_wire() in app/lib/agent_runtime/interrupt_payloads.py.
        function answer(label, value) {
            if (answered || !value) return;
            neutralize();
            appendUserMessage(label);
            resumeWithAnswer(value);
        }
        // Gravity keeps the input live: typing a message instead drops this card.
        // The backend routes that message into the paused ask_user tool as its
        // answer, so the turn continues in one normal streamed run.
        pendingQuestionCleanup = function () {
            if (!answered) neutralize();
        };

        // A picker needs at least 2 real options. With 0 or 1 the "Select one"
        // block degenerates into a menu whose only row is the synthetic "Other…"
        // affordance — a menu with nothing to choose from (WPIN-8940). The tool
        // rejects the 1-choice call server-side, but old threads and any future
        // caller can still send one, so render the question as plain text with
        // the free-text composer under it instead. allow_free_text is ignored
        // here on purpose: with no choices to click, free text is the only way
        // the user can answer at all.
        if (choices.length < 2) {
            card = el('div', 'wap-chat__freeform');
            card.appendChild(buildOtherField(function (text) { answer(text, text); }, autoFocus));
            bodyEl.appendChild(card);
            scrollToBottom();
            return;
        }

        const root = el('div', 'gv-micro-interface wap-chat__micro');
        card = root;
        root.appendChild(elText('div',
            multi ? (i18n.selectMany || 'Select at least one')
                  : (i18n.selectOne || 'Select one'),
            'gv-micro-interface-top'));

        const content = el('div', 'gv-micro-interface-content');
        const optionGroup = el('div', 'gv-option-group gv-mode-condensed');
        const fieldset = el('fieldset', 'gv-options');
        if (event.question) fieldset.setAttribute('aria-label', event.question);
        const optionList = el('div', 'gv-form-option gv-option-group-types');
        fieldset.appendChild(optionList);
        optionGroup.appendChild(fieldset);
        content.appendChild(optionGroup);
        root.appendChild(content);
        bodyEl.appendChild(root);

        if (multi) {
            buildMultiSelect(root, optionList, groupName, choices, allowFreeText, answer);
        } else {
            buildSingleSelect(optionList, groupName, choices, allowFreeText, answer);
        }

        scrollToBottom();
    }

    // A/B/C… key badge; null past Z.
    function letterKey(i) {
        return i < 26 ? String.fromCharCode(65 + i) : null;
    }

    // "N selected.", honouring an optional {n} placeholder in the i18n string.
    function countLabel(n) {
        const tpl = i18n.nSelected || '{n} selected.';
        return tpl.indexOf('{n}') !== -1 ? tpl.replace('{n}', n) : (n + ' ' + tpl);
    }

    function normalizeChoice(choice) {
        if (choice && typeof choice === 'object') {
            return {
                label: String(choice.label || ''),
                value: String(choice.value || ''),
            };
        }
        return { label: String(choice || ''), value: String(choice || '') };
    }

    // One option row: Gravity radio/checkbox + optional A/B/C badge + label.
    function buildOption(type, name, id, value, labelText, key) {
        const label = el('label', 'gv-option-inline' + (key ? ' gv-option-key' : ''));
        const input = el('input', type === 'radio' ? 'gv-radio' : 'gv-checkbox');
        input.type = type;
        input.name = name;
        input.id = id;
        input.value = value;
        label.appendChild(input);
        if (key) {
            const k = elText('span', key, 'gv-key');
            k.setAttribute('aria-hidden', 'true');
            label.appendChild(k);
        }
        label.appendChild(elText('span', labelText, 'gv-label'));
        return { label: label, input: input };
    }

    // Single-choice: selecting a row answers immediately (no confirm step).
    function buildSingleSelect(optionList, groupName, choices, allowFreeText, answer) {
        function onPick(input, commit) {
            let fired = false;
            function fire() {
                if (fired) return;
                fired = true;
                input.checked = true;
                commit();
            }
            input.addEventListener('click', function (e) {
                if (e.detail > 0) fire();
            });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fire();
                }
            });
        }

        choices.forEach(function (choice, i) {
            const normalized = normalizeChoice(choice);
            const opt = buildOption(
                'radio', groupName, groupName + '-' + i,
                normalized.value, normalized.label, letterKey(i)
            );
            onPick(opt.input, function () { answer(normalized.label, normalized.value); });
            optionList.appendChild(opt.label);
        });

        if (allowFreeText) {
            // "Other…" is the single answer, exclusive with the radios: selecting
            // it swaps the row for a free-text composer whose submit is the answer.
            const idx = choices.length;
            const opt = buildOption('radio', groupName, groupName + '-other',
                i18n.otherOption || 'Other…', i18n.otherOption || 'Other…', letterKey(idx));
            onPick(opt.input, function () {
                opt.label.remove();
                optionList.appendChild(buildOtherField(function (text) { answer(text, text); }));
            });
            optionList.appendChild(opt.label);
        }
    }

    // Multi-select: checkboxes + a Confirm bar. The answer is the comma-joined
    // selection (the resume protocol is a plain string either way).
    function buildMultiSelect(root, optionList, groupName, choices, allowFreeText, answer) {
        const selected = [];

        const bottom = el('div', 'gv-micro-interface-bottom');
        const info = elText('span', '', 'gv-bottom-info');
        const confirmBtn = el('button', 'gv-button gv-button-primary gv-mode-condensed');
        confirmBtn.type = 'button';
        confirmBtn.appendChild(elText('span', i18n.confirmAnswer || 'Confirm'));
        bottom.appendChild(info);
        bottom.appendChild(confirmBtn);
        root.appendChild(bottom);

        function refresh() {
            root.classList.remove('gv-error');
            info.textContent = selected.length ? countLabel(selected.length) : '';
        }
        refresh();

        // `input` is passed only when the caller isn't the native checkbox itself
        // (which has already toggled its own state).
        function toggle(choice, input) {
            const at = selected.findIndex(function (item) { return item.value === choice.value; });
            if (at === -1) selected.push(choice);
            else selected.splice(at, 1);
            if (input) input.checked = selected.some(function (item) { return item.value === choice.value; });
            refresh();
        }

        choices.forEach(function (choice, i) {
            const normalized = normalizeChoice(choice);
            const name = groupName + '-' + i;
            const opt = buildOption('checkbox', name, name, normalized.value, normalized.label, null);
            opt.input.addEventListener('change', function () { toggle(normalized, null); });
            optionList.appendChild(opt.label);
        });

        confirmBtn.addEventListener('click', function () {
            if (!selected.length) {
                root.classList.add('gv-error');
                info.textContent = i18n.selectAtLeastOne || 'Select at least 1 option.';
                return;
            }
            answer(
                selected.map(function (choice) { return choice.label; }).join(', '),
                selected.map(function (choice) { return choice.value; }).join(', ')
            );
        });

        if (allowFreeText) {
            buildMultiSelectOther(optionList, groupName, selected, toggle, refresh);
        }
    }

    // "Other…" trigger → free-text composer → inserts a pre-checked chip into the
    // same selection the checkboxes feed, then restores the trigger for more.
    function buildMultiSelectOther(optionList, groupName, selected, toggle, refresh) {
        function addTrigger() {
            const trigger = el('button', 'gv-button gv-button-secondary gv-mode-condensed wap-chat__other-trigger');
            trigger.type = 'button';
            trigger.textContent = i18n.otherOption || 'Other…';
            trigger.addEventListener('click', function () {
                trigger.remove();
                const field = buildOtherField(function (text) {
                    field.remove();
                    const id = groupName + '-other-' + (++questionSeq);
                    const choice = normalizeChoice(text);
                    const opt = buildOption('checkbox', id, id, choice.value, choice.label, null);
                    opt.input.checked = true;
                    opt.input.addEventListener('change', function () { toggle(choice, null); });
                    optionList.appendChild(opt.label);
                    selected.push(choice);
                    refresh();
                    addTrigger();
                });
                optionList.appendChild(field);
            });
            optionList.appendChild(trigger);
        }
        addTrigger();
    }

    // A small Gravity composer (textarea + send button) for a free-text answer.
    // autoFocus defaults to true (the user just clicked "Other…"); callers that
    // render it unprompted pass false.
    function buildOtherField(onSubmit, autoFocus) {
        const wrap = el('div', 'gv-input gv-input-textarea wap-chat__other');

        const ta = el('textarea', '');
        ta.rows = 1;
        ta.setAttribute('placeholder', i18n.otherPlaceholder || 'Type your answer…');
        ta.setAttribute('aria-label', i18n.otherPlaceholder || 'Type your answer…');

        const toolbar = el('div', 'gv-input-toolbar gv-mode-condensed');
        const end = el('div', 'gv-toolbar-end');
        const btn = el('button', 'gv-button gv-button-primary gv-button-icon');
        btn.type = 'button';
        btn.setAttribute('aria-label', i18n.submitAnswer || i18n.send || 'Send');
        btn.setAttribute('title', i18n.submitAnswer || i18n.send || 'Send');
        btn.appendChild(gvIcon(ICON.send));
        end.appendChild(btn);
        toolbar.appendChild(end);

        wrap.appendChild(ta);
        wrap.appendChild(toolbar);

        function submit() {
            const text = ta.value.trim();
            if (text) onSubmit(text);
        }
        btn.addEventListener('click', submit);
        ta.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
            }
        });

        if (autoFocus !== false) setTimeout(function () { ta.focus(); }, 0);
        return wrap;
    }

    // -------------------------------------------------------------------------
    // GDPR
    // -------------------------------------------------------------------------

    function handleDeleteData() {
        showConfirm({
            title:        i18n.deleteTitle || 'Delete your data?',
            message:      i18n.deleteConfirm || 'This will permanently delete all your conversation history with the AI assistant. This cannot be undone.',
            confirmLabel: i18n.deleteData || 'Delete my data',
            cancelLabel:  i18n.cancel || 'Cancel',
            destructive:  true,
        }).then(function (confirmed) {
            if (confirmed) performDeleteData();
        });
    }

    function performDeleteData() {
        if (!sessionToken) {
            appendErrorMessage(i18n.errorGeneric || 'Not connected. Please refresh and try again.');
            return;
        }

        const backendUrl = cfg.wapBrowserUrl.replace(/\/$/, '') + '/api/v1/me/data/erase';
        // Sentinel: a 401 hands off to a re-authenticated retry — every later
        // stage of this chain must bail out so local cleanup and the success
        // notice only ever run after WAP confirmed the erasure.
        const RETRIED = { retried: true };

        fetch(backendUrl, {
            method:  'POST',
            headers: {
                Authorization:  'Bearer ' + sessionToken,
                'Content-Type': 'application/json',
            },
        })
            .then(function (res) {
                // Expired/revoked credential. Erasure MUST NOT silently no-op
                // (the success notice would lie about a GDPR deletion) — hand
                // off to a re-authenticated retry, or fail loudly once the
                // re-auth budget is spent.
                const handoff = handleAuthFailure(res, function () {
                    performDeleteData();
                    return RETRIED;
                });
                if (handoff) return handoff;
                if (!res.ok) throw new Error('HTTP ' + res.status);
            })
            .then(function (marker) {
                if (marker === RETRIED) return RETRIED;
                // Host-side cleanup after WAP erased the backend data. A SaaS
                // host injects eraseLocalData (or omits it — nothing local to
                // clean); WordPress pages fall back to the admin-ajax handler
                // that revokes App Passwords and cached tokens.
                if (typeof cfg.eraseLocalData === 'function') {
                    return Promise.resolve(cfg.eraseLocalData());
                }
                if (!cfg.ajaxUrl) return null;

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
                if (json === RETRIED) return;
                if (json && json.success === false) {
                    throw new Error(json.data && json.data.message ? json.data.message : (i18n.errorGeneric || 'Delete failed'));
                }

                // Erased: drop the local session and thread so the next message
                // provisions a fresh session/conversation automatically. No reload
                // needed — the composer stays usable.
                sessionToken = '';
                hasMessages = false;
                conversationId = '';
                pendingQuestionCleanup = null;
                // The erase covers the client-side analytics identity too — the
                // distinct_id here IS the erased user_id.
                trackingResetIdentity();

                chatListEl.innerHTML = '';

                const notice  = el('div', 'gv-notice gv-notice-success wap-transient');
                notice.setAttribute('role', 'status');
                const content = el('p', 'gv-notice-content');
                content.textContent = i18n.deleteSuccess || 'Your data has been deleted.';
                notice.appendChild(gvIcon(ICON.success, 'gv-notice-icon'));
                notice.appendChild(content);
                chatListEl.appendChild(notice);

                // Auto-dismiss the confirmation so it doesn't linger; it's also
                // cleared as soon as the user starts a new message (see handleSend).
                setTimeout(function () { notice.remove(); }, 5000);

                // Keep the widget usable: re-enable the composer and Delete action.
                applyComposerLock();
                if (deleteDataBtn) deleteDataBtn.removeAttribute('disabled');
                inputEl.focus();

                // Erasure may have purged the stored consent (the WordPress
                // adapter deletes it with the rest of the local state), so
                // re-check and re-gate the next conversation if needed.
                initConsent();

                // Erasure revoked the current session and deleted credentials
                // server-side, so the old token is dead. Provision a fresh session
                // (force_new) right away rather than waiting for the next send —
                // otherwise the next turn streams on the revoked session and the
                // backend errors back into the same chat. Expected, not a
                // rejection, so it doesn't spend re-auth budget either.
                reauthAttempts = 0;
                authenticate(true).catch(function () {});
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

    // Private-use sentinels bracketing a code-span's index while we run the
    // other inline rules. They can't occur in real (already-escaped) content,
    // so emphasis/link regexes never touch code contents and we restore the
    // spans verbatim at the end.
    const CODE_OPEN = '';
    const CODE_CLOSE = '';
    const CODE_SENTINEL = /(\d+)/g;

    function inlineMd(text) {
        // Pull code spans out first and replace with sentinels. Their contents
        // are literal: underscores (`wp_enqueue_scripts`), asterisks and
        // brackets inside code must NOT become emphasis or links.
        const codes = [];
        text = text.replace(/`([^`]+)`/g, function (m, c) {
            codes.push(c);
            return CODE_OPEN + (codes.length - 1) + CODE_CLOSE;
        });
        text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
            return '<a href="' + escapeHtml(safeHref(url)) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
        });
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
        // Underscore emphasis only at word boundaries — otherwise snake_case
        // identifiers (foo_bar_baz) would be mangled into italics mid-word.
        text = text.replace(/(^|[^\w])_([^_]+)_(?!\w)/g, '$1<em>$2</em>');
        // Restore the code spans verbatim.
        text = text.replace(CODE_SENTINEL, function (m, i) {
            return '<code>' + codes[+i] + '</code>';
        });
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

    // Strip tool-call scaffolding that some models emit inline as text
    // (`<function_calls>…</function_calls>`, `<invoke>`, `<parameter>`,
    // `<function_results>`/`<function_response>` blocks, with or without the
    // `antml:` prefix). These are protocol tokens, not content — the widget
    // surfaces real tool activity via the accordion cards, so here we want only
    // the model's human-readable prose ("direct output").
    function stripToolScaffolding(s) {
        // Only remove COMPLETE, properly-closed scaffolding blocks and any stray
        // standalone tags. We deliberately do NOT strip from an unclosed tag to
        // the end of the message — doing so can eat the real answer that streams
        // right after a tool block. Any transient unclosed tag simply renders
        // for a moment mid-stream and is cleaned up once its close arrives.
        return s
            // Complete call / result blocks (any attributes).
            .replace(/<(antml:)?function_calls\b[\s\S]*?<\/(antml:)?function_calls>/gi, '')
            .replace(/<(antml:)?function_(results|response)\b[\s\S]*?<\/(antml:)?function_(results|response)>/gi, '')
            // Any stray scaffolding tags left over (opening or closing).
            .replace(/<\/?(antml:)?(invoke|parameter|function_calls|function_results|function_response)\b[^>]*>/gi, '')
            // Leftover SSE terminator if it ever leaks into text.
            .replace(/\bdata:\s*\[DONE\]\s*/gi, '');
    }

    let renderScratch = null;

    function reconcileMarkdown(node, html) {
        if (!renderScratch) renderScratch = document.createElement('div');
        renderScratch.innerHTML = html;
        wrapWords(renderScratch);
        reconcileChildren(node, renderScratch);
        renderScratch.innerHTML = '';
    }

    const NO_WRAP_TAGS = { PRE: 1, CODE: 1 };

    function wrapWords(node) {
        let child = node.firstChild;
        while (child) {
            const after = child.nextSibling;
            if (child.nodeType === 3) {
                wrapTextNode(node, child);
            } else if (child.nodeType === 1 && !NO_WRAP_TAGS[child.tagName]) {
                wrapWords(child);
            }
            child = after;
        }
    }

    function wrapTextNode(parent, textNode) {
        const parts = textNode.nodeValue.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        let wrapped = false;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part) continue;
            if (/^\s+$/.test(part)) {
                frag.appendChild(document.createTextNode(part));
            } else {
                const span = document.createElement('span');
                span.textContent = part;
                frag.appendChild(span);
                wrapped = true;
            }
        }
        if (wrapped) parent.replaceChild(frag, textNode);
    }

    function reconcileChildren(target, source) {
        const next = Array.prototype.slice.call(source.childNodes);
        const cur = Array.prototype.slice.call(target.childNodes);
        const shared = Math.min(cur.length, next.length);

        let i = 0;
        while (i < shared && isSameRendered(cur[i], next[i])) i++;

        if (i < shared && isSameElement(cur[i], next[i])) {
            reconcileChildren(cur[i], next[i]);
            i++;
        }

        for (let j = cur.length - 1; j >= i; j--) target.removeChild(cur[j]);
        for (; i < next.length; i++) {
            const fresh = next[i];
            target.appendChild(fresh);
            animateIn(fresh);
        }
    }

    const FLAT_FADE_TAGS = { SPAN: 1, PRE: 1, CODE: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1, TD: 1, TH: 1 };
    const FADE_MS = 280;
    const FADE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

    function animateIn(node) {
        if (node.nodeType !== 1 || typeof node.animate !== 'function') return;
        if (prefersReducedMotion()) return;
        node.animate(
            FLAT_FADE_TAGS[node.tagName]
                ? [{ opacity: 0 }, { opacity: 1 }]
                : [
                    { opacity: 0, transform: 'translateY(3px)', filter: 'blur(2px)' },
                    { opacity: 1, transform: 'translateY(0)', filter: 'blur(0px)' },
                ],
            { duration: FADE_MS, easing: FADE_EASING }
        );
    }

    let reducedMotionQuery = null;

    function prefersReducedMotion() {
        if (!window.matchMedia) return false;
        if (!reducedMotionQuery) {
            reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        }
        return reducedMotionQuery.matches;
    }

    function isSameRendered(a, b) {
        if (a.nodeType !== b.nodeType) return false;
        return a.nodeType === 1 ? a.outerHTML === b.outerHTML : a.nodeValue === b.nodeValue;
    }

    function isSameElement(a, b) {
        if (a.nodeType !== 1 || b.nodeType !== 1) return false;
        if (a.tagName !== b.tagName) return false;
        if (a.attributes.length !== b.attributes.length) return false;
        for (let i = 0; i < a.attributes.length; i++) {
            const attr = a.attributes[i];
            if (b.getAttribute(attr.name) !== attr.value) return false;
        }
        return true;
    }

    function renderMarkdown(src) {
        if (!src) return '';
        src = stripToolScaffolding(src);
        if (!src.trim()) return '';
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
                // Wrap in a scroll container so a wide table scrolls inside its
                // own box instead of forcing display:block on the <table> (which
                // drops row/column semantics for screen readers). The wrapper
                // owns the horizontal overflow; the table keeps real table
                // semantics. See the .wap-table-wrap rule in wap-chat.css.
                html += '<div class="wap-table-wrap">' + table + '</div>';
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

            // List block (unordered or ordered), possibly nested. A hand-rolled
            // line parser has to track nesting explicitly: we keep a stack of
            // open lists keyed by leading-indent width, opening a new <ul>/<ol>
            // when indentation increases and closing lists back down when it
            // decreases. This is what makes multi-level answers render as real
            // nested lists (and activates the li>ul/li>ol CSS) instead of one
            // flat list. Tabs count as 4 columns.
            if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
                const stack = []; // each entry: { indent, type }
                let listHtml = '';
                while (i < lines.length) {
                    const um = lines[i].match(/^(\s*)[-*]\s+(.*)$/);
                    const om = lines[i].match(/^(\s*)\d+\.\s+(.*)$/);
                    if (!um && !om) break;
                    const m = um || om;
                    const indent = m[1].replace(/\t/g, '    ').length;
                    const type = um ? 'ul' : 'ol';

                    // Close any lists deeper than — or at the same indent but a
                    // different type from — the current item.
                    while (
                        stack.length &&
                        (indent < stack[stack.length - 1].indent ||
                         (indent === stack[stack.length - 1].indent &&
                          type !== stack[stack.length - 1].type))
                    ) {
                        listHtml += '</li></' + stack.pop().type + '>';
                    }

                    if (!stack.length || indent > stack[stack.length - 1].indent) {
                        // Deeper than the current level (or the first item):
                        // open a nested list inside the still-open parent <li>.
                        listHtml += '<' + type + '>';
                        stack.push({ indent: indent, type: type });
                    } else {
                        // Same level: close the previous sibling item first.
                        listHtml += '</li>';
                    }
                    listHtml += '<li>' + inlineMd(m[2]);
                    i++;
                }
                while (stack.length) {
                    listHtml += '</li></' + stack.pop().type + '>';
                }
                html += listHtml;
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

    // Element with text content in one step.
    function elText(tag, text, cls) {
        const node = el(tag, cls);
        node.textContent = text;
        return node;
    }

    // Parse a backend timestamp (ISO string, epoch seconds or milliseconds) into
    // a Date, or return null when absent/unparseable.
    function parseTimestamp(value) {
        if (value === undefined || value === null || value === '') return null;
        if (typeof value === 'number') {
            // Heuristic: values below ~1e12 are epoch seconds, not milliseconds.
            const d = new Date(value < 1e12 ? value * 1000 : value);
            return isNaN(d.getTime()) ? null : d;
        }
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    // Format a Date's time part using the site's WordPress time_format setting
    // (PHP date() tokens), so timestamps honour the admin's configured format.
    function formatTime(date) {
        if (!(date instanceof Date) || isNaN(date.getTime())) return '';
        return phpDateFormat(cfg.timeFormat || 'H:i', date);
    }

    // Locale-aware date part; formatTime() covers the time using WP's time_format.
    function formatDate(date) {
        if (!(date instanceof Date) || isNaN(date.getTime())) return '';
        const opts = { year: 'numeric', month: 'short', day: 'numeric' };
        const locale = (cfg.locale || '').replace('_', '-');
        try {
            return new Intl.DateTimeFormat(locale || undefined, opts).format(date);
        } catch (e) {
            return new Intl.DateTimeFormat(undefined, opts).format(date);
        }
    }

    function interpolate(template, vars) {
        return String(template).replace(/\{(\w+)\}/g, function (match, key) {
            return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
        });
    }

    // Precise HH:MM:SS.mmm, ignoring the site's time_format — used for the error
    // reference line, where seconds/ms are what actually distinguish two events
    // close together when matching against Sentry (unlike the minute-granularity
    // "am I looking at the right message" formatTime() above).
    function formatPreciseTime(date) {
        if (!(date instanceof Date) || isNaN(date.getTime())) return '';
        const pad = function (n, len) { return String(n).padStart(len || 2, '0'); };
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) +
            '.' + pad(date.getMilliseconds(), 3);
    }

    // Minimal PHP date()-token formatter covering the time tokens WordPress uses
    // in its time_format option (a A g G h H i s), with backslash escaping.
    function phpDateFormat(fmt, d) {
        const H = d.getHours();
        const g = (H % 12) || 12;
        const min = d.getMinutes();
        const sec = d.getSeconds();
        const pad = function (n) { return n < 10 ? '0' + n : String(n); };

        let out = '';
        for (let k = 0; k < fmt.length; k++) {
            const ch = fmt.charAt(k);
            if (ch === '\\') { out += fmt.charAt(++k) || ''; continue; }
            switch (ch) {
                case 'a': out += H < 12 ? 'am' : 'pm'; break;
                case 'A': out += H < 12 ? 'AM' : 'PM'; break;
                case 'g': out += String(g); break;
                case 'G': out += String(H); break;
                case 'h': out += pad(g); break;
                case 'H': out += pad(H); break;
                case 'i': out += pad(min); break;
                case 's': out += pad(sec); break;
                default:  out += ch;
            }
        }
        return out;
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
            connected:  { cls: 'gv-state-positive', label: i18n.connected || 'Connected' },
            connecting: { cls: 'gv-state-busy',     label: i18n.reconnecting || 'Connecting…' },
            error:      { cls: 'gv-state-critical', label: i18n.disconnected || 'Disconnected' },
            readOnly:   { cls: 'gv-state-blank',    label: i18n.readOnly || 'Read-only' },
        };
        const s = stateMap[state] || stateMap.connecting;
        indicatorDotEl.className = 'gv-indicator ' + s.cls;
        statusTextEl.textContent = s.label;
    }

    function setSendDisabled(disabled) {
        sendBtn.disabled = disabled;
        inputEl.disabled = disabled;
    }

    // The conversational button doubles as Send and Stop (Gravity spec: fixed
    // icons arrow_forward / stop_fill). While a response streams it becomes a
    // Stop button; clicking it aborts the stream.
    function onSendBtnClick() {
        if (isStreaming) {
            trackButtonClick('stop');
            stopStream();
        } else {
            // Not tracked here — handleSend() fires 'send' once it has a message,
            // so an empty-composer click doesn't count.
            handleSend('button');
        }
    }

    // Toggle the conversational button between Send and Stop states.
    function setStreamingUI(streaming) {
        if (!sendBtn) return;
        // Stays clickable while streaming so the user can Stop. A pending
        // ask_user question deliberately does NOT lock it — Gravity keeps the
        // input live so the user can type an answer instead of picking a choice.
        const locked = !streaming && (!consentGranted || isQuotaExhausted());
        sendBtn.disabled = locked;
        inputEl.disabled = locked;

        const iconEl = sendBtn.querySelector('gv-icon');
        if (iconEl) {
            iconEl.setAttribute('src', streaming ? ICON.stop : ICON.send);
        }
        const label = streaming ? (i18n.stop || 'Stop') : (i18n.send || 'Send');
        sendBtn.setAttribute('aria-label', label);
        sendBtn.title = label;
        sendBtn.classList.toggle('wap-stop', streaming);
    }

    // Abort the in-flight stream and immediately restore the Send state. No
    // further SSE events are processed once the fetch signal is aborted.
    function stopStream() {
        selectionGeneration++;
        handoffTransitionGeneration = null;
        if (currentAbortController) {
            try { currentAbortController.abort(); } catch (e) { /* ignore */ }
            currentAbortController = null;
        }
        isStreaming = false;
        setStreamingUI(false);
    }

    // Distance (px) from the bottom within which we consider the view "at bottom".
    const SCROLL_EPSILON = 48;

    // The element that actually scrolls depends on Gravity's chat CSS: it may be
    // the <ul> (.gv-chat-list) or the <section> (.gv-chat). Resolve whichever is
    // genuinely overflowing so the button and sticky logic act on the right one.
    function getScroller() {
        if (chatListEl && chatListEl.scrollHeight - chatListEl.clientHeight > 4) {
            return chatListEl;
        }
        if (chatEl && chatEl.scrollHeight - chatEl.clientHeight > 4) {
            return chatEl;
        }
        return chatListEl;
    }

    function isNearBottom() {
        const s = getScroller();
        if (!s) return true;
        return s.scrollHeight - s.scrollTop - s.clientHeight <= SCROLL_EPSILON;
    }

    // Sticky auto-scroll: only follow new content while the user is at the
    // bottom. `force` re-sticks (used when the user themselves sends a message).
    function scrollToBottom(force) {
        const s = getScroller();
        if (!s) return;
        if (force) stickToBottom = true;
        if (stickToBottom) {
            s.scrollTop = s.scrollHeight;
        }
        updateScrollBtn();
    }

    // Called on user scroll: update stickiness + the helper button.
    function updateScrollState() {
        stickToBottom = isNearBottom();
        updateScrollBtn();
    }

    // Reveal Gravity's scroll-to-bottom button only when the conversation is
    // scrollable and the user is NOT already at the bottom. Gravity's CSS shows
    // .gv-chat-scroll-bottom whenever .gv-show-scroll is present on .gv-chat.
    function updateScrollBtn() {
        if (!chatEl) return;
        const s = getScroller();
        const scrollable = s && (s.scrollHeight - s.clientHeight > SCROLL_EPSILON);
        // Never show the arrow on an empty conversation (welcome state) — only
        // once there are real messages and the user has scrolled up.
        chatEl.classList.toggle('gv-show-scroll', hasMessages && !!scrollable && !isNearBottom());
    }

    // Down-only: animate to the bottom and hide the button (per Gravity guidance).
    // Gravity's chat list has no CSS scroll-behavior; its demo scrolls smoothly
    // via JS on the button press, so we do the same here (an instant jump feels
    // off-brand).
    function onScrollBtnClick() {
        const s = getScroller();
        if (!s) return;
        stickToBottom = true;
        var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (typeof s.scrollTo === 'function' && !reduceMotion) {
            s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
        } else {
            s.scrollTop = s.scrollHeight;
        }
        chatEl.classList.remove('gv-show-scroll');
    }

    // -------------------------------------------------------------------------
    // Expand toggle
    // -------------------------------------------------------------------------

    // Expand/collapse the widget per layout.expandToggle: 'window' = full-viewport
    // overlay, 'container' = fill the parent width in-flow. Icon/tooltip flip.
    function toggleFullscreen() {
        if (!fullscreenBtn) return;
        isFullscreen = !isFullscreen;
        // 'window' keeps the historical overlay; 'container' expands in-flow.
        const expandClass = layout.expandToggle === 'container' ? 'wap-expanded' : 'wap-fullscreen';
        rootEl.classList.toggle(expandClass, isFullscreen);

        const iconEl = fullscreenBtn.querySelector('gv-icon');
        if (iconEl) {
            iconEl.setAttribute('src', isFullscreen ? ICON.fullscreenExit : ICON.fullscreen);
        }
        const label = isFullscreen
            ? (i18n.exitFullscreen || 'Exit full screen')
            : (i18n.fullscreen || 'Full screen');
        fullscreenBtn.setAttribute('aria-label', label);
        const tip = document.getElementById(fullscreenBtn.getAttribute('aria-describedby'));
        const tipText = tip && tip.querySelector('p');
        if (tipText) tipText.textContent = label;

        // Layout changed — re-evaluate the scroll affordance.
        updateScrollBtn();
    }

    // -------------------------------------------------------------------------
    // Chat settings panel
    // -------------------------------------------------------------------------

    // In-widget settings sheet (opened from the header gear). Holds the pieces
    // the backend can actually back today: interface language (read-only — the
    // WAP backend does not switch locale) and an "About this chat" summary.
    function openSettings() {
        if (rootEl.querySelector('.wap-settings')) return;

        const overlay = el('div', 'wap-settings');

        const card = el('div', 'wap-settings__card');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', i18n.settingsTitle || 'Chat settings');

        // Header row: title + close.
        const head = el('div', 'wap-settings__head');
        head.appendChild(elText('h2', i18n.settingsTitle || 'Chat settings', 'wap-settings__title'));
        const closeBtn = el('button', 'gv-tooltip-button wap-icon-btn wap-settings__close');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', i18n.cancel || 'Close');
        closeBtn.appendChild(gvIcon(ICON.close));
        head.appendChild(closeBtn);
        card.appendChild(head);

        // Preferences — interface language.
        const prefs = settingsSection(ICON.language, i18n.preferences || 'Preferences');
        const row = el('div', 'wap-settings__row');
        row.appendChild(elText('span', i18n.language || 'Language', 'wap-settings__label'));

        const selectWrap = el('div', 'gv-input gv-input-select gv-read-only gv-mode-condensed');
        const select = el('select');
        select.disabled = true; // Locale is set by the host account; not switchable here.
        const opt = document.createElement('option');
        opt.textContent = localeLabel(cfg.locale || 'en_US');
        select.appendChild(opt);
        selectWrap.appendChild(select);
        selectWrap.appendChild(gvIcon(ICON.expand));
        row.appendChild(selectWrap);
        prefs.appendChild(row);
        prefs.appendChild(elText('p', i18n.languageNote || 'Set by your account language.', 'wap-settings__hint'));
        card.appendChild(prefs);

        // About this chat.
        const about = settingsSection(ICON.assistant, i18n.aboutChat || 'About this chat');
        about.appendChild(metaRow(i18n.assistantLabel || 'Assistant', i18n.assistantName || 'AI Assistant'));
        if (cfg.product) about.appendChild(metaRow(i18n.productLabel || 'Product', cfg.product));
        if (cfg.version) about.appendChild(metaRow(i18n.versionLabel || 'Version', 'v' + cfg.version));
        card.appendChild(about);

        // Footer note.
        card.appendChild(elText(
            'p',
            i18n.settingsNote || 'Starting a new chat clears this conversation. We keep only a short internal summary of it to see how the assistant is doing — never shown to you or used in future chats.',
            'wap-settings__note'
        ));

        overlay.appendChild(card);
        rootEl.appendChild(overlay);

        const prevFocus = document.activeElement;

        function cleanup() {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            if (prevFocus && prevFocus.focus) {
                try { prevFocus.focus(); } catch (e) { /* ignore */ }
            }
        }

        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
            }
        }

        closeBtn.addEventListener('click', cleanup);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) cleanup();
        });
        document.addEventListener('keydown', onKey, true);

        closeBtn.focus();
    }

    // A settings section: icon + heading, then a body the caller fills.
    function settingsSection(iconSrc, heading) {
        const section = el('div', 'wap-settings__section');
        const head = el('div', 'wap-settings__section-head');
        head.appendChild(gvIcon(iconSrc, 'wap-settings__section-icon'));
        head.appendChild(elText('h3', heading, 'wap-settings__section-title'));
        section.appendChild(head);
        return section;
    }

    // A label/value line used inside "About this chat".
    function metaRow(label, value) {
        const row = el('div', 'wap-settings__meta');
        row.appendChild(elText('span', label, 'wap-settings__meta-label'));
        row.appendChild(elText('span', value, 'wap-settings__meta-value'));
        return row;
    }

    // Human-readable label for a WordPress/WAP locale code.
    function localeLabel(loc) {
        const map = {
            en_US: 'English (US)', en_GB: 'English (UK)', en: 'English',
            de_DE: 'Deutsch', de: 'Deutsch',
            nl_NL: 'Nederlands', nl: 'Nederlands',
            fr_FR: 'Français', fr: 'Français',
            es_ES: 'Español', es: 'Español',
            da_DK: 'Dansk', da: 'Dansk',
            sv_SE: 'Svenska', it_IT: 'Italiano',
        };
        return map[loc] || map[String(loc).split('_')[0]] || loc;
    }

    /**
     * Gravity modal confirmation dialog. Resolves true (confirmed) / false
     * (cancelled / dismissed). Replaces the native window.confirm().
     *
     * Built from gv-modal / gv-modal-content / gv-modal-title / gv-modal-body /
     * gv-modal-progress / gv-modal-close. The overlay is appended INSIDE the
     * gv-activated root so Gravity's `.gv-activated .gv-modal …` rules apply.
     *
     * @param {{title:string, message:string, confirmLabel:string, cancelLabel:string, destructive?:boolean}} opts
     * @returns {Promise<boolean>}
     */
    function showConfirm(opts) {
        return new Promise(function (resolve) {
            const overlay = el('div', 'gv-modal wap-confirm');

            const content = el('div', 'gv-modal-content');
            content.setAttribute('role', 'dialog');
            content.setAttribute('aria-modal', 'true');

            const closeBtn = el('button', 'gv-modal-close');
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', opts.cancelLabel || 'Close');
            closeBtn.appendChild(gvIcon(ICON_BASE + 'close.svg'));

            const body = el('div', 'gv-modal-body');
            const title = el('h2', 'gv-modal-title');
            title.id = 'wap-confirm-title';
            title.textContent = opts.title || 'Are you sure?';
            const msg = el('p', '');
            msg.id = 'wap-confirm-msg';
            msg.textContent = opts.message || '';
            body.appendChild(title);
            body.appendChild(msg);
            content.setAttribute('aria-labelledby', title.id);
            content.setAttribute('aria-describedby', msg.id);

            const actions = el('div', 'gv-button-group');
            const cancelBtn = el('button', 'gv-button gv-button-cancel');
            cancelBtn.type = 'button';
            cancelBtn.textContent = opts.cancelLabel || 'Cancel';
            const confirmBtn = el('button', 'gv-button ' + (opts.destructive ? 'gv-button-destructive' : 'gv-button-primary'));
            confirmBtn.type = 'button';
            confirmBtn.textContent = opts.confirmLabel || 'Confirm';
            actions.appendChild(cancelBtn);
            actions.appendChild(confirmBtn);

            content.appendChild(closeBtn);
            content.appendChild(body);
            content.appendChild(actions);
            overlay.appendChild(content);
            (rootEl || document.body).appendChild(overlay);

            const focusables = [confirmBtn, cancelBtn, closeBtn];
            const prevFocus = document.activeElement;

            function cleanup(result) {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                if (prevFocus && prevFocus.focus) {
                    try { prevFocus.focus(); } catch (e) { /* ignore */ }
                }
                resolve(result);
            }

            function onKey(e) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup(false);
                } else if (e.key === 'Tab') {
                    const first = focusables[0];
                    const last = focusables[focusables.length - 1];
                    if (e.shiftKey && document.activeElement === first) {
                        e.preventDefault(); last.focus();
                    } else if (!e.shiftKey && document.activeElement === last) {
                        e.preventDefault(); first.focus();
                    }
                }
            }

            cancelBtn.addEventListener('click', function () { cleanup(false); });
            closeBtn.addEventListener('click', function () { cleanup(false); });
            confirmBtn.addEventListener('click', function () { cleanup(true); });
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) cleanup(false);
            });
            document.addEventListener('keydown', onKey, true);

            confirmBtn.focus();
        });
    }

}());
