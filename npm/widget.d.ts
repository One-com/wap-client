/**
 * @group-one/wap-client/widget — type definitions.
 *
 * The widget is the browser half of a WAP integration. The other half is a
 * session endpoint YOU host behind your own login: it issues a short-lived
 * GRND for the logged-in user (via @group-one/wap-client/server) and returns
 * it as {token}. The widget sends that token directly to WAP as the Bearer
 * credential on every call. See docs/wap-backend-grnd-requirements.md for
 * the wire contract.
 */

/** Result of your session endpoint. */
export interface WapSession {
    /** The Bearer credential for WAP — the (short-lived) GRND itself. Held in widget memory only. */
    token: string;
    /** Server-authoritative conversation/thread id, when your host tracks one. */
    conversationId?: string;
}

/**
 * Optional T&C consent hook. When provided, the first chat is gated behind an
 * in-widget consent prompt; the widget persists acceptance through set(true).
 * When omitted, no consent gate is shown.
 */
export interface WapConsentHook {
    get(): boolean | Promise<boolean>;
    set(accepted: boolean): unknown | Promise<unknown>;
}

/**
 * Optional persistence for the docked column's collapsed/expanded state.
 * Omit to fall back to localStorage (per browser profile, not per account) —
 * supply this to keep the preference on your own backend, per logged-in user.
 */
export interface WapColumnStateHook {
    get(): 'expanded' | 'collapsed' | null | Promise<'expanded' | 'collapsed' | null>;
    set(state: 'expanded' | 'collapsed'): unknown | Promise<unknown>;
}

/**
 * Framing for the docked column surface. Pass `column` (even as `{}`) to render
 * the widget as a collapsible side panel instead of an in-place embed.
 */
export interface WapColumnOptions {
    /**
     * Identifies this column for state persistence, and is written to the
     * wrapper's `data-wap-chat-column`. Defaults to 'default'.
     */
    id?: string;
    /**
     * Which edge to dock to. LOGICAL, not physical: 'right' is the inline-end
     * edge, so an RTL layout docks on the left — and collapses towards that same
     * left edge — with no extra config. Default 'right'.
     *
     * In wp-admin, 'left' + `mode: 'push'` also insets #adminmenuwrap so the
     * panel does not cover the admin menu.
     */
    side?: 'left' | 'right';
    /**
     * Panel width as a CSS length — digits plus px/rem/em/ch/vw/vh/vmin/vmax/%.
     * Anything else falls back to the default rather than silently no-op'ing.
     * Clamped to 100vw, for both the panel and the host-page inset.
     * Default '400px'.
     */
    width?: string;
    /**
     * 'push' insets the host page so the panel never covers content (non-modal).
     * 'overlay' floats above it behind a scrim (modal). Default 'push'.
     * Below `breakpoint` the resolved mode is always 'overlay'.
     */
    mode?: 'push' | 'overlay';
    /**
     * Max-width at which push flips to overlay and the panel goes full-bleed.
     * Same CSS-length validation as `width`. Default '960px'.
     */
    breakpoint?: string;
    /** State when the user has no stored preference. Default 'collapsed'. */
    defaultState?: 'expanded' | 'collapsed';
    /** Render the floating launcher button. Default true. */
    showLauncher?: boolean;
    /** Persist the collapsed/expanded preference at all. Default true. */
    persist?: boolean;
    /** Accessible name for the panel region and launcher. Defaults to i18n.columnLabel. */
    label?: string;
}

/**
 * Options for the programmatic state methods on WapChatHandle.
 *
 * `focus` defaults to FALSE: a host collapsing the column on a route change or
 * from an effect must not steal focus. Pass `{focus: true}` only from a real
 * user gesture — the widget's own launcher and dismiss button already do.
 */
export interface WapColumnStateOptions {
    focus?: boolean;
}

/** Handle returned by mount(), for driving and disposing of a column. */
export interface WapChatHandle {
    expand(options?: WapColumnStateOptions): void;
    collapse(options?: WapColumnStateOptions): void;
    toggle(options?: WapColumnStateOptions): void;
    isCollapsed(): boolean;
    /** The element the widget rendered into. */
    root: Element;
    /** Abort streaming, release listeners, undo the host-page inset. */
    destroy(): void;
}

/**
 * Presentation framing for the widget shell. Every key is optional; the defaults
 * reproduce the boxed 900px panel.
 */
export interface WapLayoutOptions {
    /** 'boxed' caps the shell at 900px; 'fluid' fills the parent. Default 'boxed'. */
    width?: 'boxed' | 'fluid';
    /** Caps the inner content column, e.g. '640px' or '68ch'. */
    innerWidth?: string;
    /** Horizontal placement of the inner column. Default 'left'. */
    align?: 'left' | 'center' | 'right';
    /** Header expand toggle target. Default 'window' (boxed) / 'off' (fluid). */
    expandToggle?: 'window' | 'container' | 'off';
    /** CSS length, or 'fill' for 100% of the parent. */
    height?: string;
    /** 'flat' drops the border/radius/shadow. Default 'card'. */
    chrome?: 'card' | 'flat';
    /** Accent colour; arrow contrast is derived automatically. */
    accent?: string;
    /** false hides the message-list scrollbar (still scrollable). Default true. */
    keepScrollbar?: boolean;
    showHeader?: boolean;
    showNewChat?: boolean;
    showSettings?: boolean;
    showDeleteData?: boolean;
}

