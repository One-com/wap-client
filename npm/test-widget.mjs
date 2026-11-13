import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describeChange } from '../preview/changes.mjs';
import { FakeWap, PreviewToken } from '../preview/fake-wap.mjs';
import { pageOptions, renderPage } from '../preview/page.mjs';
import { REPLIES, samplesReader } from '../preview/replies.mjs';
import { SCENARIOS } from '../preview/scenarios.mjs';
import { resolveStatic } from '../preview/static-path.mjs';
import { WordPressSource, readDefaultSuggestions, readGravityVersion, readI18nDefaults } from '../preview/wp-source.mjs';

const widgetSource = await readFile(new URL('../assets/wap-chat.js', import.meta.url), 'utf8');

class FakeClassList {
    constructor(node) { this.node = node; }
    _set() { return new Set(this.node.className.split(/\s+/).filter(Boolean)); }
    _write(values) { this.node.className = Array.from(values).join(' '); }
    add(...names) { const values = this._set(); names.forEach((name) => values.add(name)); this._write(values); }
    remove(...names) { const values = this._set(); names.forEach((name) => values.delete(name)); this._write(values); }
    contains(name) { return this._set().has(name); }
    toggle(name, force) {
        const values = this._set();
        const enabled = force === undefined ? !values.has(name) : !!force;
        enabled ? values.add(name) : values.delete(name);
        this._write(values);
        return enabled;
    }
}

class FakeNode {
    constructor(tagName = '', nodeType = 1) {
        this.tagName = tagName.toUpperCase();
        this.nodeType = nodeType;
        this.parentNode = null;
        this.childNodes = [];
        this.attributes = new Map();
        this.listeners = new Map();
        this.className = '';
        this.classList = new FakeClassList(this);
        this.style = {
            setProperty: (name, value) => { this.style[name] = value; },
            removeProperty: (name) => { delete this.style[name]; },
        };
        this._text = '';
        this._value = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.selected = false;
        this.scrollHeight = 0;
        this.clientHeight = 0;
        this.scrollTop = 0;
        this.offsetWidth = 0;
    }

    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get options() { return this.children.filter((node) => node.tagName === 'OPTION'); }
    get text() { return this.textContent; }
    get value() {
        if (this.tagName !== 'SELECT') return this._value;
        const selected = this.options.find((option) => option.selected);
        return (selected || this.options[0] || { value: '' }).value;
    }
    set value(value) {
        if (this.tagName !== 'SELECT') {
            this._value = String(value);
            return;
        }
        this.options.forEach((option) => { option.selected = option.value === String(value); });
    }
    get textContent() {
        return this._text + this.childNodes.map((node) => node.textContent).join('');
    }
    set textContent(value) {
        this.childNodes = [];
        this._text = String(value ?? '');
    }
    get innerHTML() { return this._html || ''; }
    set innerHTML(value) {
        this.childNodes = [];
        this._html = String(value);
        this._text = String(value).replace(/<[^>]*>/g, '');
    }

    appendChild(node) {
        // As in the DOM, appending a fragment moves its children in, not the fragment.
        if (node.nodeType === 11) {
            [...node.childNodes].forEach((child) => this.appendChild(child));
            return node;
        }
        if (node.parentNode) node.parentNode.removeChild(node);
        this._text = '';
        this.childNodes.push(node);
        node.parentNode = this;
        return node;
    }
    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index !== -1) this.childNodes.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    insertBefore(node, reference) {
        if (!reference) return this.appendChild(node);
        if (node.parentNode) node.parentNode.removeChild(node);
        const index = this.childNodes.indexOf(reference);
        this.childNodes.splice(index === -1 ? this.childNodes.length : index, 0, node);
        this._text = '';
        node.parentNode = this;
        return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'class') this.className = String(value);
        if (name === 'id') this.id = String(value);
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }
    dispatchEvent(event) {
        event.target ||= this;
        event.preventDefault ||= function () {};
        event.stopPropagation ||= function () {};
        for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
        return true;
    }
    click() { this.dispatchEvent({ type: 'click', detail: 1 }); }
    focus() {
        let top = this;
        while (top.parentNode) top = top.parentNode;
        if (top.nodeType === 9) top.activeElement = this;
    }
    setSelectionRange() {}
    scrollTo({ top }) { this.scrollTop = top; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map((part) => part.trim());
        const matches = [];
        const visit = (node) => {
            for (const child of node.childNodes) {
                if (child.nodeType === 1 && selectors.some((part) => matchesSelector(child, part))) {
                    matches.push(child);
                }
                visit(child);
            }
        };
        visit(this);
        return matches;
    }
}

function matchesSelector(node, selector) {
    const classMatch = selector.match(/^([a-z0-9-]+)?\.([a-z0-9_-]+)$/i);
    if (classMatch) {
        return (!classMatch[1] || node.tagName === classMatch[1].toUpperCase())
            && node.classList.contains(classMatch[2]);
    }
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    return node.tagName === selector.toUpperCase();
}

class FakeDocument extends FakeNode {
    constructor() {
        super('#document', 9);
        this.head = new FakeNode('head');
        this.body = new FakeNode('body');
        this.appendChild(this.head);
        this.appendChild(this.body);
        this.activeElement = null;
        // applyColumnPush() reads and writes custom properties on <html>.
        this.documentElement = new FakeNode('html');
    }
    createElement(tag) { return new FakeNode(tag); }
    createDocumentFragment() { return new FakeNode('#document-fragment', 11); }
    // The visual renderers draw SVG. The fake tree does not model namespaces,
    // so an element is an element — what the tests assert is the shape drawn.
    createElementNS(namespace, tag) {
        const node = new FakeNode(tag);
        node.namespaceURI = namespace;
        return node;
    }
    createTextNode(text) {
        const node = new FakeNode('#text', 3);
        node.textContent = text;
        return node;
    }
    getElementById(id) {
        return this.querySelectorAll('*').find((node) => node.id === id) || null;
    }
    getElementsByTagName(tag) { return this.querySelectorAll(tag); }
}

// A handoff confirmation always offers two choices — switch, or stay with the
// current agent (see AgentHandoffTool in app/lib/agent_runtime/tools.py). The
// widget only renders a picker above 2 real choices (WPIN-8940); a one-choice
// question degrades to a bare free-text composer with no row to click, so the
// tests below have to send both. 'accept' stays first: they click the first option.
const HANDOFF_CHOICES = ['accept', 'decline'];

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sse(events, done = true) {
    const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
    if (done) chunks.push('data: [DONE]\n\n');
    return new Response(chunks.join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.fail(message);
}

function find(root, tagName, text) {
    return root.querySelectorAll(tagName).find((node) => node.textContent.includes(text));
}

function mount(fetchImpl, options = {}) {
    const document = new FakeDocument();
    // A nonce-CSP host (partners.one) loads the widget from a <script nonce>.
    if (options.hostNonce) document.currentScript = { nonce: options.hostNonce };
    const root = new FakeNode('div');
    document.body.appendChild(root);
    const windowListeners = new Map();
    const window = {
        WapClientConfig: {},
        console,
        // The column's debounced preference write goes through window.setTimeout.
        setTimeout,
        clearTimeout,
        matchMedia: options.matchMedia || (() => ({ matches: false })),
        customElements: { get: () => null },
        // Streamed text is painted on a frame callback (see scheduleRender in
        // wap-chat.js). Without these, the first text_delta throws and the rest
        // of the SSE stream is never processed.
        requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
        cancelAnimationFrame: (handle) => clearTimeout(handle),
        addEventListener(type, listener) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(listener);
        },
        removeEventListener(type, listener) {
            const listeners = windowListeners.get(type) || [];
            windowListeners.set(type, listeners.filter((candidate) => candidate !== listener));
        },
        dispatchEvent(event) {
            for (const listener of windowListeners.get(event.type) || []) listener.call(window, event);
            return true;
        },
    };
    const context = {
        AbortController,
        console,
        CustomEvent,
        document,
        Event,
        fetch: fetchImpl,
        getComputedStyle: () => ({ color: 'rgb(0, 0, 0)', getPropertyValue: () => '' }),
        setTimeout,
        clearTimeout,
        // No-op: the only interval refreshes "5 minutes ago" labels, and a live
        // one would keep the test process running.
        setInterval: () => 0,
        clearInterval: () => {},
        TextDecoder,
        URL,
        URLSearchParams,
        window,
        ...(options.context || {}),
    };
    vm.runInNewContext(widgetSource, context, { filename: 'wap-chat.js' });
    const initOptions = Object.assign({
        root,
        loadGravity: false,
        wapBrowserUrl: 'https://wap.test',
        conversationId: 'source-thread',
        getSession: ({ forceNew }) => options.getSession
            ? options.getSession(forceNew)
            : Promise.resolve({ token: forceNew ? 'fresh-token' : 'token' }),
        layout: Object.assign({
            width: 'fluid',
            expandToggle: 'off',
            showHeader: false,
            showNewChat: false,
            showSettings: false,
            showDeleteData: false,
        }, options.layout),
        ...(options.init || {}),
    }, options.consent ? { consent: options.consent } : {});
    // options.column mounts through WapChat.mount() so the test gets the
    // expand()/collapse() handle; everything else uses plain init().
    if (options.column) {
        delete initOptions.root;
        const handle = window.WapChat.mount(document.body, Object.assign(initOptions, { column: options.column }));
        return { document, root: handle.root, window, column: handle };
    }
    window.WapChat.init(initOptions);
    return { document, root, window };
}

// ── Permissions section (RKM-2081) ───────────────────────────────────────────

const PERMISSION_ROWS = [
    {
        id: 'manage-plugin',
        label: 'Manage your Rank Math plugin',
        options: [{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }],
        defaultValue: 'deny',
    },
    {
        id: 'manage-site',
        label: 'Manage your WordPress website',
        options: [{ value: 'deny', label: 'Deny' }],
        defaultValue: 'deny',
    },
];

/** Mount with the settings gear enabled, open the sheet, and return its card. */
async function openSettingsSheet(init, mountOptions = {}) {
    const harness = mount(
        () => json({}),
        Object.assign({ layout: { showHeader: true, showSettings: true }, init }, mountOptions),
    );
    const gear = harness.root
        .querySelectorAll('button')
        .find((node) => node.getAttribute('aria-label') === 'Chat settings');
    assert.ok(gear, 'settings gear should be rendered');
    gear.click();

    const card = harness.root.querySelector('.wap-settings__card');
    assert.ok(card, 'settings sheet should open');
    return Object.assign({ card, gear }, harness);
}

/**
 * Each row's control: its <select>, or for an allow/deny row a view of its toggle
 * that reads and writes the same 'allow'/'deny' values a select would.
 */
function permissionControls(card) {
    return card.querySelectorAll('.wap-settings__row--permission').map((row) => {
        const select = row.querySelector('select');
        if (select) return select;
        const input = row.querySelector('input');
        return {
            toggle: true,
            get value() { return input.checked ? 'allow' : 'deny'; },
            set value(next) { input.checked = next === 'allow'; },
            get disabled() { return input.disabled; },
            dispatchEvent: (event) => input.dispatchEvent(event),
        };
    });
}

test('the right-most header action gets a right-aligned tooltip', async () => {
    const { root } = mount(() => json({}), { layout: { showHeader: true, showNewChat: true, showSettings: true } });
    const tips = root.querySelector('.wap-chat__actions').children;

    assert.equal(tips.length, 2);
    assert.ok(!tips[0].classList.contains('wap-tip--end'), 'New chat keeps its centred tooltip');
    assert.ok(tips[1].classList.contains('wap-tip--end'), 'Settings, at the edge, is right-aligned');
    assert.ok(tips[1].querySelector('.gv-tooltip').classList.contains('gv-arrow-top-right'));
});

test('the header New chat button shows the add icon', async () => {
    const { root } = mount(() => json({}), { layout: { showHeader: true, showNewChat: true } });
    const button = root.querySelector('.wap-chat__actions').querySelectorAll('button')
        .find((node) => node.getAttribute('aria-label') === 'New chat');

    assert.ok(/\/add\.svg$/.test(button.querySelector('gv-icon').getAttribute('src')));
});

test('a click on the empty part of the composer focuses the textarea, but not one on Send', async () => {
    const { root } = mount(() => json({}));
    const textarea = root.querySelector('textarea');
    let focused = 0;
    textarea.focus = () => { focused += 1; };
    const box = root.querySelector('.gv-input-textarea');

    // The fake DOM doesn't bubble, so dispatch on the box with the real target.
    box.dispatchEvent({ type: 'mousedown', target: box.querySelector('.gv-input-toolbar') });
    assert.equal(focused, 1, 'the toolbar strip under the text focuses the textarea');

    const send = box.querySelector('button.gv-button-primary');
    box.dispatchEvent({ type: 'mousedown', target: send });
    assert.equal(focused, 1, 'Send keeps its own click');
});

test('no permissions configured leaves the settings sheet untouched', async () => {
    const { card } = await openSettingsSheet({});
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(card.querySelectorAll('.wap-settings__rows').length, 0);
    assert.ok(!card.textContent.includes('Permissions'));
});

