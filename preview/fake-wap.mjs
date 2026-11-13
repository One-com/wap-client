/**
 * The sample-data stand-in for the WAP API and the admin-ajax actions the widget
 * calls. It touches neither the network nor the disk, so tests drive it directly.
 * What it answers and how its shapes are checked: preview/README.md.
 */

import { productFor } from './products.mjs';
import { REPLIES, replyFor, sample, samples } from './replies.mjs';
import { SCENARIOS, namedScenarios } from './scenarios.mjs';

// ── The session token ───────────────────────────────────────────────────────

/**
 * The credential the preview hands the widget, standing in for a GRND:
 * `preview.<product>.<scenario,scenario>.<tab>`. It names the product, the
 * scenarios and the browser tab, so the fake keeps one sample session per tab
 * and two tabs can show two cases side by side. The page builds it
 * (public/harness.js); readable on purpose, it shows in the network panel.
 */
export const PreviewToken = {
    encode({ product, scenarios = [], tab }) {
        return ['preview', product, scenarios.join(','), tab].join('.');
    },

    decode(token) {
        const match = /^preview\.([a-z0-9-]{1,40})\.([a-z0-9,-]{0,200})\.([a-z0-9]{1,40})$/.exec(String(token || ''));
        if (!match) return null;
        return { product: match[1], scenarios: namedScenarios(match[2]).chosen, tab: match[3] };
    },
};

/** The first day of next month, 00:00, in epoch milliseconds: when a monthly quota renews. */
function nextMonth() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

// ── One user's sample state ─────────────────────────────────────────────────

export class PreviewSession {
    constructor({ product, scenarios = [], tab }) {
        this.product = productFor(product);
        this.agents = this.product.agents.map((agent) => ({ ...agent }));
        this.userId = `preview-${tab}`;
        this.consentGranted = true;
        this.quota = { enabled: true, total: 50, remaining: 42, resetAt: nextMonth() };
        this.permissionValues = {};
        this.columnState = null;
        /** Multiplies every streaming delay; 0 sends each reply at once. */
        this.pace = 1;
        this.expireTokenOnce = false;
        this.authFailure = '';
        this.backendDown = false;
        /** role -> history entries, in the shape GET /chat/history answers. */
        this.threads = new Map();
        /** role -> {event, then}: a question the run is paused on. */
        this.paused = new Map();
        /** handoff token -> what the target agent's first turn needs. */
        this.handoffs = new Map();

        for (const name of scenarios) SCENARIOS[name].apply(this);
    }

    get defaultRole() {
        return this.agents[0].role;
    }

    /** The agent for a requested role, or the default one, as resolve_requested_role does. */
    agentFor(role) {
        return this.agents.find((agent) => agent.role === role) || this.agents[0];
    }

    /** "{user_id}:{role}", the thread id the backend uses. */
    threadId(role) {
        return `${this.userId}:${role}`;
    }

    thread(role) {
        if (!this.threads.has(role)) this.threads.set(role, []);
        return this.threads.get(role);
    }

    seed(role, entries) {
        this.thread(role).push(...entries);
    }

    /** Leave `role`'s thread paused on `question` (a question event), as an interrupted ask_user run is. */
    pause(role, question, then = () => []) {
        this.paused.set(role, { event: question, then });
    }
}

// ── Responses ───────────────────────────────────────────────────────────────

