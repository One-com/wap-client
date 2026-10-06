import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

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
    focus() {}
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
    }
    createElement(tag) { return new FakeNode(tag); }
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
// tests below have to send both. 'accept' stays first: they click the first radio.
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
    const root = new FakeNode('div');
    document.body.appendChild(root);
    const windowListeners = new Map();
    const window = {
        WapClientConfig: {},
        console,
        matchMedia: () => ({ matches: false }),
        customElements: { get: () => null },
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
        getComputedStyle: () => ({ color: 'rgb(0, 0, 0)' }),
        setTimeout,
        clearTimeout,
        TextDecoder,
        URLSearchParams,
        window,
    };
    vm.runInNewContext(widgetSource, context, { filename: 'wap-chat.js' });
    window.WapChat.init(Object.assign({
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
    }, options.consent ? { consent: options.consent } : {}));
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

function permissionSelects(card) {
    return card.querySelectorAll('.wap-settings__row--permission').map((row) => row.querySelector('select'));
}

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
    await waitFor(() => permissionSelects(card).length === 2, 'both permission rows should render');

    const [plugin, site] = permissionSelects(card);
    assert.equal(plugin.disabled, false, 'a two-option row stays interactive');
    assert.equal(plugin.options.length, 2);
    assert.equal(site.disabled, true, 'a single-option row is read-only');
    assert.ok(card.textContent.includes('Manage your Rank Math plugin'));
});

test('stored values win over defaults, and unknown stored values fall back', async () => {
    const stored = { 'manage-plugin': 'allow', 'manage-site': 'something-else' };
    const { card } = await openSettingsSheet({
        permissions: PERMISSION_ROWS,
        permissionState: { get: (id) => Promise.resolve(stored[id]), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionSelects(card).length === 2, 'rows should render');

    const [plugin, site] = permissionSelects(card);
    assert.equal(plugin.value, 'allow', 'the stored value is selected');
    assert.equal(site.value, 'deny', 'a value the row does not offer falls back to the default');
});

test('a read failure never throws out of the sheet; the row shows its default', async () => {
    const { card } = await openSettingsSheet({
        permissions: PERMISSION_ROWS,
        permissionState: { get: () => Promise.reject(new Error('store down')), set: () => Promise.resolve() },
    });
    await waitFor(() => permissionSelects(card).length === 2, 'rows should still render');

    assert.equal(permissionSelects(card)[0].value, 'deny');
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
    await waitFor(() => permissionSelects(card).length === 2, 'rows should render');
    sessions.length = 0; // drop the mount's own auth

    const plugin = permissionSelects(card)[0];
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
    await waitFor(() => permissionSelects(card).length === 2, 'rows should render');
    sessions.length = 0;

    const plugin = permissionSelects(card)[0];
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
    await waitFor(() => permissionSelects(card).length === 2 && !permissionSelects(card)[0].disabled, 'rows should load');
    sessions.length = 0;

    const plugin = permissionSelects(card)[0];
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
    await waitFor(() => permissionSelects(card).length === 2, 'rows should render');

    assert.deepEqual(permissionSelects(card).map((node) => node.disabled), [true, true]);
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
    await waitFor(() => permissionSelects(card).length === 1, 'only the one valid row survives');

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

async function askPermission(event, i18n) {
    const requests = [];
    const fetchImpl = async (url, init = {}) => {
        requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
        if (url.endsWith('/api/v1/chat/stream')) return sse([event]);
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

    root.querySelector('input').click(); // the first choice is Allow
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
    const choices = root.querySelectorAll('input');
    choices[0].dispatchEvent({ type: 'change' });
    choices[1].dispatchEvent({ type: 'change' });
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

    const choice = root.querySelector('input');
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

    const choice = root.querySelector('input');
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
        root.querySelector('input').click();
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
    root.querySelector('input').click();
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
