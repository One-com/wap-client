/**
 * The host pages the preview mounts the widget in, built the way WordPress
 * builds them from includes/class-chat-widget.php (npm/test-widget.mjs compares
 * the two). What is read and what is restated: preview/README.md.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PRODUCTS, productFor } from './products.mjs';
import { namedScenarios } from './scenarios.mjs';
import { replyCatalogue, scenarioCatalogue } from './fake-wap.mjs';

/** WordPress core's admin stylesheets, pinned. */
const WORDPRESS = 'https://cdn.jsdelivr.net/gh/WordPress/WordPress@6.9';
const ADMIN_STYLESHEETS = [
    'wp-includes/css/dashicons.min.css',
    'wp-includes/css/admin-bar.min.css',
    'wp-includes/css/buttons.min.css',
    'wp-admin/css/common.min.css',
    'wp-admin/css/forms.min.css',
    'wp-admin/css/admin-menu.min.css',
];

/**
 * Where the widget can be mounted. `layout` is what that PHP surface adds to the
 * product's own layout, read from its constant; the SaaS host passes the layout
 * of the npm example in docs/wap-client-overview.md.
 */
export const SURFACES = {
    page: { label: 'Admin page', layout: () => ({}) },
    column: { label: 'Docked column', layout: (wp) => wp.layout('class-chat-column.php', 'COLUMN_LAYOUT') },
    embed: { label: 'Inline embed', layout: (wp) => wp.layout('class-chat-embed.php', 'EMBED_LAYOUT') },
    standalone: { label: 'Standalone page', layout: (wp) => wp.layout('class-chat-widget.php', 'STANDALONE_LAYOUT') },
    saas: { label: 'SaaS host (npm)', layout: () => ({ width: 'fluid', height: 'fill', innerWidth: '640px', align: 'center', chrome: 'flat' }) },
};

const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** JSON safe inside a <script> element. */
const scriptJson = (value) => JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** The widget package's own versions: the plugin's, and the Gravity one the npm widget loads. */
function versions(packageRoot) {
    const php = readFileSync(join(packageRoot, 'wap-client.php'), 'utf8');
    const js = readFileSync(join(packageRoot, 'assets', 'wap-chat.js'), 'utf8');
    const gravity = /const GRAVITY_VERSION = '([^']+)'/.exec(js);
    if (!gravity) throw new Error('assets/wap-chat.js has no GRAVITY_VERSION; update versions() in preview/page.mjs.');
    return {
        plugin: (/define\('WAP_CLIENT_VERSION',\s*'([^']+)'\)/.exec(php) || [])[1] || 'dev',
        npmGravity: gravity[1],
    };
}

/** What a page request asks for, every value checked against what exists. */
export function pageOptions(query, locales) {
    // hasOwn: "constructor" and other inherited names are not products or places.
    const product = Object.hasOwn(PRODUCTS, query.get('product')) ? query.get('product') : 'wp-rocket';
    const surface = Object.hasOwn(SURFACES, query.get('surface')) ? query.get('surface') : 'page';
    const locale = locales.includes(query.get('locale')) ? query.get('locale') : 'en_US';
    const { chosen, unknown } = namedScenarios(query.get('scenario'));
    return { product, surface, locale, scenarios: chosen, unknownScenarios: unknown };
}

/** The mount point render_chat_root() prints, with its loading state. */
function chatRoot(id, product, gravity, connecting) {
    return `<div id="${esc(id)}" class="wap-chat-root" data-product="${esc(product)}">
            <div class="gv-loader-container" aria-live="polite">
                <gv-loader src="https://gravity.group-cdn.one/${esc(gravity)}/loaders/spinner.svg"></gv-loader>
                <p>${esc(connecting)}</p>
            </div>
        </div>`;
}

function menuItem(id, label, icon, extra = '') {
    return `<li class="wp-not-current-submenu menu-top menu-icon-${id} ${extra}" id="menu-${id}">
          <a href="#" class="wp-not-current-submenu menu-top menu-icon-${id} ${extra}"><div class="wp-menu-arrow"><div></div></div><div class="wp-menu-image dashicons-before ${icon}" aria-hidden="true"><br></div><div class="wp-menu-name">${esc(label)}</div></a>
        </li>`;
}