const json = (status, body) => ({ status, json: body });
const noContent = () => ({ status: 204 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;
const SSE_DONE = 'data: [DONE]\n\n';

/** WordPress's admin-ajax answers: wp_send_json_success() / wp_send_json_error(). */
const wpSuccess = (data = {}) => json(200, { success: true, data });
const wpError = (message, extra = {}) => json(200, { success: false, data: { message, ...extra } });

/**
 * A one-page PDF saying `title`, for the document card's Download PDF. Built here
 * so the preview carries no binary file.
 */
export function samplePdf(title) {
    const text = title.replace(/[()\\]/g, '');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        null,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const content = `BT /F1 20 Tf 60 770 Td (${text}) Tj ET\nBT /F1 11 Tf 60 745 Td (Sample document from the wap-client preview.) Tj ET`;
    objects[3] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;

    let pdf = '%PDF-1.7\n';
    const offsets = objects.map((body, i) => {
        const offset = Buffer.byteLength(pdf);
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
        return offset;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
}

// ── The fake ────────────────────────────────────────────────────────────────

export class FakeWap {
    /**
     * @param {object} [options]
     * @param {(line: string) => void} [options.warn] where to say a call went unanswered
     */
    constructor({ warn = (line) => console.warn(line) } = {}) {
        this.warn = warn;
        this.sessions = new Map();
    }

    /** The session a token names, created on first use; null for a token that is not the preview's. */
    session(token) {
        const identity = PreviewToken.decode(token);
        if (!identity) return null;
        const key = PreviewToken.encode(identity);
        if (!this.sessions.has(key)) this.sessions.set(key, new PreviewSession(identity));
        return this.sessions.get(key);
    }

    /** Forget a session, so the next call starts it again from its scenarios. */
    reset(token) {
        const identity = PreviewToken.decode(token);
        if (identity) this.sessions.delete(PreviewToken.encode(identity));
    }

    // ── WordPress admin-ajax (includes/class-chat-widget.php, class-chat-column.php) ──

    /**
     * @param {URLSearchParams} params the form body the widget posts
     * @param {string} token the preview token, carried on the ajaxUrl
     */
    ajax(params, token) {
        const session = this.session(token);
        const action = params.get('action');
        if (!session) return { status: 400, text: '0' };

        switch (action) {
            case 'wap_client_auth':
                if (session.authFailure) return wpError(session.authFailure);
                if (!session.consentGranted) {
                    return wpError('Consent required.', { code: 'wap_client_consent_required' });
                }
                return wpSuccess({ token });

            case 'wap_client_consent':
                if (params.get('op') === 'grant') session.consentGranted = true;
                return wpSuccess({ granted: session.consentGranted });

            case 'wap_client_permission_state': {
                const id = params.get('id') || '';
                if (params.get('op') === 'set') session.permissionValues[id] = params.get('value') || '';
                return wpSuccess({ value: session.permissionValues[id] ?? null });
            }

            case 'wap_client_column_state':
                if (params.get('op') === 'set') session.columnState = params.get('state');
                return wpSuccess({ state: session.columnState });

            case 'wap_client_delete_data':
                return wpSuccess({});

            default:
                this.warn(`The preview does not answer the admin-ajax action "${action}". Add it to preview/fake-wap.mjs.`);
                // What admin-ajax.php answers for an action nobody registered.
                return { status: 400, text: '0' };
        }
    }

    // ── The WAP API (py-backend/app/routes/) ──

    /**
     * @param {string} method
     * @param {URL} url
     * @param {object|null} body the parsed JSON body
     * @param {string} token the Bearer credential
     * @param {AbortSignal} [signal] aborted when the browser goes away
     */
    api(method, url, body, token, signal) {
        const session = this.session(token);
        if (!session) return json(401, { detail: 'Invalid or missing session token' });
        // The page's own origin: where the sample OAuth pop-up lives and posts back from.
        session.origin = url.origin;
        if (session.backendDown) return json(503, { detail: 'Service Unavailable' });
        if (session.expireTokenOnce) {
            session.expireTokenOnce = false;
            return json(401, { detail: 'Session expired' });
        }

        const path = url.pathname;
        const role = (body && body.agent_role) || url.searchParams.get('agent_role') || '';
        let match;

        if (method === 'GET' && path === '/api/v1/agents/welcome') return this.welcome(session, role);
        if (method === 'GET' && path === '/api/v1/chat/agents') return this.agentList(session);
        if (method === 'GET' && path === '/api/v1/chat/quota') return this.quota(session);
        if (method === 'GET' && path === '/api/v1/chat/history') {
            return this.history(session, session.agentFor(role).role, url);
        }
        if (method === 'GET' && (match = /^\/api\/v1\/chat\/([^/]+)\/history$/.exec(path))) {
            const threadRole = decodeURIComponent(match[1]).split(':').slice(1).join(':');
            return this.history(session, session.agentFor(threadRole).role, url);
        }
        if (method === 'GET' && (match = /^\/api\/v1\/chat\/[^/]+\/documents\/([^/]+)\/pdf$/.exec(path))) {
            return {
                status: 200,
                contentType: 'application/pdf',
                headers: { 'Content-Disposition': 'attachment; filename="invoice-inv-2026-014.pdf"' },
                body: samplePdf('Invoice INV-2026-014'),
            };
        }
        if (method === 'POST' && path === '/api/v1/chat/new') {
            const newRole = session.agentFor(role).role;
            session.threads.delete(newRole);
            session.paused.delete(newRole);
            return noContent();
        }
        if (method === 'POST' && path === '/api/v1/chat/stream') return this.stream(session, body || {}, signal);
        if (method === 'POST' && path === '/api/v1/chat/resume') return this.resume(session, body || {}, signal);
        if (method === 'POST' && path === '/api/v1/mcp/oauth/redeem') {
            return body && body.code === 'preview-code' ? noContent() : json(400, { detail: 'invalid_grant' });
        }
        if (method === 'POST' && path === '/api/v1/me/data/erase') {
            session.threads.clear();
            session.paused.clear();
            return noContent();
        }

        this.warn(`The preview does not answer ${method} ${path}. Add it to preview/fake-wap.mjs, in the shape py-backend answers.`);
        return json(404, { detail: 'Not Found' });
    }

    /** GET /api/v1/agents/welcome (routes/agents.py). */
    welcome(session, role) {
        const agent = session.agentFor(role);
        return json(200, {
            ...sample('welcome', { title: agent.welcomeTitle, message: agent.welcomeMessage }),
            promptSuggestions: agent.promptSuggestions.slice(0, 4),
        });
    }

    /** GET /api/v1/chat/agents (routes/chat.py, AgentRegistry.selectable_roles_for_role). */
    agentList(session) {
        const agents = session.agents
            .map((agent) => ({ ...sample('agents.entry', agent), current: agent.role === session.defaultRole }))
            .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.role.localeCompare(b.role));
        return json(200, { ...sample('agents.response', { current: session.defaultRole }), agents });
    }

    /** GET /api/v1/chat/quota (routes/chat.py, get_monthly_quota). */
    quota(session) {
        const quota = session.quota;
        if (!quota.enabled) return json(200, sample('quota.disabled'));
        return json(200, {
            ...sample('quota.enabled'),
            remaining: quota.remaining,
            total: quota.total,
            used: Math.max(0, quota.total - quota.remaining),
            resetAt: quota.resetAt,
        });
    }

    /** GET /api/v1/chat/history and /chat/{thread}/history (routes/chat.py, _read_history). */
    history(session, role, url) {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
        const response = { ...sample('history.response', { threadId: session.threadId(role) }), messages: session.thread(role).slice(-limit) };
        const paused = session.paused.get(role);
        if (paused) response.pendingQuestion = paused.event;
        return json(200, response);
    }

    /** POST /api/v1/chat/stream (routes/chat.py). */
    stream(session, body, signal) {
        const handoff = body.handoff_token ? session.handoffs.get(body.handoff_token) : null;
        const agent = session.agentFor(handoff ? handoff.targetRole : body.agent_role);
        const message = String(body.message || '');
        const reply = handoff ? REPLIES.find((r) => r.name === 'handed-over') : replyFor(message);

        if (reply.refuse) {
            const refusal = reply.refuse();
            return json(refusal.status, refusal.body);
        }
        // _check_limits: the monthly quota refuses before the agent runs.
        if (session.quota.enabled && session.quota.remaining <= 0) {
            return json(429, { detail: { ...samples().refusals.quota, resetAt: session.quota.resetAt } });
        }
        if (session.quota.enabled) session.quota.remaining -= 1;

        // A message typed while a question waits answers it (AskUserResumePolicy).
        const paused = session.paused.get(agent.role);
        if (paused && !handoff) {
            session.paused.delete(agent.role);
            return this.turn(session, agent, paused.then(message), { opening: [sample('history.user', { content: message })], signal });
        }

        const opening = handoff
            ? [sample('history.handoff', { sourceAgent: handoff.sourceAgent, content: handoff.brief })]
            : [sample('history.user', { content: message })];
        if (handoff) session.handoffs.delete(body.handoff_token);

        const steps = reply.steps(this.context(session, agent));
        return this.turn(session, agent, steps, { opening, thinking: true, media: reply.media, signal });
    }

    /** POST /api/v1/chat/resume (routes/chat.py): the answer to the question the run waits on. */
    resume(session, body, signal) {
        const agent = session.agentFor(body.agent_role);
        const paused = session.paused.get(agent.role);
        if (!paused) {
            return json(409, { detail: sample('conflicts.no_pending_question') });
        }
        session.paused.delete(agent.role);
        return this.turn(session, agent, paused.then(String(body.answer ?? '')), { signal });
    }

    context(session, agent) {
        return {
            product: session.product,
            agent,
            agents: session.agents,
            threadId: session.threadId(agent.role),
            origin: session.origin || 'http://localhost',
        };
    }

    /**
     * One streamed turn: message_start, the steps, the media, message_end, [DONE]
     * (chat_stream_runner.py, single_agent.py). What it says is kept in the thread
     * as the checkpoint would keep it, so a reload restores it; a turn that fails
     * or drops leaves nothing behind.
     */
    turn(session, agent, steps, { opening = [], thinking = false, media = null, signal } = {}) {
        const role = agent.role;
        const fake = this;

        async function* events() {
            const kept = [...opening];
            let text = '';
            const flushText = () => {
                if (!text.trim()) return;
                kept.push(media
                    ? { ...sample('history.assistantWithMedia', { content: text }), media }
                    : sample('history.assistant', { content: text }));
                text = '';
            };

            yield sse(sample('turn.message_start', { threadId: session.threadId(role), agentName: agent.displayName }));
            if (thinking) yield sse(sample('turn.status_thinking'));

            let failed = false;
            for (const step of steps) {
                if (signal && signal.aborted) return;
                await sleep((step.wait || 0) * session.pace);
                if (signal && signal.aborted) return;
                if (step.drop) return;

                const event = step.event;
                if (!event) continue;
                if (event.type === 'text_delta') {
                    text += event.delta;
                } else {
                    flushText();
                    if (event.type === 'visual') kept.push({ ...sample('history.visual'), visual: event.visual });
                    if (event.type === 'document') kept.push({ ...sample('history.document'), document: event.document });
                    if (event.type === 'agent_handoff') {
                        session.handoffs.set(event.handoffToken, {
                            targetRole: event.targetRole,
                            sourceAgent: event.sourceAgent,
                            brief: event.brief,
                        });
                    }
                    if (event.type === 'error') failed = true;
                }

                if (event.type === 'question') {
                    session.paused.set(role, { event, then: step.then || (() => []) });
                    yield sse({ ...event, threadId: session.threadId(role) });
                } else {
                    yield sse(event);
                }
            }

            if (!failed) {
                flushText();
                session.thread(role).push(...kept);
                if (media) yield sse({ type: 'media', media });
                yield sse(samples().turn.message_end);
            }
            yield SSE_DONE;
        }

        return { status: 200, stream: events() };
    }
}

/** Every reply a designer can ask for, for the corner panel. */
export function replyCatalogue() {
    return REPLIES.filter((reply) => !reply.hidden).map(({ name, words, description }) => ({
        name,
        say: words[0] || 'anything else',
        description,
    }));
}

/** Every scenario, for the corner panel. */
export function scenarioCatalogue() {
    return Object.entries(SCENARIOS).map(([name, { description }]) => ({ name, description }));
}