test('permission rows render, and a single-option row is read-only', async () => {
    const { card } = await openSettingsSheet({
        permissions: PERMISSION_ROWS,
        permissionState: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionControls(card).length === 2, 'both permission rows should render');

    const [plugin, site] = permissionControls(card);
    assert.equal(plugin.toggle, true, 'an allow/deny row is a toggle');
    assert.equal(plugin.disabled, false, 'a two-option row stays interactive');
    assert.equal(site.disabled, true, 'a single-option row is read-only');
    assert.ok(card.textContent.includes('Manage your Rank Math plugin'));
});

test('a row with a value besides allow/deny keeps the select, and a badge shows next to its label', async () => {
    const { card } = await openSettingsSheet({
        permissions: [
            Object.assign({}, PERMISSION_ROWS[0], {
                options: [
                    { value: 'allow', label: 'Allow' },
                    { value: 'ask', label: 'Ask permission' },
                    { value: 'deny', label: 'Deny' },
                ],
            }),
            Object.assign({}, PERMISSION_ROWS[1], { badge: 'Coming soon' }),
        ],
        permissionState: { get: () => Promise.resolve('ask'), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionControls(card).length === 2, 'both rows should render');

    const [plugin, site] = permissionControls(card);
    assert.equal(plugin.tagName, 'SELECT');
    assert.equal(plugin.options.length, 3);
    assert.equal(plugin.value, 'ask');
    assert.equal(site.toggle, true);
    assert.equal(card.querySelector('.wap-settings__badge').textContent, 'Coming soon');
});

test('Delete my data sits in the settings page, not in the header', async () => {
    const { root, card } = await openSettingsSheet({}, { layout: { showHeader: true, showSettings: true, showDeleteData: true } });

    assert.ok(card.querySelector('.wap-settings__delete'), 'the delete action is a settings row');
    assert.equal(
        root.querySelectorAll('button').filter((node) => node.getAttribute('aria-label') === 'Delete my data').length,
        0,
        'no header delete icon next to the gear',
    );
});

test('stored values win over defaults, and unknown stored values fall back', async () => {
    const stored = { 'manage-plugin': 'allow', 'manage-site': 'something-else' };
    const { card } = await openSettingsSheet({
        permissions: PERMISSION_ROWS,
        permissionState: { get: (id) => Promise.resolve(stored[id]), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionControls(card).length === 2, 'rows should render');

    const [plugin, site] = permissionControls(card);
    assert.equal(plugin.value, 'allow', 'the stored value is selected');
    assert.equal(site.value, 'deny', 'a value the row does not offer falls back to the default');
});

test('a read failure never throws out of the sheet; the row shows its default', async () => {
    const { card } = await openSettingsSheet({
        permissions: PERMISSION_ROWS,
        permissionState: { get: () => Promise.reject(new Error('store down')), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionControls(card).length === 2, 'rows should still render');

    assert.equal(permissionControls(card)[0].value, 'deny');
});

test('changing a permission saves once and re-mints the session without forceNew', async () => {
    const sets = [];
    const sessions = [];
    const { card } = await openSettingsSheet(
        {
            permissions: PERMISSION_ROWS,
            permissionState: {
                get: () => Promise.resolve('deny'),
                set: (id, value) => { sets.push([id, value]); return Promise.resolve(); },
            },
        },
        {
            getSession: (forceNew) => {
                sessions.push(forceNew);
                return Promise.resolve({ token: 'token-' + sessions.length });
            },
        },
    );
    await waitFor(() => permissionControls(card).length === 2, 'rows should render');
    sessions.length = 0; // drop the mount's own auth

    const plugin = permissionControls(card)[0];
    plugin.value = 'allow';
    plugin.dispatchEvent({ type: 'change' });

    await waitFor(() => sessions.length === 1, 'the session should be re-minted exactly once');
    assert.deepEqual(sets, [['manage-plugin', 'allow']], 'set() is called exactly once');
    assert.deepEqual(
        sessions,
        [false],
        'forceNew must stay false — it revokes and re-mints the Application Password and is throttled',
    );
});

test('a rejected save reverts the control and leaves the session alone', async () => {
    const sessions = [];
    const { card } = await openSettingsSheet(
        {
            permissions: PERMISSION_ROWS,
            permissionState: {
                get: () => Promise.resolve('deny'),
                set: () => Promise.reject(new Error('nope')),
            },
        },
        {
            getSession: (forceNew) => {
                sessions.push(forceNew);
                return Promise.resolve({ token: 'token' });
            },
        },
    );
    await waitFor(() => permissionControls(card).length === 2, 'rows should render');
    sessions.length = 0;

    const plugin = permissionControls(card)[0];
    plugin.value = 'allow';
    plugin.dispatchEvent({ type: 'change' });

    await waitFor(
        () => card.querySelector('.wap-settings__error') && !card.querySelector('.wap-settings__error').hidden,
        'the error notice should appear',
    );
    assert.equal(plugin.value, 'deny', 'the selection reverts to what is actually stored');
    assert.equal(plugin.disabled, false, 'the control is usable again');
    assert.deepEqual(sessions, [], 'a failed save must not re-mint the session');
});

// The WordPress adapter itself (no permissionState hook): admin-ajax replies as WordPress sends them.
const AJAX_URL = 'https://site.test/wp-admin/admin-ajax.php';

async function openWordPressPermissions(setReply) {
    const posts = [];
    const sessions = [];
    const fetchImpl = (url, request = {}) => {
        if (url !== AJAX_URL) return Promise.resolve(json({}));
        const body = Object.fromEntries(new URLSearchParams(request.body));
        posts.push(body);
        if (body.op === 'get') return Promise.resolve(json({ success: true, data: { value: 'deny' } }));
        return Promise.resolve(setReply(body));
    };
    const harness = mount(fetchImpl, {
        layout: { showHeader: true, showSettings: true },
        init: { permissions: PERMISSION_ROWS, ajaxUrl: AJAX_URL, permissionNonce: 'nonce-1', product: 'rankmath' },
        getSession: (forceNew) => {
            sessions.push(forceNew);
            return Promise.resolve({ token: 'token' });
        },
    });
    harness.root.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === 'Chat settings').click();
    const card = harness.root.querySelector('.wap-settings__card');
    await waitFor(() => permissionControls(card).length === 2 && !permissionControls(card)[0].disabled, 'rows should load');
    sessions.length = 0;

    const plugin = permissionControls(card)[0];
    plugin.value = 'allow';
    plugin.dispatchEvent({ type: 'change' });
    return { card, plugin, posts, sessions };
}

async function assertSaveRejected({ card, plugin, sessions }, message) {
    const notice = () => card.querySelector('.wap-settings__error');
    await waitFor(() => notice() && !notice().hidden, 'the error notice should appear');
    assert.equal(plugin.value, 'deny', 'the selection reverts to what is actually stored');
    assert.equal(plugin.disabled, false, 'the control is usable again');
    assert.deepEqual(sessions, [], 'a failed save must not re-mint the session');
    assert.equal(card.querySelector('.wap-settings__error').textContent.includes(message), true);
}

test('WordPress save: success posts the change and re-mints the session', async () => {
    const opened = await openWordPressPermissions(() => json({ success: true, data: { value: 'allow' } }));
    await waitFor(() => opened.sessions.length === 1, 'the session should be re-minted once');
    const set = opened.posts.find((body) => body.op === 'set');
    assert.deepEqual(
        { action: set.action, nonce: set._ajax_nonce, product: set.product, id: set.id, value: set.value },
        { action: 'wap_client_permission_state', nonce: 'nonce-1', product: 'rankmath', id: 'manage-plugin', value: 'allow' },
    );
    assert.equal(opened.plugin.value, 'allow');
});

test('WordPress save: an expired nonce ("-1", 403) is a failure, not a silent success', async () => {
    const opened = await openWordPressPermissions(() => new Response('-1', { status: 403 }));
    await assertSaveRejected(opened, 'Could not save that setting');
});

test('WordPress save: a logged-out reply ("0", 400) is a failure', async () => {
    const opened = await openWordPressPermissions(() => new Response('0', { status: 400 }));
    await assertSaveRejected(opened, 'Could not save that setting');
});

test('WordPress save: the server error message is shown', async () => {
    const opened = await openWordPressPermissions(
        () => json({ success: false, data: { message: 'Insufficient permissions.' } }, 403),
    );
    await assertSaveRejected(opened, 'Insufficient permissions.');
});

test('WordPress save: a 200 reply without success: true is a failure', async () => {
    const opened = await openWordPressPermissions(() => json({ data: { value: 'allow' } }));
    await assertSaveRejected(opened, 'Could not save that setting');
});

test('permission rows without a state hook render read-only', async () => {
    const { card } = await openSettingsSheet({ permissions: PERMISSION_ROWS });
    await waitFor(() => permissionControls(card).length === 2, 'rows should render');

    assert.deepEqual(permissionControls(card).map((node) => node.disabled), [true, true]);
});

test('malformed permission rows are dropped rather than breaking the sheet', async () => {
    const { card } = await openSettingsSheet({
        permissions: [
            { id: 'GOOD-ID', label: 'Uppercase id', options: [{ value: 'a', label: 'A' }], defaultValue: 'a' },
            { id: 'no-options', label: 'No options', options: [], defaultValue: 'a' },
            { id: 'bad-default', label: 'Default off-menu', options: [{ value: 'a', label: 'A' }], defaultValue: 'z' },
            { id: 'dupe', label: 'First wins', options: [{ value: 'a', label: 'A' }], defaultValue: 'a' },
            { id: 'dupe', label: 'Second loses', options: [{ value: 'b', label: 'B' }], defaultValue: 'b' },
        ],
        permissionState: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionControls(card).length === 1, 'only the one valid row survives');

    assert.ok(card.textContent.includes('First wins'));
    assert.ok(!card.textContent.includes('Second loses'));
});

test('configuring permissions with the settings gear hidden warns and renders nothing', async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
        const harness = mount(() => json({}), {
            layout: { showHeader: true, showSettings: false },
            init: { permissions: PERMISSION_ROWS },
        });
        const gear = harness.root
            .querySelectorAll('button')
            .find((node) => node.getAttribute('aria-label') === 'Chat settings');
        assert.equal(gear, undefined, 'the gear stays hidden — showSettings is not overridden');
    } finally {
        console.warn = originalWarn;
    }

    assert.ok(
        warnings.some((line) => line.includes('layout.showSettings is false')),
        'the unreachable-section warning should be emitted, got: ' + JSON.stringify(warnings),
    );
});


const agents = [
    {
        role: 'wp-rocket:standard',
        agentId: 'source-id',
        name: 'Assistant',
        displayName: 'WP Rocket Assistant',
        current: true,
    },
    {
        role: 'wp-rocket:performance',
        agentId: 'target-id',
        name: 'Performance Analyst',
        displayName: 'WP Rocket Performance Analyst',
        current: false,
    },
];

const otherAgent = {
    role: 'wp-rocket:seo',
    agentId: 'other-id',
    name: 'SEO Analyst',
    displayName: 'WP Rocket SEO Analyst',
    current: false,
};

// ── Permission card (RKM-2010) ───────────────────────────────────────────────

const APPROVE_VALUE = 'approve:0123456789abcdef';

function permissionQuestionEvent(actions) {
    return {
        type: 'question',
        question: 'English fallback question',
        choices: [{ label: 'Allow', value: APPROVE_VALUE }, { label: "Don't allow", value: 'reject' }],
        multi_select: false,
        allow_free_text: false,
        presentation: { kind: 'permission_request', actions, approveValue: APPROVE_VALUE, rejectValue: 'reject' },
    };
}

// event: the question event, or the whole list of stream events ending in one.
async function askPermission(event, i18n) {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (url.endsWith('/api/v1/chat/stream')) return sse(Array.isArray(event) ? event : [event]);
        if (url.endsWith('/api/v1/chat/resume')) return sse([]);
        return json({});
    };
    const { root } = mount(fetchImpl, i18n ? { init: { i18n } } : {});
    await waitFor(() => !!root.querySelector('textarea'), 'composer');
    root.querySelector('textarea').value = 'fix my SEO';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!root.querySelector('.wap-chat__question-text'), 'the question should render');
    return { root, requests };
}

const GERMAN = {
    permissionAskOne: 'Der Assistent möchte {action} auf deiner Website ausführen. Erlauben?',
    permissionAskMany: 'Der Assistent möchte diese Aktionen ausführen:',
    permissionAskManyConfirm: 'Erlauben?',
    permissionAllow: 'Erlauben',
    permissionDeny: 'Nicht erlauben',
};

test('a permission card is worded from the widget translations, not the server text', async () => {
    const { root, requests } = await askPermission(permissionQuestionEvent(['rank-math/fix-site-seo']), GERMAN);
    const text = root.querySelector('.wap-chat__question-text').textContent;

    assert.equal(text, 'Der Assistent möchte rank-math/fix-site-seo auf deiner Website ausführen. Erlauben?');
    assert.equal(root.querySelector('.wap-chat__question-text').querySelector('code').textContent, 'rank-math/fix-site-seo');
    assert.ok(find(root, 'span', 'Nicht erlauben'), 'the Don\'t allow label is translated');

    root.querySelector('.wap-reply__option').click(); // the first choice is Allow
    await waitFor(() => requests.some((r) => r.url.endsWith('/chat/resume')), 'resume request');
    const resume = requests.find((r) => r.url.endsWith('/chat/resume'));
    assert.equal(resume.body.answer, APPROVE_VALUE, 'Allow resumes with the fingerprinted value, not "approve"');
});

test('a multi-action permission card lists every action as text, never as markup', async () => {
    const actions = ['rank-math/a', 'rank-math/b', '<img src=x onerror=alert(1)>'];
    const { root } = await askPermission(permissionQuestionEvent(actions));
    const question = root.querySelector('.wap-chat__question-text');
    const items = question.querySelectorAll('li').map((li) => li.textContent);

    assert.deepEqual(items, actions);
    assert.equal(question.querySelectorAll('img').length, 0);
    assert.ok(root.querySelector('.wap-chat__question-text').textContent.endsWith('Allow them?'));
});

test('a question without the permission presentation keeps the server text', async () => {
    const event = permissionQuestionEvent(['rank-math/x']);
    delete event.presentation;
    const { root } = await askPermission(event, GERMAN);

    assert.ok(root.querySelector('.wap-chat__question-text').textContent.includes('English fallback question'));
    assert.ok(find(root, 'span', 'Allow'), 'labels come from the server when there is no presentation');
});

// ── Markdown lists (RKM-2088) ───────────────────────────────────────────────

/** Render markdown through the widget: an ask_user question is set as innerHTML. */
async function renderedMarkdown(markdown) {
    const { root } = await askPermission({ type: 'question', question: markdown, choices: [] });
    return root.querySelector('.wap-chat__question-text').innerHTML;
}

test('numbered sections keep their numbering and hold their own paragraphs and steps', async () => {
    const html = await renderedMarkdown([
        '1. **Check your email**',
        '   An invoice is sent automatically.',
        '',
        '2. **Download it**',
        '   1. Log in',
        '   2. Open Invoices',
        '',
        'Done.',
    ].join('\n'));

    assert.equal(html,
        '<ol><li><strong>Check your email</strong><p>An invoice is sent automatically.</p></li>' +
        '<li><strong>Download it</strong><ol><li>Log in</li><li>Open Invoices</li></ol></li></ol>' +
        '<p>Done.</p>');
});

test('an ordered list split by unindented text resumes at its own number', async () => {
    const html = await renderedMarkdown('1. First\n\nAn aside.\n\n2. Second');

    assert.equal(html, '<ol><li>First</li></ol><p>An aside.</p><ol start="2"><li>Second</li></ol>');
});

// ── Step checklist ───────────────────────────────────────────────────────────

const STEP_I18N = { searching: 'Searching the web…', reading: 'Reading a page…' };

async function streamSteps(events) {
    const fetchImpl = async (url) => {
        if (url.endsWith('/api/v1/chat/stream')) return sse(events);
        return json({});
    };
    const { root } = mount(fetchImpl, { init: { i18n: STEP_I18N } });
    await waitFor(() => !!root.querySelector('textarea'), 'composer');
    root.querySelector('textarea').value = 'research this';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!root.querySelector('.gv-step-done') && !root.querySelector('.gv-step-working'), 'the sealed checklist');
    return root;
}

const stepLabels = (loader) => loader.querySelectorAll('span')
    .filter((node) => node.hasAttribute('data-label'))
    .map((node) => node.getAttribute('data-label'));

test('several steps collapse to the latest one, with a caret to show them all', async () => {
    const root = await streamSteps([
        { type: 'status', key: 'searching' },
        { type: 'status', key: 'reading' },
        { type: 'status', key: 'searching' },
        { type: 'message_end' },
    ]);
    const loader = root.querySelector('.gv-stream-loader');

    assert.deepEqual(stepLabels(loader), ['Searching the web…', 'Reading a page…'], 'each label once, in first-seen order');
    assert.ok(loader.classList.contains('wap-steps--many'));
    const latest = loader.querySelectorAll('.wap-step--latest');
    assert.equal(latest.length, 1);
    assert.equal(latest[0].getAttribute('data-label'), 'Searching the web…', 're-activating a step makes it the latest');
    assert.ok(latest[0].classList.contains('gv-step-done'), 'sealed when the turn ends');

    const toggle = loader.querySelector('.wap-steps__toggle');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.ok(loader.classList.contains('wap-steps--open'));
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), 'Hide details');
    toggle.click();
    assert.ok(!loader.classList.contains('wap-steps--open'));
    assert.equal(toggle.getAttribute('aria-label'), 'Show details');
});

test('a single step has no caret', async () => {
    const root = await streamSteps([
        { type: 'status', key: 'searching' },
        { type: 'message_end' },
    ]);
    const loader = root.querySelector('.gv-stream-loader');

    assert.deepEqual(stepLabels(loader), ['Searching the web…'], 'the Thinking placeholder is relabelled in place');
    assert.equal(loader.querySelector('.wap-steps__toggle'), null);
    assert.ok(!loader.classList.contains('wap-steps--many'));
});

test('the checklist goes once the answer streams, and comes back for a later tool step', async () => {
    let push;
    const fetchImpl = async (url) => {
        if (!url.endsWith('/api/v1/chat/stream')) return json({});
        const body = new ReadableStream({ start(controller) { push = controller; } });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const { root } = mount(fetchImpl, { init: { i18n: STEP_I18N } });
    await waitFor(() => !!root.querySelector('textarea'), 'composer');
    root.querySelector('textarea').value = 'research this';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!push, 'the stream opens');

    const send = (event) => push.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    send({ type: 'status', key: 'searching' });
    await waitFor(() => !!root.querySelector('.gv-step-working'), 'the first step');

    send({ type: 'text_delta', delta: 'Let me check one more page.' });
    await waitFor(() => !root.querySelector('.gv-stream-loader'), 'the checklist goes with the first text');

    send({ type: 'status', key: 'reading' });
    await waitFor(() => !!root.querySelector('.gv-stream-loader'), 'a later step brings it back');
    assert.deepEqual(stepLabels(root.querySelector('.gv-stream-loader')), ['Reading a page…']);

    send({ type: 'text_delta', delta: ' Done.' });
    await waitFor(() => !root.querySelector('.gv-stream-loader'), 'and the next text drops it again');
    send({ type: 'message_end' });
    push.close();
});

test('a live reply gets its time only once the stream has ended', async () => {
    let push;
    const fetchImpl = async (url) => {
        if (!url.endsWith('/api/v1/chat/stream')) return json({});
        const body = new ReadableStream({ start(controller) { push = controller; } });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const { root } = mount(fetchImpl, { init: { i18n: STEP_I18N } });
    await waitFor(() => !!root.querySelector('textarea'), 'composer');
    root.querySelector('textarea').value = 'research this';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!push, 'the stream opens');

    const send = (chunk) => push.enqueue(new TextEncoder().encode(chunk));
    send(`data: ${JSON.stringify({ type: 'status', key: 'searching' })}\n\n`);
    send(`data: ${JSON.stringify({ type: 'text_delta', delta: 'Half an answer' })}\n\n`);
    await waitFor(() => !root.querySelector('.gv-stream-loader'), 'the answer starts');
    assert.equal(root.querySelector('.wap-msg-time'), null, 'no time while the reply is still streaming');

    send('data: [DONE]\n\n');
    push.close();
    await waitFor(() => !!root.querySelector('.wap-msg-time'), 'the time appears when the turn ends');
    assert.equal(root.querySelectorAll('.wap-msg-time').length, 1);
});

// ── Response selector (RKM-2088) ─────────────────────────────────────────────

function auditQuestion(choices) {
    return {
        type: 'question',
        question: 'Do you want me to run a full SEO audit now?',
        choices,
        multi_select: false,
        allow_free_text: true,
    };
}

const optionLabels = (root) => root.querySelectorAll('.wap-reply__option').map((node) => node.querySelector('.wap-reply__label').textContent);

test('a question the model also wrote as text before calling ask_user shows once', async () => {
    const question = 'Which part would you like to dig into?';
    const { root } = await askPermission([
        { type: 'text_delta', delta: question },
        // The tool call is announced between the text and the question.
        { type: 'tool_use', tool: 'ask_user', input: { question } },
        { type: 'status', phase: 'tool', key: 'working' },
        { ...auditQuestion(['Focus keywords', 'Content score']), question },
    ]);
    const bubble = root.querySelectorAll('.gv-chat-incoming').pop();

    assert.equal(bubble.querySelectorAll('.wap-chat-message-text').length, 0, 'the streamed copy is dropped');
    root.querySelector('.wap-reply__option').click();
    assert.equal(bubble.querySelectorAll('.wap-chat__question-text').length, 1, 'one copy stays in the transcript');
    assert.equal(bubble.querySelectorAll('.wap-chat-message-text').length, 0);
});