/** wp-admin around `body`: the admin menu with the product's entry open, the toolbar, the footer. */
function adminChrome(product, currentSubmenu, body) {
    const icon = { 'wp-rocket': 'dashicons-performance', rankmath: 'dashicons-chart-area' }[product.slug] || 'dashicons-admin-site';
    const submenu = ['Dashboard', product.pageTitle, 'Settings']
        .map((label, i) => {
            const current = label === currentSubmenu;
            const classes = [i === 0 ? 'wp-first-item' : '', current ? 'current' : ''].filter(Boolean).join(' ');
            return `<li class="${classes}"><a href="#" class="${classes}"${current ? ' aria-current="page"' : ''}>${esc(label)}</a></li>`;
        })
        .join('');
    const separator = '<li class="wp-not-current-submenu wp-menu-separator" aria-hidden="true"><div class="separator"></div></li>';

    return `<div id="wpwrap">
  <div id="adminmenumain" role="navigation" aria-label="Main menu">
    <div id="adminmenuback"></div>
    <div id="adminmenuwrap">
      <ul id="adminmenu">
        ${menuItem('dashboard', 'Dashboard', 'dashicons-dashboard', 'wp-first-item')}
        ${separator}
        ${menuItem('posts', 'Posts', 'dashicons-admin-post')}
        ${menuItem('media', 'Media', 'dashicons-admin-media')}
        ${menuItem('pages', 'Pages', 'dashicons-admin-page')}
        ${menuItem('comments', 'Comments', 'dashicons-admin-comments')}
        ${separator}
        ${menuItem('appearance', 'Appearance', 'dashicons-admin-appearance')}
        ${menuItem('plugins', 'Plugins', 'dashicons-admin-plugins')}
        ${menuItem('users', 'Users', 'dashicons-admin-users')}
        ${menuItem('tools', 'Tools', 'dashicons-admin-tools')}
        ${menuItem('settings', 'Settings', 'dashicons-admin-settings')}
        <li class="wp-has-submenu wp-has-current-submenu wp-menu-open menu-top" id="toplevel_page_${esc(product.slug)}">
          <a href="#" class="wp-has-submenu wp-has-current-submenu wp-menu-open menu-top"><div class="wp-menu-arrow"><div></div></div><div class="wp-menu-image dashicons-before ${icon}" aria-hidden="true"><br></div><div class="wp-menu-name">${esc(product.menuTitle)}</div></a>
          <ul class="wp-submenu wp-submenu-wrap"><li class="wp-submenu-head" aria-hidden="true">${esc(product.menuTitle)}</li>${submenu}</ul>
        </li>
        <li id="collapse-menu" class="hide-if-no-js"><button type="button" id="collapse-button" aria-label="Collapse Main menu" aria-expanded="true"><span class="collapse-button-icon" aria-hidden="true"></span><span class="collapse-button-label">Collapse Menu</span></button></li>
      </ul>
    </div>
  </div>
  <div id="wpcontent">
    <div id="wpadminbar" class="nojq">
      <div class="quicklinks" id="wp-toolbar" role="navigation" aria-label="Toolbar">
        <ul role="menu" id="wp-admin-bar-root-default" class="ab-top-menu">
          <li role="group" id="wp-admin-bar-wp-logo" class="menupop"><a class="ab-item" role="menuitem" href="#"><span class="ab-icon" aria-hidden="true"></span><span class="screen-reader-text">About WordPress</span></a></li>
          <li role="group" id="wp-admin-bar-site-name" class="menupop"><a class="ab-item" role="menuitem" href="#">Acme Ceramics</a></li>
        </ul>
        <ul role="menu" id="wp-admin-bar-top-secondary" class="ab-top-secondary ab-top-menu">
          <li role="group" id="wp-admin-bar-my-account" class="menupop"><a class="ab-item" role="menuitem" href="#">Howdy, <span class="display-name">Alex</span></a></li>
        </ul>
      </div>
    </div>
    <div id="wpbody" role="main">
      <div id="wpbody-content">
        ${body}
        <div class="clear"></div>
      </div>
      <div class="clear"></div>
    </div>
    <div id="wpfooter" role="contentinfo">
      <p id="footer-left" class="alignleft">Thank you for creating with <a href="#">WordPress</a>.</p>
      <p id="footer-upgrade" class="alignright">Version 6.9</p>
      <div class="clear"></div>
    </div>
  </div>
</div>`;
}

/** A product screen of the host's own, for the column and the embed to sit beside or inside. */
function productScreen(product, inner) {
    return `<div class="wrap">
        <h1 class="wp-heading-inline">${esc(product.menuTitle)}</h1>
        <hr class="wp-header-end">
        ${inner}
    </div>`;
}

