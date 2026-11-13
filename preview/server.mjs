#!/usr/bin/env node
/**
 * `npm run preview`: the chat widget on sample data, with no backend and no
 * WordPress. Plain Node, no dependencies, listening on 127.0.0.1 only.
 * What it serves and how it is kept true: preview/README.md.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, watch } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { describeChange } from './changes.mjs';
import { FakeWap } from './fake-wap.mjs';
import { pageOptions, renderPage } from './page.mjs';
import { resolveStatic } from './static-path.mjs';
import { WordPressSource } from './wp-source.mjs';

const previewRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(previewRoot, '..');
const PORT = Number(process.env.PORT) || 4100;
const HOST = '127.0.0.1';

const wordpress = new WordPressSource(packageRoot);
const fake = new FakeWap({ warn: (line) => console.warn(`\x1b[33m! ${line}\x1b[0m`) });
/** Changes on every start, so an open page notices the server restarted and reloads. */
const BOOT = randomUUID();

const TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
};

/** The two folders the browser may read: the widget's assets and the preview's own page files. */
const STATIC = {
    '/assets/': join(packageRoot, 'assets'),
    '/preview/': join(previewRoot, 'public'),
};

function send(res, status, body = '', headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
    res.end(body);
}

function sendJson(res, status, value) {
    send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json' });
}

/** A file under one of the STATIC folders, never outside it. */
function serveStatic(res, pathname) {
    const target = resolveStatic(pathname, STATIC);
    if (!target) return false;
    if (target.status) {
        send(res, target.status, target.status === 400 ? 'Bad request' : 'Forbidden');
        return true;
    }
    try {
        if (!statSync(target.file).isFile()) return false;
        send(res, 200, readFileSync(target.file), { 'Content-Type': TYPES[extname(target.file)] || 'application/octet-stream' });
    } catch {
        send(res, 404, 'Not found');
    }
    return true;
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

/** Writes what the fake answered: JSON, a body, plain text, nothing, or a stream. */
async function reply(res, answer) {
    if (answer.stream) {
        res.writeHead(answer.status, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for await (const chunk of answer.stream) {
            if (res.destroyed) break;
            res.write(chunk);
        }
        return res.end();
    }
    if (answer.json !== undefined) return sendJson(res, answer.status, answer.json);
    if (answer.body !== undefined) return send(res, answer.status, answer.body, { 'Content-Type': answer.contentType, ...answer.headers });
    if (answer.text !== undefined) return send(res, answer.status, answer.text, { 'Content-Type': 'text/plain' });
    return send(res, answer.status);
}

// ── Live reload ─────────────────────────────────────────────────────────────

const listeners = new Set();

function broadcast(event, data = '') {
    for (const res of listeners) res.write(`event: ${event}\ndata: ${data}\n\n`);
}

function watchForChanges() {
    let timer = null;
    let pending = new Set();
    const flush = () => {
        const change = describeChange([...pending]);
        pending = new Set();
        broadcast(change.event, change.data);
        console.log(change.line);
    };
    /** `folder` is relative to the package root, and `only` limits a folder to one file. */
    const onChange = (folder, only) => (_type, name) => {
        if (!name || name.startsWith('.') || (only && name !== only)) return;
        pending.add(join(folder, name));
        clearTimeout(timer);
        timer = setTimeout(flush, 120);
    };
    // The widget, the preview's page files, and where WordPress's strings come from.
    for (const folder of ['assets', 'preview/public', 'includes', 'i18n']) {
        watch(join(packageRoot, folder), onChange(folder));
    }
    // The samples are data, not code: node --watch does not restart on them, so the page is told.
    watch(join(packageRoot, 'preview'), onChange('preview', 'samples.json'));
}

// ── Routes ──────────────────────────────────────────────────────────────────

async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/') {
        const options = pageOptions(url.searchParams, wordpress.locales());
        const html = renderPage(options, { packageRoot, wordpress, origin: url.origin });
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    }

    if (req.method === 'GET' && pathname === '/preview/live') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`retry: 500\nevent: hello\ndata: ${BOOT}\n\n`);
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return undefined;
    }

    if (req.method === 'POST' && pathname === '/preview/reset') {
        fake.reset(url.searchParams.get('token'));
        return send(res, 204);
    }

    if (req.method === 'GET' && serveStatic(res, pathname)) return undefined;

    // WordPress: the widget posts its form-encoded actions here.
    if (req.method === 'POST' && pathname === '/wp-admin/admin-ajax.php') {
        const params = new URLSearchParams(await readBody(req));
        return reply(res, fake.ajax(params, url.searchParams.get('preview')));
    }

    // The SaaS host's own backend (docs/integrating-a-saas-host.md): it mints the
    // session the npm widget asks for, and keeps the consent.
    if (pathname === '/saas/session' && req.method === 'POST') {
        const token = req.headers['x-preview-token'];
        const answer = fake.ajax(new URLSearchParams({ action: 'wap_client_auth' }), token);
        const data = answer.json && answer.json.data;
        if (!answer.json || !answer.json.success) {
            return sendJson(res, 502, { message: (data && data.message) || 'The assistant is unavailable right now. Please try again.' });
        }
        return sendJson(res, 200, { token: data.token });
    }
    if (pathname === '/saas/consent') {
        const op = req.method === 'POST' ? 'grant' : 'get';
        const answer = fake.ajax(new URLSearchParams({ action: 'wap_client_consent', op }), req.headers['x-preview-token']);
        return sendJson(res, 200, { granted: !!(answer.json && answer.json.data && answer.json.data.granted) });
    }

    if (pathname.startsWith('/api/v1/')) {
        const raw = req.method === 'POST' ? await readBody(req) : '';
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
        const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const aborted = new AbortController();
        res.on('close', () => aborted.abort());
        return reply(res, fake.api(req.method, url, body, token, aborted.signal));
    }

    if (pathname === '/favicon.ico') return send(res, 204);
    if (pathname.startsWith('/wp-json/')) return sendJson(res, 404, { code: 'rest_no_route' });
    return send(res, 404, 'Not found');
}

const server = createServer((req, res) => {
    route(req, res).catch((error) => {
        console.error(error);
        if (!res.headersSent) send(res, 500, String(error && error.stack));
        else res.end();
    });
});

server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use: is a preview already running? Stop it, or pick another port: PORT=4101 npm run preview`);
        process.exit(1);
    }
    throw error;
});

server.listen(PORT, HOST, () => {
    watchForChanges();
    const base = `http://localhost:${PORT}`;
    console.log(`\nwap-client preview on ${base}  (sample data, nothing real)\n`);
    console.log(`  ${base}/                          WP Rocket, admin page`);
    console.log(`  ${base}/?surface=column           docked column`);
    console.log(`  ${base}/?product=rankmath         Rank Math`);
    console.log(`  ${base}/?scenario=returning       a conversation to come back to`);
    console.log('\n  The corner label lists every product, place, language, case and reply.\n');
});