export interface WapChatInitOptions {
    /**
     * REQUIRED for SaaS hosts. Resolves the WAP credential via your backend.
     * Called on load, and exactly once more with {forceNew: true} after a
     * WAP 401 (your backend should drop its cached GRND and mint a fresh one).
     */
    getSession(opts: { forceNew: boolean }): WapSession | Promise<WapSession>;

    /** WAP backend base URL the BROWSER talks to, e.g. 'https://wap.group.one'. */
    wapBrowserUrl: string;

    /** Product slug registered with WAP, e.g. 'partners-one'. */
    product: string;

    /** Mount point: an Element or CSS selector. Defaults to '#wap-chat-root'. */
    root?: string | Element;

    /** Consent hook — see WapConsentHook. Omit to disable the consent gate. */
    consent?: WapConsentHook;

    /** Host-side cleanup invoked after a successful GDPR erasure. */
    eraseLocalData?(): unknown | Promise<unknown>;

    /** String overrides; English defaults are built in. */
    i18n?: Record<string, string>;

    /** Terms & Conditions URL shown in the widget footer and consent gate. */
    termsUrl?: string;

    /** Privacy Policy URL shown in the widget footer notice. */
    privacyUrl?: string;

    /**
     * Version label shown in the footer and settings panel. Defaults to the
     * package version baked in at build time; pass to override.
     */
    version?: string;

    /** Up to 4 suggestion chips shown on the welcome (empty) state. */
    suggestions?: string[];

    /** Locale hint for timestamps, e.g. 'en-US'. */
    locale?: string;

    /** Timestamp format using PHP date() tokens (e.g. 'H:i'). */
    timeFormat?: string;

    /** Opaque page context forwarded to the agent with each chat message. */
    pageContext?: unknown;

    /** Resume a specific conversation; normally supplied by getSession(). */
    conversationId?: string;

    /** Presentation framing for the widget shell. */
    layout?: WapLayoutOptions;

    /**
     * Render as a collapsible docked column instead of an in-place embed. Set by
     * mount() automatically; pass it to init() only when you are supplying your
     * own `[data-wap-chat-column]` mount point. `false` opts a mount() call back
     * out to a plain in-place embed.
     */
    column?: WapColumnOptions | false;

    /** Persist the column's collapsed/expanded state on your backend. */
    columnState?: WapColumnStateHook;

    /**
     * Let the widget inject the Gravity stylesheet and runtime when they are not
     * already on the page. Default true; set false under a strict CSP or when the
     * host manages Gravity itself.
     */
    loadGravity?: boolean;

    /**
     * Mixpanel project token. Client-side analytics is inert without it, and every
     * event is additionally gated on the widget's consent state.
     */
    mixpanelToken?: string;

    /**
     * URL you serve `dist/vendor/mixpanel-loader.js` from. REQUIRED together with
     * `mixpanelLibUrl` — the loader creates the queueing `window.mixpanel` stub and
     * locates the library only via that URL, so setting one without the other
     * leaves analytics disabled.
     */
    mixpanelLoaderUrl?: string;

    /** URL you serve `dist/vendor/mixpanel.min.js` from. See `mixpanelLoaderUrl`. */
    mixpanelLibUrl?: string;

    /** Ingest host. Defaults to `https://api-eu.mixpanel.com` (EU). */
    mixpanelApiHost?: string;

    /** Governed `application` super-property. Defaults to `'wap'`. */
    mixpanelApplication?: string;

    /** Overrides the derived `page` super-property (default `/wap/{product}`). */
    mixpanelPage?: string;

    /** Governed `brand` super-property. Sent only when set. */
    mixpanelBrand?: string;
}

/**
 * Mount the chat widget. Safe to call again to re-initialise (e.g. after an
 * SPA route change re-creates the mount element); an in-flight stream is
 * aborted first and the previous mount's DOM and listeners are released.
 *
 * An unresolvable `root` is a no-op — nothing from the previous mount is
 * disturbed. Browser-only: throws if called during SSR.
 */
export declare function init(options: WapChatInitOptions): void;

/**
 * Mount the widget as a collapsible column docked to the edge of the screen.
 *
 * `target` is treated as the column *host*: the widget appends ONE child to it
 * (its own `[data-wap-chat-column]` wrapper) and never replaces or restyles the
 * element you pass. With a React-managed node, hand it a ref'd element you keep
 * empty — React does not know about the appended child, so do not render
 * children into the same node. `destroy()` removes it again.
 *
 * Returns `null` when `target` cannot be resolved (logged as a warning), the
 * same no-op contract as init().
 *
 * ```tsx
 * useEffect(() => {
 *   const chat = mount(ref.current!, {
 *     wapBrowserUrl: 'https://wap.group.one',
 *     product: 'partners-one',
 *     getSession: fetchSession,
 *     column: { side: 'right', width: '420px' },
 *   });
 *   return () => chat?.destroy();
 * }, []);
 * ```
 *
 * ONE COLUMN PER PAGE: the column's runtime state is module-level, so a second
 * mount() re-initialises the widget rather than adding a second panel. `id`
 * namespaces the stored preference, not the instance.
 *
 * Browser-only: throws if called during SSR.
 */
export declare function mount(
    target: Element | string,
    options: WapChatInitOptions,
): WapChatHandle | null;

/**
 * Tear down the current mount: abort streaming, release listeners bound outside
 * the widget shell, and undo any host-page inset. No-op if nothing is mounted.
 */
export declare function destroy(): void;

declare const _default: {
    init: typeof init;
    mount: typeof mount;
    destroy: typeof destroy;
};
export default _default;