const DASHBOARD_CARDS = `<div class="wap-preview-cards">
            <div class="card"><h2 class="title">Cache</h2><p>412 pages cached. Last cleared 3 hours ago.</p><p><button type="button" class="button">Clear cache</button></p></div>
            <div class="card"><h2 class="title">Performance</h2><p>Mobile score <strong>82</strong>, desktop <strong>96</strong>.</p><p><button type="button" class="button button-primary">Run a new test</button></p></div>
            <div class="card"><h2 class="title">Your licence</h2><p>Single site, renews on 1 March 2027.</p></div>
        </div>`;

function settingsTabs(product, chatbox) {
    return `<nav class="nav-tab-wrapper" aria-label="Secondary menu">
            <a href="#" class="nav-tab">General</a>
            <a href="#" class="nav-tab">Advanced</a>
            <a href="#" class="nav-tab nav-tab-active" aria-current="page">${esc(product.pageTitle)}</a>
        </nav>
        <div class="wap-preview-tab-panel">
            <p class="description">Ask the assistant about anything on this screen.</p>
            ${chatbox}
        </div>`;
}

/**
 * The page for `options`.
 *
 * @param {object} options from pageOptions()
 * @param {object} context {packageRoot, wordpress: WordPressSource, origin}
 */
export function renderPage(options, { packageRoot, wordpress, origin }) {
    const product = productFor(options.product);
    const surface = options.surface;
    const { plugin, npmGravity } = versions(packageRoot);
    // A WordPress page loads the version the PHP names; the npm host, the widget's own.
    const gravity = surface === 'saas' ? npmGravity : wordpress.gravityVersion();
    const words = wordpress.forLocale(options.locale);
    const slug = `${product.slug}-assistant`;
    const ver = `?ver=${encodeURIComponent(plugin)}`;

    const rootId = { column: `wap-chat-column-root-${slug}`, embed: `wap-chat-embed-root-${slug}` }[surface] || 'wap-chat-root';
    const root = chatRoot(rootId, product.slug, gravity, words.connecting);

    // What wp_localize_script() writes, key for key (enqueue_widget_assets()).
    const config = {
        ajaxUrl: '/wp-admin/admin-ajax.php',
        root: surface === 'column' || surface === 'embed' ? `#${rootId}` : '',
        authNonce: 'preview',
        deleteDataNonce: 'preview',
        consentNonce: 'preview',
        wapBrowserUrl: origin,
        product: product.slug,
        mode: 'product',
        pageContext: '',
        menuSlug: slug,
        mcpEndpoint: `${origin}/wp-json/mcp/mcp-adapter-default-server`,
        userInitial: 'A',
        version: plugin,
        termsUrl: product.termsUrl,
        privacyUrl: product.privacyUrl,
        siteAccessUrl: product.siteAccessUrl,
        mixpanelToken: '',
        mixpanelLibUrl: '',
        mixpanelLoaderUrl: '',
        mixpanelApiHost: 'https://api-eu.mixpanel.com',
        mixpanelApplication: 'wap',
        mixpanelBrand: '',
        brand: product.brand,
        customCssUrl: '',
        layout: SURFACES[surface].layout(wordpress),
        permissions: product.permissions,
        permissionNonce: 'preview',
        column: surface === 'column'
            ? { enabled: true, side: 'right', mode: 'push', defaultState: 'expanded', width: '400px', breakpoint: '960px', showLauncher: true, persist: true, id: slug, stateNonce: 'preview' }
            : null,
        timeFormat: options.locale === 'en_US' ? 'g:i a' : 'H:i',
        locale: options.locale,
        suggestions: words.suggestions,
        i18n: { ...words.i18n, assistantName: product.pageTitle },
    };

    // What the corner panel and the session token need (public/harness.js).
    const preview = {
        product: product.slug,
        surface,
        locale: options.locale,
        scenarios: options.scenarios,
        unknownScenarios: options.unknownScenarios,
        products: Object.fromEntries(Object.entries(PRODUCTS).map(([key, p]) => [key, p.label])),
        surfaces: Object.fromEntries(Object.entries(SURFACES).map(([key, s]) => [key, s.label])),
        locales: wordpress.locales(),
        allScenarios: scenarioCatalogue(),
        replies: replyCatalogue(),
    };

    const gravityCss = `<link rel="stylesheet" id="gravity-design-system-css" href="https://gravity.group-cdn.one/${esc(gravity)}/css/brands/${esc(product.brand)}.min.css" media="all">`;
    const widgetCss = `<link rel="stylesheet" id="wap-client-chat-css" href="/assets/wap-chat.css${ver}" media="all">`;
    const harnessCss = '<link rel="stylesheet" href="/preview/harness.css">';
    const gravityJs = `<script src="https://gravity.group-cdn.one/${esc(gravity)}/index.umd.js" id="gravity-design-system-js-js"></script>`;
    const previewJs = `<script>window.WapPreview = ${scriptJson(preview)};</script>\n<script src="/preview/harness.js"></script>`;
    // wp_localize_script() output, then the preview's one addition: the session
    // token on the ajaxUrl, which names this browser tab (public/harness.js).
    const localized = `<script id="wap-client-chat-js-extra">var WapClientConfig = ${scriptJson(config)};</script>
    <script>WapPreviewHost.adopt(WapClientConfig);</script>`;
    const widgetJs = `<script src="/assets/wap-chat.js${ver}" id="wap-client-chat-js"></script>`;
    const lang = options.locale.replace('_', '-');
    const title = `${product.pageTitle} ‹ Acme Ceramics — WordPress`;

    if (surface === 'standalone') {
        return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
    <meta charset="UTF-8">
    <meta name="robots" content="noindex, nofollow">
    <title>${esc(product.pageTitle)}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${gravityCss}
    ${widgetCss}
    <link rel="stylesheet" id="wap-client-standalone-css" href="/assets/wap-standalone.css${ver}" media="all">
    ${harnessCss}
</head>
<body class="wap-standalone wap-standalone-${esc(slug)}">
    <div class="wap-standalone-shell gv-activated">
        ${root}
    </div>
    ${gravityJs}
    ${previewJs}
    ${localized}
    ${widgetJs}
</body>
</html>`;
    }

    if (surface === 'saas') {
        // The npm path: no WordPress, no admin-ajax. The host's own backend mints the
        // session (here /saas/session) and the widget is mounted with init().
        const init = {
            root: '#assistant-panel',
            product: product.slug,
            wapBrowserUrl: origin,
            brand: product.brand,
            version: plugin,
            termsUrl: product.termsUrl,
            privacyUrl: product.privacyUrl,
            layout: SURFACES.saas.layout(wordpress),
            locale: lang,
        };
        return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
    <meta charset="UTF-8">
    <title>Assistant · Partner dashboard</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    ${gravityCss}
    <link rel="stylesheet" href="/assets/wap-chat.css${ver}">
    ${harnessCss}
</head>
<body class="wap-preview-saas">
    <header class="wap-preview-saas__bar"><strong>Partner dashboard</strong><span>Sites</span><span>Billing</span><span aria-current="page">Assistant</span></header>
    <main class="wap-preview-saas__main"><div id="assistant-panel"></div></main>
    ${gravityJs}
    ${previewJs}
    <script src="/assets/wap-chat.js${ver}"></script>
    <script>WapPreviewHost.mountSaas(${scriptJson(init)});</script>
</body>
</html>`;
    }

    let body;
    let current = product.pageTitle;
    let column = '';
    if (surface === 'page') {
        body = `<div class="wrap wap-client-wrap gv-activated">
            <h1>${esc(product.pageTitle)}</h1>
            ${root}
        </div>`;
    } else if (surface === 'column') {
        current = 'Dashboard';
        body = productScreen(product, DASHBOARD_CARDS);
        column = `<div class="wap-chat-column" data-wap-chat-column="${esc(slug)}" data-wap-column-state="expanded">
            ${root}
        </div>`;
    } else {
        current = 'Settings';
        body = productScreen(product, settingsTabs(product, root));
    }

    return `<!DOCTYPE html>
<html class="wp-toolbar" lang="${esc(lang)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${esc(title)}</title>
    ${ADMIN_STYLESHEETS.map((file) => `<link rel="stylesheet" href="${WORDPRESS}/${file}" media="all">`).join('\n    ')}
    ${gravityCss}
    ${widgetCss}
    ${harnessCss}
</head>
<body class="wp-admin wp-core-ui js admin-color-fresh toplevel_page_${esc(slug)} auto-fold admin-bar branch-6-9 version-6-9 locale-${esc(lang.toLowerCase())}">
${adminChrome(product, current, body)}
${column}
    ${gravityJs}
    ${previewJs}
    ${localized}
    ${widgetJs}
</body>
</html>`;
}