test('text before a tool call that is not the question is kept', async () => {
    const { root } = await askPermission([
        { type: 'text_delta', delta: 'Let me check your settings first.' },
        { type: 'tool_use', tool: 'ask_user', input: {} },
        auditQuestion(['Yes, run it', 'Not now']),
    ]);
    const bubble = root.querySelectorAll('.gv-chat-incoming').pop();

    assert.equal(bubble.querySelectorAll('.wap-chat-message-text').length, 1);
});

test('a model-written catch-all option is dropped, leaving the free-text row as the only "else"', async () => {
    const { root } = await askPermission(auditQuestion(['Yes, run it', 'Not now', 'Other (please specify)']));

    assert.deepEqual(optionLabels(root), ['Yes, run it', 'Not now']);
    assert.deepEqual(root.querySelectorAll('.wap-reply__key').map((node) => node.textContent), ['1', '2']);
    assert.ok(root.querySelector('.wap-reply__else').querySelector('input'), 'the free-text row is offered');
});

test('a catch-all option is kept when free text is off, and real options starting with "Other" are kept', async () => {
    const event = auditQuestion(['Other plugins', 'Something else']);
    event.allow_free_text = false;
    const { root } = await askPermission(event);

    assert.deepEqual(optionLabels(root), ['Other plugins', 'Something else']);
    assert.equal(root.querySelector('.wap-reply__else'), null);
});

test('typing in the selector answers with that text instead of a choice', async () => {
    const { root, requests } = await askPermission(auditQuestion(['Yes, run it', 'Not now']));
    const input = root.querySelector('.wap-reply__else').querySelector('input');
    input.value = 'Only the homepage';
    input.dispatchEvent({ type: 'keydown', key: 'Enter' });

    await waitFor(() => requests.some((r) => r.url.endsWith('/chat/resume')), 'resume request');
    assert.equal(requests.find((r) => r.url.endsWith('/chat/resume')).body.answer, 'Only the homepage');
    assert.equal(root.querySelector('.wap-reply'), null, 'the card is gone');
    assert.ok(find(root, 'li', 'Do you want me to run a full SEO audit now?'), 'the question stays in the transcript');
});

test('Skip resumes the run with a skip answer', async () => {
    const { root, requests } = await askPermission(auditQuestion(['Yes, run it', 'Not now']));
    root.querySelector('.wap-reply__skip').click();

    await waitFor(() => requests.some((r) => r.url.endsWith('/chat/resume')), 'resume request');
    assert.equal(requests.find((r) => r.url.endsWith('/chat/resume')).body.answer, 'The user skipped this question.');
});

function docOf(node) {
    while (node.parentNode) node = node.parentNode;
    return node;
}

test('the selector card takes focus, not its first option', async () => {
    const { root } = await askPermission(auditQuestion(['Yes, run it', 'Not now']));
    const card = root.querySelector('.wap-reply');
    await waitFor(() => docOf(root).activeElement === card, 'the card focused');

    assert.equal(card.getAttribute('tabindex'), '-1');
});

test('Up/Down step through the options and the free-text field, wrapping at the ends', async () => {
    const { root } = await askPermission(auditQuestion(['Yes, run it', 'Not now']));
    const card = root.querySelector('.wap-reply');
    const [yes, no] = root.querySelectorAll('.wap-reply__option');
    const input = root.querySelector('.wap-reply__else').querySelector('input');
    const doc = docOf(root);
    const press = (key) => card.dispatchEvent({ type: 'keydown', key, target: doc.activeElement });

    card.focus();
    press('ArrowDown');
    assert.equal(doc.activeElement, yes, 'Down from the card starts at the top');
    press('ArrowDown');
    assert.equal(doc.activeElement, no);
    press('ArrowDown');
    assert.equal(doc.activeElement, input, 'the free-text field is the last stop');
    press('ArrowDown');
    assert.equal(doc.activeElement, yes, 'and wraps to the top');
    press('ArrowUp');
    assert.equal(doc.activeElement, input, 'Up wraps to the bottom');

    root.querySelector('.wap-reply__skip').focus();
    press('ArrowUp');
    assert.equal(doc.activeElement, no, 'Skip counts as the free-text row');

    card.focus();
    press('ArrowUp');
    assert.equal(doc.activeElement, input, 'Up from the card starts at the bottom');
});

test('closing the selector leaves the run paused for the next composer message', async () => {
    const { root, requests } = await askPermission(auditQuestion(['Yes, run it', 'Not now']));
    root.querySelector('.wap-reply__close').click();

    assert.equal(root.querySelector('.wap-reply'), null, 'the card is gone');
    assert.ok(find(root, 'li', 'Do you want me to run a full SEO audit now?'), 'the question stays in the transcript');
    assert.equal(requests.filter((r) => r.url.endsWith('/chat/resume')).length, 0, 'closing does not answer');
});

test('widget advertises handoffs and submits object choice values without displaying them', async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/api/v1/chat/source-thread/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/chat/resume')) return sse([]);
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: [
                    { label: 'Yes, switch', value: 'handoff-confirm:source-id:target-id' },
                    { label: 'Include diagnostics', value: 'include-diagnostics' },
                ],
                multi_select: true,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'Yes, switch'), 'object choice label');
    const choices = root.querySelectorAll('.wap-reply__option');
    choices[0].click();
    choices[1].click();
    find(root, 'button', 'Confirm').click();
    await waitFor(() => requests.some((request) => request.url.endsWith('/chat/resume')), 'resume request');

    const resume = requests.find((request) => request.url.endsWith('/chat/resume'));
    assert.equal(resume.body.answer, 'handoff-confirm:source-id:target-id, include-diagnostics');
    assert.ok(find(root, 'li', 'Yes, switch, Include diagnostics'));
    assert.equal(find(root, 'li', 'handoff-confirm:source-id:target-id'), undefined);
    assert.equal(find(root, 'li', 'include-diagnostics'), undefined);
    assert.ok(requests.some((request) => request.url.includes('/source-thread/history')));
});

test('accepted handoff switches first and retries the exact target request once', async () => {
    const requests = [];
    let targetAttempts = 0;
    const authCalls = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body, authorization: init.headers && init.headers.Authorization });
        if (url.includes('/api/v1/chat/source-thread/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) {
            return json(body ? {} : { welcomeTitle: '', welcomeMessage: '', promptSuggestions: [] });
        }
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/history')) {
            return json({ messages: [
                { role: 'handoff', sourceAgent: 'Older Assistant', content: '<older brief>' },
                { role: 'assistant', content: 'Earlier target reply' },
            ] });
        }
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: '<keep this as text>',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            targetAttempts++;
            if (targetAttempts === 1) return json({ detail: { error: 'expired' } }, 401);
            return sse([
                { type: 'message_start', agentName: 'WP Rocket Performance Analyst' },
                { type: 'text_delta', delta: 'Target reply' },
                { type: 'message_end', usage: {} },
            ]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: ['handoff-confirm:source-id:target-id', 'decline'],
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl, {
        getSession: (forceNew) => {
            authCalls.push(forceNew);
            return Promise.resolve({ token: forceNew ? 'fresh-token' : 'token' });
        },
    });
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');

    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'handoff-confirm:source-id:target-id'), 'question choice');

    const choice = root.querySelector('.wap-reply__option');
    choice.click();
    await waitFor(() => targetAttempts === 2, 'target retry');

    const resume = requests.find((request) => request.url.endsWith('/api/v1/chat/resume'));
    assert.equal(resume.body.answer, 'handoff-confirm:source-id:target-id');
    const targetRequests = requests.filter((request) => request.body && request.body.handoff_token);
    assert.equal(targetRequests.length, 2);
    const expectedTargetBody = {
        handoff_token: 'sealed-token',
        agent_role: 'wp-rocket:performance',
    };
    assert.deepEqual(targetRequests.map((request) => request.body), [
        expectedTargetBody,
        expectedTargetBody,
    ]);
    assert.deepEqual(targetRequests.map((request) => request.authorization), [
        'Bearer token',
        'Bearer fresh-token',
    ]);
    assert.deepEqual(authCalls, [false, true]);

    const historyUrls = requests.filter((request) => request.url.includes('/history')).map((request) => request.url);
    assert.ok(historyUrls.some((url) => url.includes('/source-thread/history')));
    assert.ok(historyUrls.some((url) => url.includes('/chat/history')
        && url.includes('agent_role=wp-rocket%3Aperformance')));
    assert.ok(find(root, 'li', 'Handoff from WP Rocket Assistant'));
    assert.ok(find(root, 'li', '<keep this as text>'));
    assert.ok(find(root, 'li', 'Handoff from Older Assistant'));
    assert.ok(find(root, 'li', '<older brief>'));

    const earlierReply = find(root, 'li', 'Earlier target reply');
    assert.equal(earlierReply.querySelector('.wap-meta-author').textContent, 'WP Rocket Performance Analyst');
});

test('accepted handoff does not paint the welcome screen in the target thread (WPIN-8947)', async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/api/v1/chat/source-thread/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) {
            return json({ welcomeTitle: '', welcomeMessage: '', promptSuggestions: [] });
        }
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/history')) {
            return json({ messages: [] });
        }
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: '<keep this as text>',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            return sse([
                { type: 'message_start', agentName: 'WP Rocket Performance Analyst' },
                { type: 'message_end', usage: {} },
            ]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: ['accept', 'decline'],
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');

    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');

    const choice = root.querySelector('.wap-reply__option');
    choice.click();
    await waitFor(() => requests.some((request) => request.body && request.body.handoff_token), 'target request');

    const brief = find(root, 'li', 'Handoff from WP Rocket Assistant');
    assert.ok(brief, 'handoff brief should be the first item in the target thread');
    assert.equal(root.querySelectorAll('li.wap-welcome').length, 0,
        'no welcome screen should be painted when a handoff transition supplies the first item');
});

test('manual selector change to an empty agent still shows the welcome screen', async () => {
    const requests = [];
    const allAgents = agents.concat(otherAgent);
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/api/v1/chat/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) {
            return json({ welcomeTitle: '', welcomeMessage: '', promptSuggestions: ['Try me'] });
        }
        if (url.includes('/api/v1/chat/agents')) return json({ agents: allAgents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root, window } = mount(fetchImpl);
    await waitFor(() => root.querySelector('select') && root.querySelector('select').options.length === 3, 'agent options');

    const events = [];
    window.addEventListener('wap:agentchange', (event) => events.push(event.detail));

    const select = root.querySelector('select');
    select.value = otherAgent.role;
    select.dispatchEvent({ type: 'change' });
    await waitFor(() => events.length === 1, 'agentchange event');
    await waitFor(() => requests.some((request) => request.url.includes('agent_role=wp-rocket%3Aseo')), 'target history request');
    await waitFor(() => {
        const list = root.querySelector('ul.gv-chat-list');
        return list && list.querySelectorAll('.wap-loading').length === 0;
    }, 'initial load to settle');

    const welcome = root.querySelectorAll('li.wap-welcome')[0];
    assert.ok(welcome, 'welcome screen should still appear for a manual switch to an empty agent');
    assert.equal(welcome.querySelector('.gv-chip').textContent, 'Try me');
});

test('clicking a suggested prompt sends it right away', async () => {
    const streams = [];
    const fetchImpl = async (url, init = {}) => {
        if (url.includes('/api/v1/chat/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) {
            return json({ welcomeTitle: '', welcomeMessage: '', promptSuggestions: ['How to add multiple keywords?'] });
        }
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: agents[0].role });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        if (url.includes('/api/v1/chat/stream')) {
            streams.push(JSON.parse(init.body));
            return sse([{ type: 'message_start' }, { type: 'text_delta', text: 'Sure.' }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => root.querySelector('.gv-chip'), 'suggestion chip');
    root.querySelector('.gv-chip').click();

    await waitFor(() => streams.length === 1, 'the prompt should be streamed without pressing Send');
    assert.equal(streams[0].message, 'How to add multiple keywords?');
    assert.equal(root.querySelector('textarea').value, '', 'the composer is left empty');
    assert.equal(root.querySelectorAll('li.wap-welcome').length, 0, 'the welcome screen is cleared');
});

test('the picker sits in the left toolbar slot and the legal notice under the composer', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('/api/v1/chat/history')) return json({ messages: [] });
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: agents[0].role });
        return json({});
    };
    const { root } = mount(fetchImpl, { init: { termsUrl: 'https://example.test/terms', privacyUrl: 'https://example.test/privacy' } });
    await waitFor(() => root.querySelector('select') && root.querySelector('select').options.length > 0, 'agent options');

    assert.ok(root.querySelector('.gv-toolbar-content').querySelector('.wap-agent-select'), 'picker is in the left slot');
    assert.equal(root.querySelector('.gv-toolbar-end').querySelector('.wap-agent-select'), null);
    const notice = root.querySelector('.gv-input-ai').querySelector('.wap-legal-notice');
    assert.ok(notice, 'the legal notice belongs to the composer');
    assert.ok(notice.querySelectorAll('a').some((a) => a.href === 'https://example.test/privacy'));
    assert.equal(root.querySelector('.wap-chat__meta-bar'), null, 'no separate footer bar');
});

test('a reply shows a relative time and keeps its author for screen readers only', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('/history')) {
            return json({ messages: [
                { role: 'user', content: 'Hi', timestamp: Date.now() - 5 * 60 * 1000 },
                { role: 'assistant', content: 'Hello', timestamp: Date.now() - 5 * 60 * 1000 },
            ] });
        }
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: agents[0].role });
        return json({});
    };
    const { root } = mount(fetchImpl, { init: { locale: 'en_US' } });
    await waitFor(() => root.querySelector('.wap-msg-time'), 'history should render');

    const reply = root.querySelector('li.gv-chat-incoming');
    assert.equal(reply.querySelector('.wap-msg-time').textContent, '5 minutes ago');
    assert.ok(reply.querySelector('.wap-meta-author').className.includes('gv-sr-only'));
    const question = root.querySelector('li.gv-chat-outgoing');
    assert.equal(question.querySelector('.wap-msg-time'), null, 'questions carry no timestamp');
});

test('a reply from history without a timestamp shows no time rather than "now"', async () => {
    const fetchImpl = async (url) => {
        if (url.includes('/history')) return json({ messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }] });
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: agents[0].role });
        return json({});
    };
    const { root } = mount(fetchImpl);
    await waitFor(() => find(root, 'li', 'Hello'), 'history should render');

    assert.equal(root.querySelectorAll('.wap-msg-time').length, 0);
});

test('target authorization retries once and a second 401 is terminal', async () => {
    const requests = [];
    let targetAttempts = 0;
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body, authorization: init.headers && init.headers.Authorization });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'Do not send this brief.',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            targetAttempts++;
            if (targetAttempts <= 2) {
                return json({
                    detail: { error: 'unauthorized', message: 'Still unauthorized.' },
                }, 401);
            }
            return sse([{ type: 'message_start' }, { type: 'message_end', usage: {} }]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl, {
        getSession: (forceNew) => Promise.resolve({ token: forceNew ? 'fresh-token' : 'token' }),
    });
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => !!find(root, 'li', 'Still unauthorized.'), 'terminal target failure');
    await new Promise((resolve) => setTimeout(resolve, 10));

    const targetRequests = requests.filter((request) => request.body && request.body.handoff_token);
    assert.equal(targetAttempts, 2);
    assert.equal(targetRequests.length, 2);
    assert.deepEqual(targetRequests.map((request) => request.authorization), [
        'Bearer token',
        'Bearer fresh-token',
    ]);
    assert.equal(root.querySelector('select').value, 'wp-rocket:standard');
});

test('a remapped target is rejected instead of falling back by role', async () => {
    const requests = [];
    let targetStarts = 0;
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'stale-target-id',
                targetAgent: 'Old Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            targetStarts++;
            return sse([]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => requests.some((request) => request.url.endsWith('/chat/resume')), 'resume request');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(targetStarts, 0);
    assert.equal(root.querySelector('select').value, 'wp-rocket:standard');
    assert.ok(find(root, 'li', 'An error occurred. Please try again.'));
    assert.equal(root.querySelector('.gv-step-working'), null);
});

for (const [name, resumeResponse] of [
    ['unexpected EOF', () => sse([{
        type: 'agent_handoff',
        sourceRole: 'wp-rocket:standard',
        sourceAgentId: 'source-id',
        sourceAgent: 'WP Rocket Assistant',
        targetRole: 'wp-rocket:performance',
        targetAgentId: 'target-id',
        targetAgent: 'WP Rocket Performance Analyst',
        brief: 'brief',
        handoffToken: 'sealed-token',
    }], false)],
    ['error followed by DONE', () => sse([{
        type: 'agent_handoff',
        sourceRole: 'wp-rocket:standard',
        sourceAgentId: 'source-id',
        sourceAgent: 'WP Rocket Assistant',
        targetRole: 'wp-rocket:performance',
        targetAgentId: 'target-id',
        targetAgent: 'WP Rocket Performance Analyst',
        brief: 'brief',
        handoffToken: 'sealed-token',
    }, { type: 'error', code: 'stream_failed', message: 'Source failed' }])],
]) {
    test(`source ${name} does not switch to the target`, async () => {
        const requests = [];
        let targetStarts = 0;
        const fetchImpl = async (url, init = {}) => {
            const body = init.body ? JSON.parse(init.body) : null;
            requests.push({ url, body });
            if (url.includes('/history')) return json({ messages: [] });
            if (url.includes('/api/v1/agents/welcome')) return json({});
            if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
            if (url.endsWith('/api/v1/chat/resume')) return resumeResponse();
            if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
                targetStarts++;
                return sse([]);
            }
            if (url.endsWith('/api/v1/chat/stream')) {
                return sse([{
                    type: 'question',
                    question: 'Switch assistants?',
                    choices: HANDOFF_CHOICES,
                    multi_select: false,
                    allow_free_text: false,
                }]);
            }
            throw new Error(`Unexpected request: ${url}`);
        };

        const { root } = mount(fetchImpl);
        await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
        const textarea = root.querySelector('textarea');
        textarea.value = 'Please help';
        root.querySelector('button.gv-button-primary').click();
        await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
        root.querySelector('.wap-reply__option').click();
        await waitFor(() => requests.some((request) => request.url.endsWith('/chat/resume')), 'resume request');
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(targetStarts, 0);
        assert.equal(root.querySelector('select').value, 'wp-rocket:standard');
    });
}

