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
    window.WapChat.init({
        root,
        loadGravity: false,
        wapBrowserUrl: 'https://wap.test',
        conversationId: 'source-thread',
        getSession: ({ forceNew }) => options.getSession
            ? options.getSession(forceNew)
            : Promise.resolve({ token: forceNew ? 'fresh-token' : 'token' }),
        layout: {
            width: 'fluid',
            expandToggle: 'off',
            showHeader: false,
            showNewChat: false,
            showSettings: false,
            showDeleteData: false,
        },
    });
    return { document, root, window };
}

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