for (const [failureName, targetFailure] of [
    ['HTTP', () => json({
        detail: {
            error: 'handoff_mapping_changed',
            message: 'The selected assistant changed.',
        },
    }, 409)],
    ['SSE', () => sse([{
        type: 'error',
        code: 'handoff_mapping_changed',
        message: 'The selected assistant changed.',
    }])],
]) {
test(`target ${failureName} failure before message_start restores the exact source`, async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            return targetFailure();
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => requests.some((request) => request.body && request.body.handoff_token), 'target request');
    await waitFor(() => root.querySelector('select').value === 'wp-rocket:standard', 'source restore');

    assert.ok(find(root, 'li', 'The selected assistant changed.'));
    assert.ok(requests.some((request) => request.url.includes('/chat/history')
        && request.url.includes('agent_role=wp-rocket%3Astandard')));
});
}

test('target SSE failure after message_start remains on the target', async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            return sse([
                { type: 'message_start', agentName: 'WP Rocket Performance Analyst' },
                { type: 'error', code: 'stream_failed', message: 'Target failed after starting.' },
            ]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => requests.some((request) => request.body && request.body.handoff_token), 'target request');
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(root.querySelector('select').value, 'wp-rocket:performance');
    assert.ok(find(root, 'li', 'Target failed after starting.'));
    // Quota is polled after every turn regardless of role, so it's excluded here —
    // this assertion is about not restoring the source, i.e. no history/welcome
    // refetch for the source role.
    assert.equal(
        requests.filter((request) =>
            request.url.includes('agent_role=wp-rocket%3Astandard') && !request.url.includes('/chat/quota')
        ).length,
        0,
    );
});

test('manual selector change cancels a pending automatic continuation', async () => {
    const requests = [];
    let agentLoads = 0;
    let resolveRefresh;
    let targetStarts = 0;
    const refresh = new Promise((resolve) => { resolveRefresh = resolve; });
    const allAgents = agents.concat(otherAgent);
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) {
            agentLoads++;
            if (agentLoads === 2) return refresh;
            return json({ agents: allAgents, current: 'wp-rocket:standard' });
        }
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            targetStarts++;
            return sse([]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => agentLoads === 1, 'initial agents');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => agentLoads === 2, 'automatic refresh');

    const select = root.querySelector('select');
    select.value = otherAgent.role;
    select.dispatchEvent({ type: 'change' });
    await waitFor(() => select.value === otherAgent.role, 'manual switch');
    resolveRefresh(json({ agents: allAgents, current: 'wp-rocket:standard' }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(select.value, otherAgent.role);
    assert.equal(targetStarts, 0);
});

test('Stop cancels automatic continuation while the target list refresh is pending', async () => {
    const requests = [];
    let agentLoads = 0;
    let resolveRefresh;
    let targetStarts = 0;
    const refresh = new Promise((resolve) => { resolveRefresh = resolve; });
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) {
            agentLoads++;
            if (agentLoads === 2) return refresh;
            return json({ agents, current: 'wp-rocket:standard' });
        }
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            targetStarts++;
            return sse([]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => agentLoads === 1, 'initial agents');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => agentLoads === 2, 'automatic refresh');

    const stopButton = root.querySelector('button.gv-button-primary');
    assert.equal(stopButton.title, 'Stop');
    stopButton.click();
    resolveRefresh(json({ agents, current: 'wp-rocket:standard' }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(root.querySelector('select').value, 'wp-rocket:standard');
    assert.equal(targetStarts, 0);
});

test('Stop cancels source restoration while its agent refresh is pending', async () => {
    const requests = [];
    let agentLoads = 0;
    let resolveRestoreRefresh;
    const restoreRefresh = new Promise((resolve) => { resolveRestoreRefresh = resolve; });
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) {
            agentLoads++;
            if (agentLoads === 3) return restoreRefresh;
            return json({ agents, current: 'wp-rocket:standard' });
        }
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            return json({
                detail: { error: 'handoff_mapping_changed', message: 'Target failed.' },
            }, 409);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => agentLoads === 1, 'initial agents');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => agentLoads === 3, 'restore refresh');

    const stopButton = root.querySelector('button.gv-button-primary');
    assert.equal(stopButton.title, 'Stop');
    stopButton.click();
    resolveRestoreRefresh(json({ agents, current: 'wp-rocket:standard' }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(root.querySelector('select').value, 'wp-rocket:performance');
    // Quota is polled after every turn regardless of role, so it's excluded here —
    // this assertion is about the cancelled *restore*, i.e. no history/welcome
    // refetch for the source role.
    assert.equal(
        requests.filter((request) =>
            request.url.includes('agent_role=wp-rocket%3Astandard') && !request.url.includes('/chat/quota')
        ).length,
        0,
    );
});

test('Stop aborts an in-flight target stream without restoring the source', async () => {
    const requests = [];
    let targetStarted = false;
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'brief',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            targetStarted = true;
            return new Promise((resolve, reject) => {
                init.signal.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                });
            });
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => targetStarted, 'target request');

    root.querySelector('button.gv-button-primary').click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(root.querySelector('select').value, 'wp-rocket:performance');
});

test('a stale agent history response cannot overwrite a newer manual selection', async () => {
    const requests = [];
    let resolveTargetHistory;
    const targetHistory = new Promise((resolve) => { resolveTargetHistory = resolve; });
    const allAgents = agents.concat(otherAgent);
    const fetchImpl = async (url, init = {}) => {
        requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (url.includes('/source-thread/history')) return json({ messages: [] });
        if (url.includes('agent_role=wp-rocket%3Aperformance') && url.includes('/history')) {
            return targetHistory;
        }
        if (url.includes('agent_role=wp-rocket%3Aseo') && url.includes('/history')) {
            return json({ messages: [{ role: 'assistant', content: 'Current SEO history' }] });
        }
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) {
            return json({ agents: allAgents, current: 'wp-rocket:standard' });
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl);
    await waitFor(() => root.querySelector('select').options.length === 3, 'agent options');
    const select = root.querySelector('select');
    select.value = 'wp-rocket:performance';
    select.dispatchEvent({ type: 'change' });
    await waitFor(() => requests.some((request) => request.url.includes('agent_role=wp-rocket%3Aperformance')
        && request.url.includes('/history')), 'target history request');

    select.value = otherAgent.role;
    select.dispatchEvent({ type: 'change' });
    await waitFor(() => !!find(root, 'li', 'Current SEO history'), 'newer history');
    resolveTargetHistory(json({ messages: [{ role: 'assistant', content: 'Stale target history' }] }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(select.value, otherAgent.role);
    assert.equal(find(root, 'li', 'Stale target history'), undefined);
    assert.ok(find(root, 'li', 'Current SEO history'));
});

test('switching agents fires wap:agentchange with the new role', async () => {
    // An embedding page (e.g. the admin chat tester's Connection panel) has no
    // other way to learn the widget switched agents — it doesn't own the
    // in-widget selector and a handoff switches without any user interaction
    // on that selector at all.
    const requests = [];
    const allAgents = agents.concat(otherAgent);
    const fetchImpl = async (url, init = {}) => {
        requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents: allAgents, current: 'wp-rocket:standard' });
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root, window } = mount(fetchImpl);
    await waitFor(() => root.querySelector('select').options.length === 3, 'agent options');

    const events = [];
    window.addEventListener('wap:agentchange', (event) => events.push(event.detail));

    const select = root.querySelector('select');
    select.value = otherAgent.role;
    select.dispatchEvent({ type: 'change' });
    await waitFor(() => events.length === 1, 'agentchange event');

    assert.equal(events[0].role, otherAgent.role);
    assert.equal(events[0].displayName, otherAgent.displayName);
});

test('re-mounting for a different role does not reuse the previous role selection', async () => {
    // The admin tester's Connection panel reconnects by replacing WapClientConfig
    // and calling WapChat.init() again. The module is never reloaded, so anything
    // init() forgets to reset leaks the previous role into the new mount.
    const requests = [];
    let current = 'wp-rocket:standard';
    const fetchImpl = async (url) => {
        requests.push(String(url));
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current });
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root, window } = mount(fetchImpl, { conversationId: '' });
    await waitFor(() => root.querySelector('select').options.length === 2, 'agent options');
    assert.equal(root.querySelector('select').value, 'wp-rocket:standard');

    requests.length = 0;
    current = 'wp-rocket:performance';
    window.WapChat.init();
    await waitFor(() => requests.some((url) => url.includes('/history')), 're-mount history');

    const history = requests.find((url) => url.includes('/history'));
    assert.ok(!history.includes('agent_role='), `re-mount pinned the previous role: ${history}`);
    await waitFor(() => root.querySelector('select').options.length === 2, 're-mount agent options');
    assert.equal(root.querySelector('select').value, 'wp-rocket:performance');
});

// -----------------------------------------------------------------------------
// layout.showAgentSelector (WPIN-9050)
// -----------------------------------------------------------------------------

test('showAgentSelector:false hides the picker but keeps the default agent working', async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{ type: 'message_start' }, { type: 'message_end', usage: {} }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl, { layout: { showAgentSelector: false } });
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');

    // Not appended at all — an appended-but-hidden <select> is still a tab stop.
    assert.equal(root.querySelector('select'), null, 'no agent picker should be in the DOM');
    assert.equal(root.querySelectorAll('.wap-agent-select').length, 0);

    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => requests.some((request) => request.url.endsWith('/api/v1/chat/stream')), 'stream request');
    assert.ok(find(root, 'li', 'Please help'), 'the outgoing message should still render');

    // Hiding the picker must not strand the session without an agent_role.
    const stream = requests.find((request) => request.url.endsWith('/api/v1/chat/stream'));
    assert.equal(stream.body.agent_role, 'wp-rocket:standard');
});

test('showAgentSelector:false still completes a proactive handoff', async () => {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        if (url.endsWith('/api/v1/chat/resume')) {
            return sse([{
                type: 'agent_handoff',
                sourceRole: 'wp-rocket:standard',
                sourceAgentId: 'source-id',
                sourceAgent: 'WP Rocket Assistant',
                targetRole: 'wp-rocket:performance',
                targetAgentId: 'target-id',
                targetAgent: 'WP Rocket Performance Analyst',
                brief: 'Carried context',
                handoffToken: 'sealed-token',
            }]);
        }
        if (url.endsWith('/api/v1/chat/stream') && body && body.handoff_token) {
            return sse([
                { type: 'message_start', agentName: 'WP Rocket Performance Analyst' },
                { type: 'message_end', usage: {} },
            ]);
        }
        if (url.endsWith('/api/v1/chat/stream')) {
            return sse([{
                type: 'question',
                question: 'Switch assistants?',
                choices: HANDOFF_CHOICES,
                multi_select: false,
                allow_free_text: false,
            }]);
        }
        throw new Error(`Unexpected request: ${url}`);
    };

    const { root } = mount(fetchImpl, { layout: { showAgentSelector: false } });
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    assert.equal(root.querySelector('select'), null, 'no agent picker should be in the DOM');

    const textarea = root.querySelector('textarea');
    textarea.value = 'Please help';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(root, 'span', 'accept'), 'question choice');
    root.querySelector('.wap-reply__option').click();
    await waitFor(() => requests.some((request) => request.body && request.body.handoff_token), 'target request');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The picker's options must stay built even when never shown — switchAgent() resolves out of them.
    const target = requests.find((request) => request.body && request.body.handoff_token);
    assert.deepEqual(target.body, {
        handoff_token: 'sealed-token',
        agent_role: 'wp-rocket:performance',
    });
    assert.ok(find(root, 'li', 'Handoff from WP Rocket Assistant'));
    assert.ok(find(root, 'li', 'Carried context'));
});

for (const [name, layout] of [
    ['omitted', {}],
    ['explicitly true', { showAgentSelector: true }],
]) {
    test(`showAgentSelector ${name} renders the picker`, async () => {
        const requests = [];
        const fetchImpl = async (url) => {
            requests.push(String(url));
            if (url.includes('/history')) return json({ messages: [] });
            if (url.includes('/api/v1/agents/welcome')) return json({});
            if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
            if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
            throw new Error(`Unexpected request: ${url}`);
        };

        const { root } = mount(fetchImpl, { layout });
        await waitFor(() => root.querySelector('select') && root.querySelector('select').options.length === 2,
            'agent options');

        const wrap = root.querySelectorAll('.wap-agent-select')[0];
        assert.ok(wrap, 'picker wrapper should be mounted');
        assert.equal(wrap.hidden, false, 'picker should be revealed once agents arrive');
        assert.equal(root.querySelector('select').value, 'wp-rocket:standard');
    });
}

// These tests pin the sequenced fix: consent is always resolved before
// getSession() is ever called (previously these ran in parallel and could race).

test('consent already granted: getSession only runs after consent.get() resolves, session loads, no modal', async () => {
    const requests = [];
    const fetchImpl = async (url) => {
        requests.push(String(url));
        if (url.includes('/history')) return json({ messages: [{ role: 'user', content: 'hi' }] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        throw new Error(`Unexpected request: ${url}`);
    };

    let getSessionCalls = 0;
    const { root } = mount(fetchImpl, {
        getSession: () => {
            getSessionCalls++;
            return Promise.resolve({ token: 'token' });
        },
        consent: {
            get: () => new Promise((resolve) => setTimeout(() => resolve(true), 5)),
            set: () => Promise.resolve(),
        },
    });

    // getSession() must not race ahead of the still-pending consent.get().
    assert.equal(getSessionCalls, 0, 'getSession must wait for consent.get() to resolve');

    await waitFor(() => getSessionCalls > 0, 'getSession eventually called');
    await waitFor(() => requests.some((r) => r.includes('/history')), 'history request');
    await waitFor(() => find(root, 'li', 'hi'), 'history rendered');

    assert.equal(root.querySelector('.wap-consent-modal'), null, 'no consent modal for an already-consented user');
    assert.equal(root.querySelector('textarea').disabled, false, 'composer is unlocked');
});

test('consent refused, then granted via the modal: session loads once, modal never reopens', async () => {
    const requests = [];
    const fetchImpl = async (url) => {
        requests.push(String(url));
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        throw new Error(`Unexpected request: ${url}`);
    };

    let getSessionCalls = 0;
    const { root } = mount(fetchImpl, {
        getSession: () => {
            getSessionCalls++;
            return Promise.resolve({ token: 'token' });
        },
        consent: {
            get: () => Promise.resolve(false),
            set: () => Promise.resolve(true),
        },
    });

    await waitFor(() => !!root.querySelector('.wap-consent-modal'), 'consent modal shown');
    assert.equal(getSessionCalls, 0, 'getSession must not run before consent is granted');
    assert.equal(root.querySelector('.wap-loading'), null, 'initial spinner must clear even though the gate is up');

    find(root, 'button', 'Agree and continue').click();

    await waitFor(() => getSessionCalls > 0, 'getSession called after Agree');
    await waitFor(() => requests.some((r) => r.includes('/history')), 'history request after consent');
    await waitFor(() => root.querySelector('.wap-consent-modal') === null, 'modal closes');

    // Give any late/duplicate resolution a turn to (wrongly) reopen the gate.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(root.querySelector('.wap-consent-modal'), null, 'modal must not reopen after being accepted');
    assert.equal(root.querySelector('textarea').disabled, false, 'composer stays unlocked');
    assert.equal(getSessionCalls, 1, 'authenticate() only ran once');
});

// ── Consent access sentence: {link}…{/link} and {learnMore} ──────────────────

const SITE_ACCESS_URL = 'https://host.test/kb/site-access/';

// Open the consent modal with the given access sentence and return its message paragraph.
async function consentMessage(consentAccessText, siteAccessUrl) {
    const { root } = mount(async (url) => {
        throw new Error(`Unexpected request: ${url}`);
    }, {
        consent: { get: () => Promise.resolve(false), set: () => Promise.resolve(true) },
        init: { siteAccessUrl, i18n: { consentAccessText } },
    });
    await waitFor(() => !!root.querySelector('.wap-consent-modal'), 'consent modal shown');
    return root.querySelector('.wap-consent-modal').querySelector('p');
}

test('consent access sentence links the {link}-wrapped words inline', async () => {
    const msg = await consentMessage(
        'Uses a safe {link}WordPress Application Password{/link} you can remove at any time.',
        SITE_ACCESS_URL
    );

    const link = find(msg, 'a', 'WordPress Application Password');
    assert.equal(link.href, SITE_ACCESS_URL);
    assert.equal(link.target, '_blank');
    assert.match(msg.textContent, /Uses a safe WordPress Application Password you can remove at any time\.$/);
    assert.doesNotMatch(msg.textContent, /\{\/?link\}/, 'no raw placeholder is shown');
    // One <br> separates the access sentence from the T&C one; none splits the link.
    assert.equal(msg.querySelectorAll('br').length, 1);
});

test('consent access sentence keeps the {link}-wrapped words as text when site_access_url is unset', async () => {
    const msg = await consentMessage('Uses a safe {link}WordPress Application Password{/link}.', '');

    assert.equal([...msg.querySelectorAll('a')].some((a) => a.textContent === 'WordPress Application Password'), false);
    assert.match(msg.textContent, /Uses a safe WordPress Application Password\.$/);
});

test('consent access sentence still puts {learnMore} on a line of its own', async () => {
    const msg = await consentMessage('Uses a safe password. {learnMore}', SITE_ACCESS_URL);

    assert.equal(find(msg, 'a', 'Learn more').href, SITE_ACCESS_URL);
    assert.equal(msg.querySelectorAll('br').length, 2);
});

// ── OAuth consent card: the callback's code is redeemed under this session ────

const CALLBACK_ORIGIN = 'https://callback.test';

function consentQuestion() {
    return {
        type: 'question',
        question: 'To use GTmetrix, authorize access in the tab that opens.',
        choices: [
            { label: "I've connected", value: 'connected' },
            { label: 'Cancel', value: 'cancel' },
        ],
        multi_select: false,
        allow_free_text: false,
        presentation: {
            kind: 'mcp_oauth_consent',
            url: 'https://auth.gtmetrix.test/authorize?state=flow-1',
            serverLabel: 'GTmetrix',
            correlation: 'flow-1',
            callbackOrigin: CALLBACK_ORIGIN,
        },
    };
}

async function mountWithConsentCard(redeemResponse = () => new Response(null, { status: 204 })) {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body, headers: init.headers || {} });
        if (url.includes('/api/v1/chat/source-thread/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/mcp/oauth/redeem')) return redeemResponse();
        if (url.endsWith('/api/v1/chat/resume')) return sse([]);
        if (url.endsWith('/api/v1/chat/stream')) return sse([consentQuestion()]);
        throw new Error(`Unexpected request: ${url}`);
    };
    const mounted = mount(fetchImpl);
    await waitFor(() => requests.some((request) => request.url.includes('/chat/agents')), 'initial load');
    mounted.root.querySelector('textarea').value = 'Connect GTmetrix';
    mounted.root.querySelector('button.gv-button-primary').click();
    await waitFor(() => !!find(mounted.root, 'a', 'Authorize GTmetrix'), 'consent card');
    return Object.assign(mounted, { requests });
}

function postCallback(window, origin, data) {
    window.dispatchEvent({ type: 'message', origin, data });
}

test('consent card redeems the callback code under its own session, then answers connected', async () => {
    const { window, requests } = await mountWithConsentCard();

    postCallback(window, CALLBACK_ORIGIN, { type: 'wap:mcp-oauth-code', state: 'flow-1', code: 'the-code' });
    await waitFor(() => requests.some((request) => request.url.endsWith('/chat/resume')), 'resume after redeem');

    const redeem = requests.find((request) => request.url.endsWith('/api/v1/mcp/oauth/redeem'));
    assert.deepEqual(redeem.body, { state: 'flow-1', code: 'the-code' });
    assert.match(redeem.headers.Authorization, /^Bearer /);
    const resume = requests.find((request) => request.url.endsWith('/chat/resume'));
    assert.equal(resume.body.answer, 'connected');
});

test('consent card ignores a code posted from any other origin or for another flow', async () => {
    const { window, requests } = await mountWithConsentCard();

    postCallback(window, 'https://attacker.test', { type: 'wap:mcp-oauth-code', state: 'flow-1', code: 'x' });
    postCallback(window, CALLBACK_ORIGIN, { type: 'wap:mcp-oauth-code', state: 'other-flow', code: 'x' });
    postCallback(window, CALLBACK_ORIGIN, { type: 'wap:mcp-oauth-code', state: 'flow-1' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(requests.some((request) => request.url.endsWith('/mcp/oauth/redeem')), false);
    assert.equal(requests.some((request) => request.url.endsWith('/chat/resume')), false);
});

test('a refused redeem leaves the card unanswered and says so', async () => {
    const { window, root, requests } = await mountWithConsentCard(() => json({ detail: { error: 'forbidden' } }, 403));

    postCallback(window, CALLBACK_ORIGIN, { type: 'wap:mcp-oauth-code', state: 'flow-1', code: 'the-code' });
    await waitFor(() => !!find(root, 'div', 'could not be completed'), 'failure hint');

    assert.equal(requests.some((request) => request.url.endsWith('/chat/resume')), false);
    assert.ok(find(root, 'span', 'Cancel'), 'the card is still answerable');
});

test('a consent card restored after a reload still redeems the popup code, without opening a window', async () => {
    const requests = [];
    let opened = 0;
    const fetchImpl = async (url, init = {}) => {
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, body });
        if (url.includes('/api/v1/chat/source-thread/history')) {
            const { type, ...pending } = consentQuestion();
            return json({ messages: [], pendingQuestion: pending });
        }
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/api/v1/mcp/oauth/redeem')) return new Response(null, { status: 204 });
        if (url.endsWith('/api/v1/chat/resume')) return sse([]);
        throw new Error(`Unexpected request: ${url}`);
    };
    const { window, root } = mount(fetchImpl);
    window.open = () => { opened += 1; return null; };
    await waitFor(() => !!find(root, 'a', 'Authorize GTmetrix'), 'restored consent card');

    postCallback(window, CALLBACK_ORIGIN, { type: 'wap:mcp-oauth-code', state: 'flow-1', code: 'the-code' });
    await waitFor(() => requests.some((request) => request.url.endsWith('/chat/resume')), 'resume after redeem');

    assert.equal(opened, 0);
});

test('a duplicate callback message after success does not redeem twice', async () => {
    const { window, requests } = await mountWithConsentCard();
    const message = { type: 'wap:mcp-oauth-code', state: 'flow-1', code: 'the-code' };

    postCallback(window, CALLBACK_ORIGIN, message);
    await waitFor(() => requests.some((request) => request.url.endsWith('/chat/resume')), 'first resume');
    postCallback(window, CALLBACK_ORIGIN, message);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(requests.filter((request) => request.url.endsWith('/mcp/oauth/redeem')).length, 1);
});

// ── New chat ─────────────────────────────────────────────────────────────────

/**
 * Mount on a conversation with one earlier message, click New chat and confirm.
 * `newChatReply` answers POST /chat/new; `log` records requests and getSession
 * calls in the order they happen.
 */
async function startNewChatOnConversation(newChatReply) {
    const log = [];
    const fetchImpl = async (url, init = {}) => {
        log.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
        if (url.endsWith('/api/v1/chat/new')) return newChatReply();
        if (url.includes('/source-thread/history')) {
            return json({ messages: [{ role: 'user', content: 'Earlier question' }] });
        }
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        throw new Error(`Unexpected request: ${url}`);
    };
    const harness = mount(fetchImpl, {
        layout: { showHeader: true, showNewChat: true },
        getSession: (forceNew) => {
            log.push({ getSession: forceNew });
            return Promise.resolve({ token: forceNew ? 'fresh-token' : 'token' });
        },
    });
    const { root } = harness;
    await waitFor(() => !!find(root, 'li', 'Earlier question'), 'earlier conversation');

    root.querySelectorAll('button').find((node) => node.getAttribute('aria-label') === 'New chat').click();
    await waitFor(() => !!root.querySelector('.wap-confirm'), 'new chat confirmation');
    find(root.querySelector('.wap-confirm'), 'button', 'New chat').click();
    return Object.assign(harness, { log });
}

test('new chat deletes the thread on WAP before re-minting the session', async () => {
    const { root, log } = await startNewChatOnConversation(() => new Response(null, { status: 204 }));
    await waitFor(() => log.some((entry) => entry.getSession === true), 'force_new session');
    await waitFor(() => !find(root, 'li', 'Earlier question'), 'conversation cleared');

    const newChatAt = log.findIndex((entry) => entry.url && entry.url.endsWith('/api/v1/chat/new'));
    const forceNewAt = log.findIndex((entry) => entry.getSession === true);
    assert.ok(newChatAt > -1, 'POST /chat/new is sent');
    assert.ok(newChatAt < forceNewAt, 'the thread is deleted before the new session is minted');
    assert.equal(log[newChatAt].method, 'POST');
    assert.equal(log[newChatAt].headers.Authorization, 'Bearer token');
    assert.deepEqual(log[newChatAt].body, { agent_role: 'wp-rocket:standard' });
});

test('a failed new chat keeps the conversation and says so', async () => {
    const { root, log } = await startNewChatOnConversation(() => json({ detail: 'boom' }, 500));
    await waitFor(() => !!find(root, 'li', 'Couldn’t start a new chat'), 'new chat error');

    assert.ok(find(root, 'li', 'Earlier question'), 'the earlier conversation stays on screen');
    assert.equal(log.filter((entry) => entry.getSession === true).length, 0, 'no fresh session is minted');
});

test('the composer cannot send while the thread is being deleted', async () => {
    let finishNewChat;
    const { root, log } = await startNewChatOnConversation(() => new Promise((resolve) => { finishNewChat = resolve; }));
    await waitFor(() => !!finishNewChat, 'POST /chat/new in flight');

    const textarea = root.querySelector('textarea');
    assert.equal(textarea.disabled, true, 'the composer is locked');
    textarea.value = 'Sent too early';
    root.querySelector('button.gv-button-primary').click();
    assert.equal(log.filter((entry) => entry.url && entry.url.endsWith('/api/v1/chat/stream')).length, 0, 'nothing is streamed');
    assert.equal(find(root, 'li', 'Sent too early'), undefined);

    finishNewChat(new Response(null, { status: 204 }));
    await waitFor(() => !find(root, 'li', 'Earlier question'), 'conversation cleared');
    await waitFor(() => !root.querySelector('textarea').disabled, 'composer unlocked');
});

test('a failed new chat unlocks the composer', async () => {
    const { root } = await startNewChatOnConversation(() => json({ detail: 'boom' }, 500));
    await waitFor(() => !!find(root, 'li', 'Couldn’t start a new chat'), 'new chat error');

    assert.equal(root.querySelector('textarea').disabled, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Visual answers
//
// These mount the real widget and feed it the SSE the backend emits, so they
// pin the whole client contract: the event is rendered, the figure is drawn
// from data (never from markup the model wrote), free HTML is isolated, and a
// reload puts the figure back.
// ─────────────────────────────────────────────────────────────────────────────

const LINE_VISUAL = {
    kind: 'line_chart',
    title: 'Performance score over time',
    caption: 'Measured monthly with Lighthouse.',
    categories: ['Jun', 'Jul', 'Aug'],
    series: [{ name: 'Score', points: [71, 78, 86] }],
};

function visualFetch(events, history = []) {
    return async (url) => {
        if (url.includes('/history')) return json({ messages: history });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.endsWith('/chat/stream')) return sse(events);
        throw new Error(`Unexpected request: ${url}`);
    };
}

/** Ask a question and wait for the figure the streamed answer draws. */
async function streamVisual(events) {
    const { root } = mount(visualFetch(events));
    await waitFor(() => !!root.querySelector('button.gv-button-primary'), 'composer');
    root.querySelector('textarea').value = 'how has the score changed?';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => root.querySelectorAll('.wap-visual').length > 0, 'no visual rendered');
    return root;
}

/** Reload a thread whose history already holds a figure. */
async function replayVisual(visual, options) {
    const { root } = mount(visualFetch([], [{ role: 'visual', visual }]), options);
    await waitFor(() => root.querySelectorAll('.wap-visual').length > 0, 'no visual rendered');
    return root;
}

test('a visual event renders a titled card with its caption and a download action', async () => {
    const root = await streamVisual([
        { type: 'message_start' },
        { type: 'visual', visual: LINE_VISUAL },
        { type: 'text_delta', delta: 'The score rose 15 points.' },
        { type: 'message_end' },
    ]);

    const card = root.querySelectorAll('.wap-visual')[0];
    assert.ok(find(card, 'figcaption', 'Performance score over time'), 'title missing');
    assert.ok(find(card, 'p', 'Measured monthly with Lighthouse.'), 'caption missing');
    assert.ok(find(card, 'button', 'Download image'), 'download action missing');
    // A figure gets pasted into reports; it has to say where it came from.
    assert.ok(find(card, 'span', 'Generated by AI'), 'AI attribution missing');
    // The figure is one child of the assistant turn, not a turn of its own, so
    // the model's prose sits above and below it in the same bubble. That the
    // prose itself renders is not asserted here: streamed markdown goes through
    // innerHTML, which this fake DOM does not parse (no existing test asserts
    // streamed text either). VIS-M1 in docs/visual-capabilities.md covers it.
    assert.ok(card.parentNode.classList.contains('gv-chat-message-body'));
});

test('a chart is drawn as SVG from the data, with one point per category', async () => {
    const root = await streamVisual([
        { type: 'message_start' },
        { type: 'visual', visual: LINE_VISUAL },
        { type: 'message_end' },
    ]);

    const card = root.querySelectorAll('.wap-visual')[0];
    const svg = card.querySelectorAll('svg')[0];
    assert.ok(svg, 'no svg drawn');
    // role="img" needs a name, or the chart is announced as an unlabelled
    // image and the marks — the whole answer — reach no screen reader.
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(
        svg.getAttribute('aria-label'),
        'Performance score over time — Measured monthly with Lighthouse.'
    );
    // Three categories → three plotted dots, joined by one polyline.
    assert.equal(card.querySelectorAll('circle').length, 3);
    assert.equal(card.querySelectorAll('polyline').length, 1);
    // A data-shaped kind never routes through the HTML path.
    assert.equal(card.querySelectorAll('iframe').length, 0);
});

test('free-form HTML renders in a sandboxed frame that cannot reach the page', async () => {
    const root = await streamVisual([
        { type: 'message_start' },
        { type: 'visual', visual: { kind: 'html', title: 'Portfolio', html: '<div class="kpi">86</div>' } },
        { type: 'message_end' },
    ]);

    const frame = root.querySelectorAll('iframe')[0];
    assert.ok(frame, 'no frame rendered');
    // allow-scripts WITHOUT allow-same-origin: the frame gets an opaque origin,
    // so it cannot touch this document, wp-admin's cookies, or its nonces.
    // Granting both together would undo the sandbox entirely.
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');

    const srcdoc = frame.getAttribute('srcdoc');
    assert.ok(srcdoc.includes('<div class="kpi">86</div>'), 'model markup missing from the frame');
    // No network egress from inside the frame, whatever the markup asks for.
    assert.ok(srcdoc.includes("default-src 'none'"), 'CSP missing');
    assert.ok(srcdoc.includes("form-action 'none'"), 'form-action missing');
    // Scripts run only under the widget's own per-frame nonce, so markup that
    // slipped a <script> past the backend still could not execute.
    const nonce = /script-src 'nonce-([0-9a-f]+)'/.exec(srcdoc);
    assert.ok(nonce, 'no script nonce in the CSP');
    assert.ok(srcdoc.includes('<script nonce="' + nonce[1] + '">'), 'reporter not bound to the nonce');
    // The markup never lands in this document's DOM.
    assert.equal(root.querySelectorAll('.kpi').length, 0);
    // An .html download is offered alongside the image for this kind.
    assert.ok(find(root.querySelectorAll('.wap-visual')[0], 'button', 'Download HTML'), 'html download missing');
});

test('an unknown visual kind says a figure is missing instead of dropping it', async () => {
    const root = await streamVisual([
        { type: 'message_start' },
        { type: 'visual', visual: { kind: 'sankey_from_the_future', title: 'Flow' } },
        { type: 'message_end' },
    ]);

    const card = root.querySelectorAll('.wap-visual')[0];
    assert.ok(find(card, 'p', 'needs a newer version'), 'no forward-compatibility notice');
    assert.ok(find(card, 'figcaption', 'Flow'), 'title should still render');
});

// ── Inline media in replies (docs/visual-capabilities.md → Media) ───────────

const DOC_GIF = 'https://d33v4339jhl8k0.cloudfront.net/docs/assets/x/images/y/file-IaTEqTQ7KN.gif';

/** The HTML of one reloaded assistant reply carrying the backend's approval. */
async function replyHtml(content, media) {
    const { root } = mount(visualFetch([], [{ role: 'assistant', content, media }]));
    const body = () => root.querySelectorAll('.gv-chat-message-body').find((node) => node.innerHTML);
    await waitFor(() => !!body(), 'reply not rendered');
    return body().innerHTML;
}

test('an approved image in a reply renders inline, linking to the original, with no referrer', async () => {
    const html = await replyHtml(`Tick the box:\n\n![clicking one click exclusions boxes](${DOC_GIF})`, { images: [DOC_GIF] });

    assert.ok(html.includes(
        `<a class="wap-inline-media wap-media-image" href="${DOC_GIF}" target="_blank" rel="noopener noreferrer">`
        + `<img src="${DOC_GIF}" alt="clicking one click exclusions boxes" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    ), html);
});

test('an image the backend did not approve is a plain link, without a stray "!"', async () => {
    const html = await replyHtml('![tracking pixel](https://evil.example/p.gif?d=secret)', { images: [DOC_GIF] });

    assert.ok(!html.includes('<img'), 'an unapproved image must not load');
    assert.ok(!html.includes('!<a'), 'no stray "!"');
    assert.ok(html.includes('>tracking pixel</a>'), html);
});

test('without any approval, a reply loads no media at all', async () => {
    const html = await replyHtml(`![a](${DOC_GIF}) and https://youtu.be/dQw4w9WgXcQ`, undefined);

    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('wap-media-video'), html);
});

test('alt text is never turned into markup inside the image attributes', async () => {
    const html = await replyHtml(`![the *Safe Mode* toggle](${DOC_GIF})`, { images: [DOC_GIF] });

    assert.ok(html.includes('alt="the *Safe Mode* toggle"'), html);
});

test('an approved YouTube link becomes a thumbnail card built from the id alone', async () => {
    const html = await replyHtml(
        'Watch: [Delay JS walkthrough](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s)',
        { videos: ['dQw4w9WgXcQ'] }
    );

    assert.ok(html.includes('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"'), 'link rebuilt from the id, query dropped');
    assert.ok(html.includes('<img src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"'), html);
    assert.ok(html.includes('<span class="wap-media-label">Delay JS walkthrough</span>'), html);
    assert.ok(!html.includes('<iframe'), 'link-out only');
});

/** The opening tag of each video card in `html`. */
function videoCardTags(html) {
    return html.match(/<a class="wap-inline-media wap-media-video"[^>]*>/g) || [];
}

test('a link label never reaches a video card attribute (linked unapproved image)', async () => {
    // The unapproved image renders first as a raw <a href="…">, with real
    // quotes. Inside an attribute those quotes would end it, and the rest of
    // the image URL would become attributes of the card: here, a live
    // onmouseover handler. "information" passes as an approved id on purpose.
    const html = await replyHtml(
        '[![x](https://h/onmouseover=location=/javascript:alert%281%29/.source//)](https://www.youtube.com/watch?v=information)',
        { videos: ['information'] }
    );

    const tags = videoCardTags(html);
    assert.equal(tags.length, 1, html);
    assert.equal(tags[0], '<a class="wap-inline-media wap-media-video" href="https://www.youtube.com/watch?v=information" target="_blank" rel="noopener noreferrer">');
    assert.ok(!/\son\w+=/i.test(tags[0]), 'no event handler on the card');
    assert.ok(html.includes('<span class="wap-media-label">x</span>'), 'only the alt text is kept as the label');
});

test('a linked approved thumbnail becomes one clean card, with no stray placeholder', async () => {
    const html = await replyHtml(
        `[![](${DOC_GIF})](https://youtu.be/dQw4w9WgXcQ)`,
        { images: [DOC_GIF], videos: ['dQw4w9WgXcQ'] }
    );

    assert.equal(videoCardTags(html).length, 1, html);
    assert.ok(html.includes('<span class="wap-media-label">Watch on YouTube</span>'), html);
    assert.ok(!html.includes(DOC_GIF), 'the docs image is dropped in favour of the video thumbnail');
});

test('a bare approved YouTube URL becomes a card; an unapproved one stays a link', async () => {
    const html = await replyHtml(
        'Approved:\nhttps://youtu.be/dQw4w9WgXcQ\n\nNot approved: [other](https://youtu.be/aaaaaaaaaaa)',
        { videos: ['dQw4w9WgXcQ'] }
    );

    assert.equal(html.split('wap-media-video').length - 1, 1, html);
    assert.ok(html.includes('<a href="https://youtu.be/aaaaaaaaaaa" target="_blank" rel="noopener noreferrer">other</a>'), html);
});

test('an approval that is not https or not a YouTube id is ignored', async () => {
    const html = await replyHtml(
        '![a](http://example.com/a.png) [v](https://youtu.be/dQw4w9WgXcQ)',
        { images: ['http://example.com/a.png'], videos: ['../evil?x=1'] }
    );

    assert.ok(!html.includes('<img'), html);
});

test('a media event after a streamed reply is applied without breaking the turn', async () => {
    // The fake DOM does not parse streamed markup (see the visual tests), so
    // this checks the event is consumed cleanly; the HTML it produces is the
    // renderMarkdown path the reload tests above assert.
    const { root } = mount(visualFetch([
        { type: 'message_start' },
        { type: 'text_delta', delta: `![a](${DOC_GIF})` },
        { type: 'media', media: { images: [DOC_GIF] } },
        { type: 'message_end' },
    ]));
    await waitFor(() => !!root.querySelector('button.gv-button-primary'), 'composer');
    root.querySelector('textarea').value = 'how do I use one-click exclusions?';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => root.querySelectorAll('.wap-chat-message-text').length > 0, 'reply not streamed');
    assert.equal(root.querySelectorAll('.gv-notice-error').length, 0);
});

test('a visual in the loaded history is redrawn on reload', async () => {
    // What the user downloaded yesterday has to still be there today.
    const { root } = mount(visualFetch([], [
        { role: 'user', content: 'how has the score changed?' },
        { role: 'assistant', content: 'The score rose 15 points.' },
        { role: 'visual', visual: LINE_VISUAL },
    ]));
    await waitFor(() => root.querySelectorAll('.wap-visual').length > 0, 'history visual not redrawn');
    const card = root.querySelectorAll('.wap-visual')[0];
    assert.ok(find(card, 'figcaption', 'Performance score over time'));
    assert.equal(card.querySelectorAll('circle').length, 3);
});

test('a bar chart draws one bar per series per category', async () => {
    const root = await replayVisual({
        kind: 'bar_chart',
        title: 'Scores across the portfolio',
        categories: ['example.com', 'shop.example'],
        series: [
            { name: 'Jul', points: [71, 64] },
            { name: 'Aug', points: [86, 70] },
        ],
    });
    const card = root.querySelectorAll('.wap-visual')[0];
    // 2 categories × 2 series = 4 bars, plus the chart's backdrop rect and the
    // legend swatch per series.
    assert.equal(card.querySelectorAll('rect').length, 4 + 1 + 2);
});

test('a null point breaks the line instead of plotting a zero', async () => {
    const root = await replayVisual({
        kind: 'line_chart',
        title: 'Score with a gap',
        categories: ['Jun', 'Jul', 'Aug'],
        series: [{ name: 'Score', points: [71, null, 86] }],
    });
    const card = root.querySelectorAll('.wap-visual')[0];
    // Two measured points, so two dots — and no polyline, because a single
    // point either side of the gap has nothing to join to.
    assert.equal(card.querySelectorAll('circle').length, 2);
    assert.equal(card.querySelectorAll('polyline').length, 0);
});

test('a stat row draws a tile per stat', async () => {
    const root = await replayVisual({
        kind: 'stat_row',
        title: 'Portfolio at a glance',
        stats: [
            { label: 'Sites', value: '12' },
            { label: 'Average score', value: '81', delta: '+4', state: 'good' },
            { label: 'Needs attention', value: '3', delta: '+1', state: 'bad' },
        ],
    });
    const card = root.querySelectorAll('.wap-visual')[0];
    // Three tiles plus the backdrop rect.
    assert.equal(card.querySelectorAll('rect').length, 4);
    assert.ok(find(card, 'text', 'Average score'), 'label missing');
    assert.ok(find(card, 'text', '81'), 'value missing');
});

test('a requested series colour replaces the palette on the line, its dots and the legend', async () => {
    const root = await replayVisual({
        kind: 'line_chart',
        title: 'Coloured',
        categories: ['Jun', 'Jul'],
        series: [
            { name: 'Asked for', points: [1, 2], color: '#F97316' },
            { name: 'Default', points: [2, 3] },
        ],
    });
    const card = root.querySelectorAll('.wap-visual')[0];
    const lines = card.querySelectorAll('polyline');
    assert.equal(lines[0].getAttribute('stroke'), '#F97316');
    assert.equal(card.querySelectorAll('circle')[0].getAttribute('fill'), '#F97316');
    // The series without a colour keeps its palette slot (chart-200).
    assert.equal(lines[1].getAttribute('stroke'), '#fec600');
    const swatches = card.querySelectorAll('rect').filter((r) => r.getAttribute('width') === '9');
    assert.deepEqual(swatches.map((r) => r.getAttribute('fill')), ['#F97316', '#fec600']);
});

test('a requested series colour fills the bars, and an invalid one falls back to the palette', async () => {
    const coloured = await replayVisual({
        kind: 'bar_chart', title: 'Bars', categories: ['A', 'B'],
        series: [{ name: 'Spend', points: [51, 20], color: '#F97316' }],
    });
    const bars = coloured.querySelectorAll('rect').filter((r) => r.getAttribute('rx') === '2');
    assert.deepEqual(bars.map((r) => r.getAttribute('fill')), ['#F97316', '#F97316']);

    const invalid = await replayVisual({
        kind: 'line_chart', title: 'Bad colour', categories: ['A', 'B'],
        series: [{ name: 'S', points: [1, 2], color: 'url(#x)' }],
    });
    assert.equal(invalid.querySelectorAll('polyline')[0].getAttribute('stroke'), '#0066aa');
});

test('a bubble holding a figure is marked full width, live and after a reload', async () => {
    const live = await streamVisual([
        { type: 'message_start' },
        { type: 'visual', visual: LINE_VISUAL },
        { type: 'message_end' },
    ]);
    assert.ok(live.querySelectorAll('.wap-visual')[0].parentNode.classList.contains('wap-visual-host'));

    const { root } = mount(visualFetch([], [
        { role: 'assistant', content: 'Here you go.' },
        { role: 'visual', visual: LINE_VISUAL },
    ]));
    await waitFor(() => root.querySelectorAll('.wap-visual').length > 0, 'no visual rendered');
    const bodies = root.querySelectorAll('.gv-chat-message-body');
    const hosts = bodies.filter((b) => b.classList.contains('wap-visual-host'));
    // Only the figure's bubble: a text bubble keeps hugging its text.
    assert.equal(hosts.length, 1);
    assert.ok(hosts[0].querySelectorAll('.wap-visual').length === 1);
});

test('on a nonce-CSP host the frame reporter carries the host nonce, routed by its own id', async () => {
    const root = await replayVisual(
        { kind: 'html', title: 'Dashboard', html: '<div>86</div>' },
        { hostNonce: 'pPnOnce123' }
    );
    const srcdoc = root.querySelectorAll('iframe')[0].getAttribute('srcdoc');
    // A srcdoc frame inherits the host's CSP, which only runs scripts with its
    // nonce — so the frame's own policy and the reporter must both use it.
    assert.ok(srcdoc.includes("script-src 'nonce-pPnOnce123'"), 'frame CSP not on the host nonce');
    assert.ok(srcdoc.includes('<script nonce="pPnOnce123">'), 'reporter not on the host nonce');
    // Height messages are still matched by a per-frame random id, not the
    // shared host nonce, so two frames on one page cannot resize each other.
    const id = /wapVisualNonce:"([^"]+)"/.exec(srcdoc)[1];
    assert.match(id, /^[0-9a-f]{32}$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Documents (render_document) — an invoice or report the assistant generated.
// The preview is backend-rendered HTML in the same sealed frame as a free-HTML
// visual; the PDF is fetched from the path the backend stamped (pdfPath) with
// the bearer token — never built client-side, never a token in a URL.
// See docs/document-generation.md, DOC-A11.
// ─────────────────────────────────────────────────────────────────────────────

const INVOICE_DOCUMENT = {
    id: 'toolu_invoice_1',
    title: 'Invoice INV-2026-014',
    summary: 'Total EUR 267.40',
    filename: 'invoice-inv-2026-014.pdf',
    pdfPath: '/api/v1/chat/user-1%3Apartners-one%3Astandard/documents/toolu_invoice_1/pdf',
    html: '<style>.wd{color:#1f2937}</style><div class="wd"><h1>Invoice INV-2026-014</h1></div>',
};

/**
 * A fetch double for the document tests: history/stream as for visuals, plus
 * the PDF route. Every request is recorded so a test can assert how the PDF
 * was asked for.
 */
function documentFetch({ events = [], history = [], pdf = () => new Response('%PDF-1.7', { status: 200 }) } = {}) {
    const requests = [];
    const impl = async (url, init = {}) => {
        requests.push({ url, init });
        if (url.includes('/pdf')) return pdf(url, init);
        return visualFetch(events, history)(url);
    };
    return { impl, requests };
}

/** URL.createObjectURL stand-in that records what the widget saved. */
function blobRecorder() {
    const saved = [];
    return {
        saved,
        URL: {
            createObjectURL(blob) { saved.push(blob); return 'blob:test/' + saved.length; },
            revokeObjectURL() {},
        },
    };
}

async function streamDocument(events, options = {}) {
    const fetcher = documentFetch({ events });
    const recorder = blobRecorder();
    const { root, document } = mount(fetcher.impl, Object.assign({ context: { URL: recorder.URL } }, options));
    await waitFor(() => !!root.querySelector('button.gv-button-primary'), 'composer');
    root.querySelector('textarea').value = 'make an invoice for Acme';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => root.querySelectorAll('.wap-document').length > 0, 'no document rendered');
    return { root, document, requests: fetcher.requests, saved: recorder.saved };
}

test('a document event renders a card with its summary, a sealed preview and Download PDF', async () => {
    const { root } = await streamDocument([
        { type: 'message_start' },
        { type: 'document', document: INVOICE_DOCUMENT },
        { type: 'message_end' },
    ]);

    const card = root.querySelectorAll('.wap-document')[0];
    assert.ok(find(card, 'figcaption', 'Invoice'), 'title missing');
    assert.ok(find(card, 'p', 'Total EUR 267.40'), 'summary missing');
    assert.ok(find(card, 'button', 'Download PDF'), 'download action missing');
    assert.ok(find(card, 'span', 'Generated by AI'), 'AI attribution missing');

    // Same containment as a free-HTML visual: opaque origin, no network.
    const frame = card.querySelectorAll('iframe')[0];
    assert.ok(frame, 'no preview frame');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
    const srcdoc = frame.getAttribute('srcdoc');
    assert.ok(srcdoc.includes('<h1>Invoice INV-2026-014</h1>'), 'document html missing from the frame');
    assert.ok(srcdoc.includes("default-src 'none'"), 'CSP missing');
    // The document's markup never lands in this page's DOM.
    assert.equal(root.querySelectorAll('.wd').length, 0);
});

test('Download PDF fetches the stamped path with the bearer token and saves the blob', async () => {
    const { root, document, requests, saved } = await streamDocument([
        { type: 'message_start' },
        { type: 'document', document: INVOICE_DOCUMENT },
        { type: 'message_end' },
    ]);

    find(root.querySelectorAll('.wap-document')[0], 'button', 'Download PDF').click();
    await waitFor(() => saved.length === 1, 'pdf was not saved');

    const pdfRequest = requests.find((request) => request.url.includes('/pdf'));
    assert.equal(
        pdfRequest.url,
        'https://wap.test/api/v1/chat/user-1%3Apartners-one%3Astandard/documents/toolu_invoice_1/pdf'
    );
    // Bearer header, exactly like /history — the token never goes into a URL.
    assert.equal(pdfRequest.init.headers.Authorization, 'Bearer token');
    assert.ok(!pdfRequest.url.includes('token'));
    const link = document.body.querySelectorAll('a').find((node) => node.download);
    assert.equal(link.download, 'invoice-inv-2026-014.pdf');
});

test('a failed PDF download says so and leaves the button usable', async () => {
    const fetcher = documentFetch({
        events: [
            { type: 'message_start' },
            { type: 'document', document: INVOICE_DOCUMENT },
            { type: 'message_end' },
        ],
        pdf: () => new Response('{"detail":"gone"}', { status: 404 }),
    });
    const recorder = blobRecorder();
    const { root } = mount(fetcher.impl, { context: { URL: recorder.URL } });
    await waitFor(() => !!root.querySelector('button.gv-button-primary'), 'composer');
    root.querySelector('textarea').value = 'make an invoice';
    root.querySelector('button.gv-button-primary').click();
    await waitFor(() => root.querySelectorAll('.wap-document').length > 0, 'no document rendered');

    const card = root.querySelectorAll('.wap-document')[0];
    const button = find(card, 'button', 'Download PDF');
    const error = card.querySelectorAll('.wap-document-error')[0];
    assert.equal(error.hidden, true, 'error shown before any attempt');
    button.click();
    await waitFor(() => error.hidden === false, 'failure not reported');
    await waitFor(() => button.disabled === false, 'button left disabled');
    assert.equal(recorder.saved.length, 0);
});

test('a document in the loaded history is redrawn and downloads from the path it carries', async () => {
    // A host whose getSession returns only a token has no conversationId; the
    // card does not need one — the server already stamped the real thread.
    const fetcher = documentFetch({ history: [{ role: 'document', document: INVOICE_DOCUMENT }] });
    const recorder = blobRecorder();
    const { root } = mount(fetcher.impl, { init: { conversationId: '' }, context: { URL: recorder.URL } });
    await waitFor(() => root.querySelectorAll('.wap-document').length > 0, 'history document not redrawn');

    find(root.querySelectorAll('.wap-document')[0], 'button', 'Download PDF').click();
    await waitFor(() => recorder.saved.length === 1, 'pdf was not saved');
    const pdfRequest = fetcher.requests.find((request) => request.url.includes('/pdf'));
    assert.equal(pdfRequest.url, 'https://wap.test' + INVOICE_DOCUMENT.pdfPath);
});

test('a document without a usable download path previews but offers no download', async () => {
    const history = [
        { role: 'document', document: { ...INVOICE_DOCUMENT, pdfPath: undefined } },
        { role: 'document', document: { ...INVOICE_DOCUMENT, pdfPath: '//evil.test/x.pdf' } },
    ];
    const { root } = mount(documentFetch({ history }).impl);
    await waitFor(() => root.querySelectorAll('.wap-document').length === 2, 'documents not drawn');
    for (const card of root.querySelectorAll('.wap-document')) {
        assert.ok(card.querySelectorAll('iframe')[0], 'preview missing');
        assert.equal(find(card, 'button', 'Download PDF'), undefined);
    }
});

// ── Column lazy start (column.startOnOpen) ───────────────────────────────────

// Counts every network touch so a test can prove a collapsed lazy column is silent.
function lazyColumnHarness(extra = {}) {
    const state = { requests: [], getSessionCalls: 0, consentCalls: 0 };
    const fetchImpl = async (url) => {
        state.requests.push(String(url));
        if (url.includes('/history')) return json({ messages: [] });
        if (url.includes('/api/v1/agents/welcome')) return json({});
        if (url.includes('/api/v1/chat/agents')) return json({ agents, current: 'wp-rocket:standard' });
        if (url.includes('/api/v1/chat/quota')) return json({ enabled: false });
        throw new Error(`Unexpected request: ${url}`);
    };
    const options = {
        getSession: () => {
            state.getSessionCalls++;
            return state.getSessionDeferred
                ? state.getSessionDeferred.promise
                : Promise.resolve({ token: 'token' });
        },
        ...extra,
    };
    return { state, fetchImpl, options };
}

const lazySettle = () => new Promise((resolve) => setTimeout(resolve, 15));

test('startOnOpen: a collapsed column makes no session, consent or network request; unset still boots', async () => {
    const lazy = lazyColumnHarness({
        column: { startOnOpen: true },
        consent: { get: () => { lazy.state.consentCalls++; return Promise.resolve(true); }, set: () => Promise.resolve() },
    });
    const { column } = mount(lazy.fetchImpl, lazy.options);
    await lazySettle();

    assert.equal(column.isCollapsed(), true);
    assert.equal(lazy.state.getSessionCalls, 0, 'no getSession while collapsed');
    assert.equal(lazy.state.consentCalls, 0, 'no consent check while collapsed');
    assert.deepEqual(lazy.state.requests, [], 'no fetch while collapsed');

    const plain = lazyColumnHarness({ column: {} });
    mount(plain.fetchImpl, plain.options);
    await waitFor(() => plain.state.getSessionCalls === 1, 'a column without startOnOpen boots on mount');
});

test('startOnOpen: expand() starts the session once; repeats and a collapse/expand cycle add no call', async () => {
    const lazy = lazyColumnHarness({ column: { startOnOpen: true } });
    const { column } = mount(lazy.fetchImpl, lazy.options);
    await lazySettle();

    column.expand();
    await waitFor(() => lazy.state.requests.some((r) => r.includes('/history')), 'history loaded after the first open');
    column.expand();
    column.collapse();
    column.expand();
    await lazySettle();

    assert.equal(lazy.state.getSessionCalls, 1, 'one getSession for the whole open/close history');
});

test('startOnOpen: two quick expands while getSession is pending make one call', async () => {
    const lazy = lazyColumnHarness({ column: { startOnOpen: true } });
    let release;
    lazy.state.getSessionDeferred = { promise: new Promise((resolve) => { release = resolve; }) };
    const { column } = mount(lazy.fetchImpl, lazy.options);
    await lazySettle();

    column.expand();
    column.expand();
    column.collapse();
    column.expand();
    await lazySettle();
    assert.equal(lazy.state.getSessionCalls, 1, 'pending session is not started again');

    release({ token: 'token' });
    await lazySettle();
    assert.equal(lazy.state.getSessionCalls, 1);
});

test('startOnOpen: a breakpoint flip re-applies the current state and never boots a collapsed column', async () => {
    const lazy = lazyColumnHarness({ column: { startOnOpen: true } });
    const listeners = [];
    const query = { matches: false, addEventListener: (type, fn) => listeners.push(fn), removeEventListener() {} };
    const flip = (matches) => { query.matches = matches; listeners.forEach((fn) => fn()); };
    const { column, document } = mount(lazy.fetchImpl, { ...lazy.options, matchMedia: (q) => (q.includes('max-width') ? query : { matches: false }) });
    await lazySettle();
    assert.equal(listeners.length, 1, 'the breakpoint listener is bound');

    flip(true);
    flip(false);
    await lazySettle();
    assert.equal(column.isCollapsed(), true, 'the flip keeps the collapsed state');
    assert.equal(lazy.state.getSessionCalls, 0, 'no boot from a breakpoint flip while collapsed');

    column.expand();
    await lazySettle();
    assert.equal(lazy.state.getSessionCalls, 1, 'the first open boots');
    const panel = document.body.querySelector('.wap-chat-column__panel');
    flip(true);
    assert.equal(panel.getAttribute('role'), 'dialog', 'narrow re-applies the expanded state as an overlay dialog');
    flip(false);
    assert.equal(panel.getAttribute('role'), 'complementary', 'wide re-applies it as a pushing panel');
    await lazySettle();
    assert.equal(column.isCollapsed(), false, 'the flip keeps the expanded state');
    assert.equal(lazy.state.getSessionCalls, 1, 'a flip after the boot adds no call');
});

test('startOnOpen: a column seeded open boots exactly once at mount', async () => {
    const seeded = lazyColumnHarness({ column: { startOnOpen: true, defaultState: 'expanded' } });
    mount(seeded.fetchImpl, seeded.options);
    await lazySettle();
    assert.equal(seeded.state.getSessionCalls, 1, 'defaultState expanded boots once');

    const sync = lazyColumnHarness({
        column: { startOnOpen: true },
        init: { columnState: { get: () => 'expanded', set: () => {} } },
    });
    mount(sync.fetchImpl, sync.options);
    await lazySettle();
    assert.equal(sync.state.getSessionCalls, 1, 'a synchronous columnState.get() of expanded boots once');
});

test('startOnOpen: an async columnState.get() resolving expanded boots after the restore', async () => {
    const lazy = lazyColumnHarness({
        column: { startOnOpen: true },
        init: { columnState: { get: () => Promise.resolve('expanded'), set: () => {} } },
    });
    const { column } = mount(lazy.fetchImpl, lazy.options);

    await waitFor(() => !column.isCollapsed(), 'restore opens the column');
    await waitFor(() => lazy.state.getSessionCalls === 1, 'session boots after the restore');
    await lazySettle();
    assert.equal(lazy.state.getSessionCalls, 1);
});

test('startOnOpen: a re-init to a collapsed mount does not inherit the started session', async () => {
    const lazy = lazyColumnHarness({ column: { startOnOpen: true } });
    const { column, window, document } = mount(lazy.fetchImpl, lazy.options);
    column.expand();
    await waitFor(() => lazy.state.getSessionCalls === 1, 'first mount started');

    const second = window.WapChat.mount(document.body, {
        loadGravity: false,
        wapBrowserUrl: 'https://wap.test',
        getSession: lazy.options.getSession,
        column: { startOnOpen: true, id: 'second' },
    });
    await lazySettle();
    assert.equal(lazy.state.getSessionCalls, 1, 'the collapsed second mount stays idle');

    second.expand();
    await waitFor(() => lazy.state.getSessionCalls === 2, 'the second mount starts on its own first open');
});

test('startOnOpen: readOnly never boots, even after expand()', async () => {
    const lazy = lazyColumnHarness({
        column: { startOnOpen: true },
        init: { readOnly: true, transcript: [{ role: 'user', content: 'hi' }] },
    });
    const { column } = mount(lazy.fetchImpl, lazy.options);
    column.expand();
    await lazySettle();

    assert.equal(lazy.state.getSessionCalls, 0);
    assert.deepEqual(lazy.state.requests, []);
});

test('startOnOpen: a readOnly re-init after a lazy mount is not left armed', async () => {
    const lazy = lazyColumnHarness({ column: { startOnOpen: true } });
    const { window, document } = mount(lazy.fetchImpl, lazy.options);
    await lazySettle();

    const replay = window.WapChat.mount(document.body, {
        loadGravity: false,
        wapBrowserUrl: 'https://wap.test',
        getSession: lazy.options.getSession,
        readOnly: true,
        transcript: [{ role: 'user', content: 'hi' }],
        column: { startOnOpen: true, id: 'replay' },
    });
    replay.expand();
    await lazySettle();

    assert.equal(lazy.state.getSessionCalls, 0, 'the readOnly mount never boots, whatever the previous mount armed');
});

test('startOnOpen: only boolean true is lazy; a truthy string or number still boots eagerly', async () => {
    for (const value of ['true', 1]) {
        const eager = lazyColumnHarness({ column: { startOnOpen: value } });
        mount(eager.fetchImpl, eager.options);
        await lazySettle();
        assert.equal(eager.state.getSessionCalls, 1, `startOnOpen: ${JSON.stringify(value)} boots at mount`);
    }
});

test('startOnOpen: consent refused, then expand() shows the consent modal with no getSession', async () => {
    const lazy = lazyColumnHarness({
        column: { startOnOpen: true },
        consent: { get: () => Promise.resolve(false), set: () => Promise.resolve(true) },
    });
    const { column, root } = mount(lazy.fetchImpl, lazy.options);
    await lazySettle();
    assert.equal(root.querySelector('.wap-consent-modal'), null, 'no modal while collapsed');

    column.expand();
    await waitFor(() => !!root.querySelector('.wap-consent-modal'), 'consent modal shown on open');
    assert.equal(lazy.state.getSessionCalls, 0, 'getSession waits for consent');
});

// ─────────────────────────────────────────────────────────────────────────────
// The preview's sample data (preview/, `npm run preview`).
//
// The preview answers this widget from preview/fake-wap.mjs. These tests run
// that same fake through this widget, so the preview cannot fall behind it
// unnoticed: a sample reply or case the widget no longer draws, a stream event
// the widget handles that no sample sends, or a WAP endpoint the widget calls
// that the fake does not answer, fails here. Nothing below lists the samples:
// a new reply or case in preview/ is covered as soon as it exists.
// ─────────────────────────────────────────────────────────────────────────────

/** fetch() answered by the preview's fake, the way preview/server.mjs answers it. */
function previewFetch(fake) {
    const calls = { pending: 0, paths: [] };
    const impl = async (url, init = {}) => {
        const target = new URL(url);
        const method = init.method || 'GET';
        calls.pending++;
        calls.paths.push(`${method} ${target.pathname}`);
        try {
            const token = String((init.headers || {}).Authorization || '').replace(/^Bearer /, '');
            const answer = fake.api(method, target, init.body ? JSON.parse(init.body) : null, token);
            if (answer.stream) {
                let text = '';
                for await (const chunk of answer.stream) text += chunk;
                return new Response(text, { status: answer.status, headers: { 'Content-Type': 'text/event-stream' } });
            }
            if (answer.json !== undefined) return json(answer.json, answer.status);
            return new Response(answer.body ?? null, { status: answer.status });
        } finally {
            calls.pending--;
        }
    };
    return { impl, calls };
}

/** The widget on the preview's fake, as a SaaS host mounts it, in `scenarios` with no streaming delay. */
function mountPreview(scenarios = []) {
    const warnings = [];
    const fake = new FakeWap({ warn: (line) => warnings.push(line) });
    const token = PreviewToken.encode({ product: 'wp-rocket', scenarios: ['instant', ...scenarios], tab: 'test' });
    const ask = (params) => fake.ajax(new URLSearchParams(params), token).json;
    const fetcher = previewFetch(fake);
    const harness = mount(fetcher.impl, {
        layout: { showHeader: true, showNewChat: true, showSettings: true },
        // The SaaS host's session and consent routes (preview/server.mjs, /saas/*).
        consent: {
            get: () => ask({ action: 'wap_client_consent', op: 'get' }).data.granted,
            set: () => ask({ action: 'wap_client_consent', op: 'grant' }),
        },
        init: {
            conversationId: '',
            getSession: async () => {
                const answer = ask({ action: 'wap_client_auth' });
                if (!answer.success) throw new Error(answer.data.message);
                return { token: answer.data.token };
            },
        },
    });
    return { ...harness, fake, token, calls: fetcher.calls, warnings };
}

/** Wait until the widget has no call in flight and has stopped streaming, for a while. */
async function settle({ root, calls }) {
    let quiet = 0;
    for (let tick = 0; tick < 2000 && quiet < 25; tick++) {
        const streaming = root.querySelectorAll('button').some((button) => button.getAttribute('aria-label') === 'Stop');
        quiet = calls.pending === 0 && !streaming ? quiet + 1 : 0;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

// The widget shows every failure as a Gravity alert notice (appendErrorMessage, appendErrorToAssistant).
const errorNotices = (root) => root.querySelectorAll('.gv-notice-alert').length;

/** Every event a reply streams, its continuation included, for what it is expected to draw. */
function replyEvents(reply) {
    // The context the fake gives a reply: the default product and its agents, not restated here.
    const fake = new FakeWap({ warn: () => {} });
    const session = fake.session(PreviewToken.encode({ product: 'wp-rocket', scenarios: [], tab: 'test' }));
    const context = fake.context(session, session.agentFor(''));
    const steps = reply.steps ? reply.steps(context) : [];
    const question = steps.find((step) => step.then);
    const next = question ? question.then(firstChoiceValue(question.event)) : [];
    return { steps, question, next };
}

function firstChoiceValue(event) {
    const choice = event.choices[0];
    return typeof choice === 'string' ? choice : choice.value;
}

for (const reply of REPLIES.filter((r) => !r.hidden)) {
    test(`preview reply "${reply.name}" draws in the widget`, async () => {
        const harness = mountPreview();
        const { root } = harness;
        await settle(harness);
        assert.equal(errorNotices(root), 0, 'the preview starts without an error');

        root.querySelector('textarea').value = reply.words[0] || 'How do I speed up my site?';
        root.querySelector('button.gv-button-primary').click();
        await settle(harness);

        const { steps, question, next } = replyEvents(reply);
        const fails = !!reply.refuse || steps.some((step) => step.drop || (step.event && step.event.type === 'error'));
        assert.equal(errorNotices(root), fails ? 1 : 0, fails ? 'the failure is shown, once' : 'no error is shown');
        if (steps.some((step) => step.event && step.event.type === 'visual')) {
            assert.ok(root.querySelectorAll('.wap-visual').length > 0, 'the visual is drawn');
        }
        if (steps.some((step) => step.event && step.event.type === 'document')) {
            assert.equal(root.querySelectorAll('.wap-document').length, 1, 'the document card is drawn');
        }

        if (question) {
            const card = root.querySelector('.wap-reply');
            assert.ok(card, 'the question card is shown');
            card.querySelector('.wap-reply__option').click();
            // A multiple-choice card answers on Confirm; a single-choice one on the click.
            if (question.event.multi_select) card.querySelector('button.gv-button-primary').click();
            await settle(harness);
            assert.equal(errorNotices(root), 0, 'answering the question resumes without an error');
            assert.equal(root.querySelector('.wap-reply'), null, 'the card is gone once answered');
            if (next.some((step) => step.event && step.event.type === 'agent_handoff')) {
                assert.ok(harness.calls.paths.filter((p) => p === 'POST /api/v1/chat/stream').length >= 2, 'the target agent was asked to continue');
                assert.ok(root.querySelectorAll('.wap-visual').length > 0, 'the target agent answered');
            }
        }
        assert.deepEqual(harness.warnings, [], 'every call was answered');
    });
}

for (const name of Object.keys(SCENARIOS)) {
    test(`preview case "${name}" loads in the widget`, async () => {
        const harness = mountPreview([name]);
        await settle(harness);
        const { root } = harness;
        // A backend that is down shows once the user sends something; a failed sign in at once.
        if (name === 'backend-down') {
            root.querySelector('textarea').value = 'hello';
            root.querySelector('button.gv-button-primary').click();
            await settle(harness);
        }
        // Cases meant to end on an alert: two failures, and the limit-reached banner.
        const alerting = { 'sign-in-fails': 1, 'backend-down': 1, 'quota-spent': 1 };
        assert.equal(errorNotices(root), alerting[name] || 0, alerting[name] ? 'the alert is shown' : 'no error is shown');
        if (name === 'returning') {
            assert.ok(root.querySelectorAll('.wap-visual').length > 0, 'the chart comes back from history');
            assert.equal(root.querySelectorAll('.wap-document').length, 1, 'the invoice comes back from history');
        }
        if (name === 'paused-question') assert.ok(root.querySelector('.wap-reply'), 'the unanswered question comes back');
        if (name === 'first-visit') assert.ok(root.querySelector('.wap-consent-gate, .wap-consent-modal'), 'the consent gate is shown');
        if (name === 'expired-token') assert.ok(harness.calls.paths.length > 0, 'the widget recovered and loaded');
        assert.deepEqual(harness.warnings, [], 'every call was answered');
    });
}

test('every stream event the widget handles has a preview sample, and the preview sends no other', async () => {
    const reader = widgetSource.slice(widgetSource.indexOf('function readSSEStream'));
    const handled = new Set([...reader.slice(0, reader.indexOf('default:')).matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
    assert.ok(handled.size > 5, 'found the stream reader in wap-chat.js');

    // What the fake really streams: every reply, and the continuation of every question.
    const sent = new Set();
    const collect = async (answer) => {
        if (!answer.stream) return;
        for await (const chunk of answer.stream) {
            const data = chunk.slice('data: '.length).trim();
            if (data !== '[DONE]') sent.add(JSON.parse(data).type);
        }
    };
    for (const reply of REPLIES) {
        const fake = new FakeWap({ warn: () => {} });
        const token = PreviewToken.encode({ product: 'wp-rocket', scenarios: ['instant'], tab: 'events' });
        const url = (path) => new URL(`https://wap.test${path}`);
        if (reply.hidden) continue;
        await collect(fake.api('POST', url('/api/v1/chat/stream'), { message: reply.words[0] || 'hello' }, token));
        const { question } = replyEvents(reply);
        if (question) {
            await collect(fake.api('POST', url('/api/v1/chat/resume'), { answer: firstChoiceValue(question.event) }, token));
        }
        const handoff = fake.sessions.size && [...fake.sessions.values()][0].handoffs;
        for (const handoffToken of handoff ? handoff.keys() : []) {
            await collect(fake.api('POST', url('/api/v1/chat/stream'), { handoff_token: handoffToken }, token));
        }
    }

    // Events the widget handles that py-backend/app never produces, so the preview must not send them:
    // a sample would show a state production never reaches.
    const WIDGET_ONLY = { routing: 'the widget draws it, but nothing in py-backend/app sends it' };
    const sentButNeverBackend = Object.keys(WIDGET_ONLY).filter((type) => sent.has(type));
    assert.deepEqual(sentButNeverBackend, [], `the preview sends events the backend never sends (${JSON.stringify(WIDGET_ONLY)}): remove the reply from preview/replies.mjs`);

    const unsampled = [...handled].filter((type) => !sent.has(type) && !(type in WIDGET_ONLY));
    const invented = [...sent].filter((type) => !handled.has(type));
    assert.deepEqual(unsampled, [], 'the widget handles these stream events but no preview reply sends them: add one to preview/replies.mjs, or list the event in WIDGET_ONLY (test-widget.mjs) if the backend never sends it');
    assert.deepEqual(invented, [], 'the preview sends stream events the widget does not handle');
});

/** The widget's code without its comment lines, which name routes the code does not call. */
const widgetCode = widgetSource.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

test('the preview answers every WAP endpoint the widget calls', async () => {
    const thread = 'preview-endpoints:wp-rocket:standard';
    // One request per path written in wap-chat.js. A path the widget starts calling
    // fails the first assertion until it has a request here and an answer in the fake.
    const REQUESTS = {
        '/api/v1/agents/welcome': ['GET', '/api/v1/agents/welcome'],
        '/api/v1/chat/agents': ['GET', '/api/v1/chat/agents'],
        '/api/v1/chat/quota': ['GET', '/api/v1/chat/quota'],
        '/api/v1/chat/': ['GET', `/api/v1/chat/${encodeURIComponent(thread)}/history`],
        // The case starts paused on a question, which /resume answers before /new clears it.
        '/api/v1/chat/resume': ['POST', '/api/v1/chat/resume', { answer: 'Remove unused CSS' }],
        '/api/v1/chat/stream': ['POST', '/api/v1/chat/stream', { message: 'hello' }],
        '/api/v1/chat/new': ['POST', '/api/v1/chat/new', {}],
        '/api/v1/mcp/oauth/redeem': ['POST', '/api/v1/mcp/oauth/redeem', { state: thread, code: 'preview-code' }],
        '/api/v1/me/data/erase': ['POST', '/api/v1/me/data/erase'],
    };
    const fix = 'add the request to REQUESTS in npm/test-widget.mjs and its answer to preview/fake-wap.mjs';

    // Paths in single quotes, double quotes or template literals; every `api/v1` in the code must be one of them.
    const written = [...widgetCode.matchAll(/(['"`])(\/api\/v1(?:\/[A-Za-z0-9/_-]*)?)/g)].map((m) => m[2]);
    const mentions = widgetCode.match(/api\/v1/g) || [];
    // A path built from pieces ('/api/v' + '1/chat/') leaves an api/v with no api/v1 after it.
    assert.equal((widgetCode.match(/api\/v/g) || []).length, mentions.length, `wap-chat.js builds an api/v path from pieces, which this test cannot read: write the path whole, or ${fix}`);
    assert.equal(written.length, mentions.length, `wap-chat.js has an api/v1 path this test cannot read (a quote style or a built string): teach npm/test-widget.mjs to read it, or ${fix}`);
    assert.deepEqual([...new Set(written)].sort(), Object.keys(REQUESTS).sort(), `the WAP paths wap-chat.js calls: ${fix}`);

    const warnings = [];
    const fake = new FakeWap({ warn: (line) => warnings.push(line) });
    const token = PreviewToken.encode({ product: 'wp-rocket', scenarios: ['instant', 'paused-question'], tab: 'endpoints' });
    for (const [method, path, body] of Object.values(REQUESTS)) {
        const answer = fake.api(method, new URL(`https://wap.test${path}`), body || null, token);
        if (answer.stream) for await (const chunk of answer.stream) void chunk;
        assert.ok(answer.status < 400, `${method} ${path} answered ${answer.status}: ${fix}`);
    }
    assert.deepEqual(warnings, []);
});

test('the preview answers every admin-ajax action the widget posts', () => {
    // `action: 'wap_client_x'` in a request body and params.set('action', 'wap_client_x') are the two ways
    // wap-chat.js names one; other wap_client_* strings (an error code, a PHP filter) are not actions.
    const inBody = [...widgetCode.matchAll(/\baction:\s*(['"`])(wap_client_\w+)\1/g)].map((m) => m[2]);
    const inParams = [...widgetCode.matchAll(/\.set\(\s*(['"`])action\1\s*,\s*(['"`])(wap_client_\w+)\2/g)].map((m) => m[3]);
    const actions = [...new Set([...inBody, ...inParams])].sort();
    assert.ok(actions.length >= 5, `found the admin-ajax actions in wap-chat.js (${actions.join(', ')})`);

    const warnings = [];
    const fake = new FakeWap({ warn: (line) => warnings.push(line) });
    const token = PreviewToken.encode({ product: 'wp-rocket', scenarios: [], tab: 'ajax' });
    for (const action of actions) {
        const answer = fake.ajax(new URLSearchParams({ action }), token);
        assert.equal(answer.status, 200, `the preview does not answer the admin-ajax action ${action}: add it to preview/fake-wap.mjs`);
    }
    assert.deepEqual(warnings, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// The preview's host pages against the PHP that builds them (includes/).
//
// preview/page.mjs and preview/wp-source.mjs read or restate what WordPress hands
// the widget. These tests compare them with the PHP, in both directions, so a key
// added or renamed there, a string the parser cannot read, or a changed mount
// point fails here and names the file to update.
// ─────────────────────────────────────────────────────────────────────────────

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const phpSource = (file) => readFileSync(join(packageRoot, 'includes', file), 'utf8');
const widgetPhp = phpSource('class-chat-widget.php');
const columnPhp = phpSource('class-chat-column.php');
const embedPhp = phpSource('class-chat-embed.php');

/**
 * The top-level entries of the PHP array literal that follows `marker` in `source`.
 * Strings are kept whole, nested brackets reduced to a placeholder. Comments are
 * dropped first: they hold apostrophes.
 */
function arrayAfter(source, marker) {
    const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const at = code.indexOf(marker);
    assert.notEqual(at, -1, `the PHP source has no "${marker}"`);

    const entries = [];
    let depth = 0;
    let current = '';
    for (let i = code.indexOf('[', at); i < code.length; i++) {
        const char = code[i];
        if (char === "'" || char === '"') {
            let end = i + 1;
            while (code[end] !== char) end += code[end] === '\\' ? 2 : 1;
            if (depth === 1) current += code.slice(i, end + 1);
            i = end;
        } else if ('[({'.includes(char)) {
            depth++;
            if (depth === 2) current += '(…)';
        } else if ('])}'.includes(char)) {
            depth--;
            if (depth === 0) break;
        } else if (depth === 1 && char === ',') {
            entries.push(current.trim());
            current = '';
        } else if (depth === 1) {
            current += char;
        }
    }
    if (current.trim()) entries.push(current.trim());
    return entries;
}

const keysOf = (entries) => entries.map((entry) => /^'(\w+)'\s*=>/.exec(entry)?.[1]).filter(Boolean);

function pageFor(query) {
    const wordpress = new WordPressSource(packageRoot);
    const options = pageOptions(new URLSearchParams(query), wordpress.locales());
    return renderPage(options, { packageRoot, wordpress, origin: 'http://localhost:4100' });
}

function configIn(html) {
    const json = /var WapClientConfig = (.*?);<\/script>/s.exec(html);
    assert.ok(json, 'the page carries WapClientConfig');
    return JSON.parse(json[1]);
}

test('the config the preview page builds has the keys wp_localize_script writes, and no other', () => {
    const php = keysOf(arrayAfter(widgetPhp, "'WapClientConfig',"));
    assert.ok(php.length > 20, `read the WapClientConfig keys from class-chat-widget.php (${php.length})`);
    for (const query of ['', 'surface=column']) {
        const page = Object.keys(configIn(pageFor(query)));
        assert.deepEqual(php.filter((key) => !page.includes(key)), [], 'WapClientConfig keys the PHP writes that preview/page.mjs lacks: add them to config in renderPage()');
        assert.deepEqual(page.filter((key) => !php.includes(key)), [], 'WapClientConfig keys preview/page.mjs writes that includes/class-chat-widget.php does not: remove them from config in renderPage()');
    }
});

test('the preview reads every string and suggestion the PHP localises', () => {
    const defaults = arrayAfter(widgetPhp, '$i18n_defaults = [');
    const parsed = readI18nDefaults(widgetPhp);
    // assistantName is the one entry that is not a plain __(): the page fills it from the menu title.
    assert.deepEqual(
        keysOf(defaults).filter((key) => !(key in parsed) && key !== 'assistantName'),
        [],
        'strings in $i18n_defaults that readI18nDefaults (preview/wp-source.mjs) cannot read: teach it the new form',
    );
    assert.equal(Object.keys(parsed).length + 1, defaults.length, 'every $i18n_defaults entry is read, except assistantName');

    const suggestions = arrayAfter(widgetPhp, "'wap_client_suggestions',");
    assert.equal(readDefaultSuggestions(widgetPhp).length, suggestions.length, 'every default suggestion in class-chat-widget.php is read by readDefaultSuggestions (preview/wp-source.mjs)');

    const rendered = configIn(pageFor('locale=en_US'));
    assert.deepEqual(Object.keys(rendered.i18n).sort(), [...Object.keys(parsed), 'assistantName'].sort(), 'the page passes every localised string');
});

test('the preview renders the mount points and Gravity version the PHP prints', () => {
    const phpRoot = widgetPhp.slice(widgetPhp.indexOf('function render_chat_root'));
    const phpMarkup = phpRoot.slice(phpRoot.indexOf('<div'));
    const rootId = /string \$root_id = '([^']+)'/.exec(phpRoot)?.[1];
    const rootClass = /<div\s+id="[^"]*"\s+class="([^"]+)"\s+data-product=/s.exec(phpMarkup)?.[1];
    const loaderClass = /<div class="([^"]+)" aria-live="polite">/.exec(phpMarkup)?.[1];
    const loader = /<gv-loader src="([^"]+)"/.exec(phpMarkup)?.[1];
    const connecting = /esc_html_e\('([^']+)', 'wap-client'\)/.exec(phpMarkup)?.[1];
    assert.ok(rootId && rootClass && loaderClass && loader && connecting, 'read render_chat_root() in class-chat-widget.php');
    const fix = 'update chatRoot() and renderPage() in preview/page.mjs';

    const page = pageFor('');
    assert.ok(page.includes(`id="${rootId}" class="${rootClass}" data-product="wp-rocket"`), `the mount point of render_chat_root(): ${fix}`);
    assert.ok(page.includes(`<div class="${loaderClass}" aria-live="polite">`), `the loading state's wrapper: ${fix}`);
    assert.ok(page.includes(`<gv-loader src="${loader}"></gv-loader>`), `the loading spinner: ${fix}`);
    assert.ok(page.includes(`<p>${connecting}</p>`), `the connecting text: ${fix}`);

    // The version the page loads Gravity from is the PHP's, in the stylesheet, the script and the spinner.
    const version = readGravityVersion(widgetPhp);
    assert.equal(version, /gravity\.group-cdn\.one\/(v[\d.]+)\//.exec(loader)[1], 'one Gravity version in the PHP');
    assert.ok(page.includes(`gravity.group-cdn.one/${version}/css/brands/`) && page.includes(`gravity.group-cdn.one/${version}/index.umd.js`), `the Gravity version of the PHP: ${fix}`);

    const slug = 'wp-rocket-assistant';
    const columnPrefix = /'(wap-chat-column-root-)' \. \$id/.exec(columnPhp)?.[1];
    const embedPrefix = /'(wap-chat-embed-root-)' \. \$id/.exec(embedPhp)?.[1];
    assert.ok(pageFor('surface=column').includes(`id="${columnPrefix}${slug}"`), `the column's mount point id (class-chat-column.php root_id): ${fix}`);
    assert.ok(pageFor('surface=embed').includes(`id="${embedPrefix}${slug}"`), `the embed's mount point id (class-chat-embed.php root_id): ${fix}`);

    const wrapper = /class="(wap-chat-column)"\s+data-wap-chat-column="[^"]*"\s+data-wap-column-state="/s.exec(columnPhp)?.[1];
    assert.ok(wrapper && pageFor('surface=column').includes(`class="${wrapper}" data-wap-chat-column="${slug}" data-wap-column-state="expanded"`), `the column's wrapper element: ${fix}`);
});

test('a request naming an inherited property gets the default page and session', () => {
    const wordpress = new WordPressSource(packageRoot);
    for (const query of ['product=constructor', 'surface=toString', 'scenario=constructor,__proto__']) {
        const options = pageOptions(new URLSearchParams(query), wordpress.locales());
        assert.doesNotThrow(() => renderPage(options, { packageRoot, wordpress, origin: 'http://localhost:4100' }), query);
    }
    const fake = new FakeWap({ warn: () => {} });
    const session = fake.session(PreviewToken.encode({ product: 'constructor', scenarios: ['constructor'], tab: 'x' }));
    assert.equal(session.product.slug, 'wp-rocket');
});

test('only a stylesheet under assets/ is swapped in place; any other change reloads', () => {
    assert.equal(describeChange(['assets/wap-chat.css']).event, 'css');
    assert.equal(describeChange(['assets/wap-chat.css', 'assets/wap-standalone.css']).event, 'css');
    assert.equal(describeChange(['assets/wap-chat.js']).event, 'reload');
    assert.equal(describeChange(['assets/wap-chat.css', 'assets/wap-chat.js']).event, 'reload', 'a mix reloads');
    assert.equal(describeChange([]).event, 'reload', 'an empty list reloads');
    // restyle() in preview/public/harness.js swaps /assets/ stylesheets only.
    assert.equal(describeChange(['preview/public/harness.css']).event, 'reload');
    assert.equal(describeChange(['assets/wap-chat.css', 'preview/public/harness.css']).event, 'reload');

    const css = describeChange(['assets/wap-chat.css']);
    assert.equal(css.data, 'assets/wap-chat.css');
    assert.match(css.line, /changed: assets\/wap-chat\.css -> restyled/);
    const both = describeChange(['assets/wap-chat.js', 'preview/samples.json']);
    assert.match(both.line, /changed: assets\/wap-chat\.js, preview\/samples\.json -> reloaded/);
});

test('the samples are read again when their file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wap-samples-'));
    const file = join(dir, 'samples.json');
    const at = (seconds) => utimesSync(file, seconds, seconds);
    try {
        writeFileSync(file, JSON.stringify({ title: 'first' }));
        at(1000);
        const read = samplesReader(file);
        assert.equal(read().title, 'first');

        writeFileSync(file, JSON.stringify({ title: 'second' }));
        at(1000);
        assert.equal(read().title, 'first', 'unchanged modification time: not read again');
        at(2000);
        assert.equal(read().title, 'second', 'a new modification time: read again');

        const warn = console.warn;
        const said = [];
        console.warn = (line) => said.push(line);
        try {
            writeFileSync(file, '{ "title": ');
            at(3000);
            assert.equal(read().title, 'second', 'a half-saved file keeps the last good copy');
        } finally {
            console.warn = warn;
        }
        assert.equal(said.length, 1, 'and says so');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a static request resolves to a file under its folder, or to an error status', () => {
    const folders = { '/assets/': join(tmpdir(), 'wap-static', 'assets'), '/preview/': join(tmpdir(), 'wap-static', 'public') };
    assert.equal(resolveStatic('/favicon.ico', folders), null, 'no prefix: not static');
    assert.deepEqual(resolveStatic('/assets/wap-chat.css', folders), { file: join(folders['/assets/'], 'wap-chat.css') });
    assert.deepEqual(resolveStatic('/assets/vendor/a%20b.js', folders), { file: join(folders['/assets/'], 'vendor', 'a b.js') });
    assert.deepEqual(resolveStatic('/assets/%E0%A4%A', folders), { status: 400 }, 'a malformed percent escape');
    assert.deepEqual(resolveStatic('/assets/..%2Fpublic%2Fharness.js', folders), { status: 403 }, 'a traversal');
    assert.deepEqual(resolveStatic('/assets/../../etc/passwd', folders), { status: 403 });
});
