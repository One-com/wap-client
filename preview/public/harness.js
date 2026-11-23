/**
 * The preview's own side of the page: the session token, the corner label that
 * switches product, place, language, case and reply, and the live reload.
 *
 * Plain DOM, outside the widget and outside Gravity on purpose: it is a tool of
 * the preview and never part of the widget. Loaded before wap-chat.js.
 */
(function () {
    'use strict';

    var preview = window.WapPreview;

    /** One id per browser tab, kept across reloads, so a reload finds the same sample conversation. */
    function tabId() {
        var fresh = Math.random().toString(36).slice(2, 10);
        try {
            var kept = window.sessionStorage.getItem('wap-preview-tab');
            if (kept) return kept;
            window.sessionStorage.setItem('wap-preview-tab', fresh);
        } catch (e) { /* storage blocked: a fresh conversation on each load */ }
        return fresh;
    }

    // Read by preview/fake-wap.mjs (PreviewToken): product, cases, tab.
    var token = ['preview', preview.product, preview.scenarios.join(','), tabId()].join('.');

    window.WapPreviewHost = {
        token: token,

        /** WordPress pages: the token travels on the ajaxUrl, where the fake admin-ajax reads it. */
        adopt: function (config) {
            config.ajaxUrl += '?preview=' + encodeURIComponent(token);
        },

        /** The SaaS host: the npm way, a getSession() backed by the host's own session route. */
        mountSaas: function (options) {
            var headers = { 'Content-Type': 'application/json', 'X-Preview-Token': token };
            window.WapChat.init(Object.assign({}, options, {
                getSession: function (opts) {
                    return fetch('/saas/session', {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify({ forceNew: !!(opts && opts.forceNew) }),
                    }).then(function (res) {
                        return res.json().then(function (data) {
                            if (!res.ok) throw new Error(data.message || 'auth failed');
                            return data;
                        });
                    });
                },
                consent: {
                    get: function () {
                        return fetch('/saas/consent', { headers: headers })
                            .then(function (res) { return res.json(); })
                            .then(function (data) { return data.granted; });
                    },
                    set: function () { return fetch('/saas/consent', { method: 'POST', headers: headers }); },
                },
            }));
        },
    };

    // ── Live reload ─────────────────────────────────────────────────────────

    /** Swap the widget's stylesheets for fresh copies, without losing the page's state. */
    function restyle() {
        document.querySelectorAll('link[rel="stylesheet"][href^="/assets/"]').forEach(function (link) {
            var next = link.cloneNode();
            var url = new URL(link.href);
            url.searchParams.set('t', String(Date.now()));
            next.href = url.pathname + url.search;
            next.onload = function () { link.remove(); };
            link.after(next);
        });
    }

    /** Resolves once the server has answered twice in a row, so a reload never lands on a restarting one. */
    function whenServerIsUp() {
        return new Promise(function (resolve) {
            var answered = 0;
            (function ping() {
                fetch('/favicon.ico', { cache: 'no-store' })
                    .then(function (res) { answered = res.ok ? answered + 1 : 0; })
                    .catch(function () { answered = 0; })
                    .then(function () {
                        if (answered >= 2) resolve();
                        else setTimeout(ping, 300);
                    });
            })();
        });
    }

    function listen() {
        if (!window.EventSource) return;
        var boot = null;
        var reloading = false;
        var reload = function () {
            if (reloading) return;
            reloading = true;
            window.location.reload();
        };

        (function connect() {
            var live = new EventSource('/preview/live');
            // A new id means the server restarted after an edit to the fake: reload to use it.
            live.addEventListener('hello', function (event) {
                if (boot && boot !== event.data) whenServerIsUp().then(reload);
                boot = event.data;
            });
            live.addEventListener('reload', reload);
            live.addEventListener('css', restyle);
            // The browser retries a dropped stream by itself, but gives up on some errors: start a new one.
            live.onerror = function () {
                if (live.readyState !== window.EventSource.CLOSED) return;
                live.close();
                setTimeout(connect, 500);
            };
        })();
    }

    // ── The corner label ────────────────────────────────────────────────────

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            if (key === 'text') node.textContent = attrs[key];
            else node.setAttribute(key, attrs[key]);
        });
        (children || []).forEach(function (child) { if (child) node.append(child); });
        return node;
    }

    /** This page's address with `changes` applied. */
    function linkTo(changes) {
        var params = new URLSearchParams(window.location.search);
        Object.keys(changes).forEach(function (key) {
            if (changes[key]) params.set(key, changes[key]);
            else params.delete(key);
        });
        var query = params.toString();
        return window.location.pathname + (query ? '?' + query : '');
    }

    function choiceRow(label, options, current, param) {
        var links = Object.keys(options).map(function (key) {
            var attrs = { href: linkTo(Object.fromEntries([[param, key]])), text: options[key] };
            if (key === current) attrs['aria-current'] = 'true';
            return el('a', attrs);
        });
        return el('div', { class: 'wap-preview__row' }, [el('span', { class: 'wap-preview__label', text: label })].concat(links));
    }

    /** Say why a reply button did nothing: in the console, and in the panel where the designer is looking. */
    function warnSend(message) {
        var note = document.querySelector('.wap-preview__warning');
        if (message) console.warn('[wap preview] ' + message);
        if (!note) return;
        note.textContent = message;
        note.hidden = !message;
    }

    /** Type `text` into the widget's composer and send it, as a person would. */
    function sendToWidget(text) {
        var box = document.querySelector('.wap-chat-root textarea');
        if (!box) return warnSend('No composer found in the widget (.wap-chat-root textarea): has its markup changed? Update sendToWidget in preview/public/harness.js, or type the message.');
        if (box.disabled) return warnSend('The composer is locked (consent gate, spent quota or no connection), so nothing was sent.');
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(box, text);
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        warnSend('');
        // The widget empties the composer when it sends; text left behind means it did not.
        setTimeout(function () {
            if (box.value === text) warnSend('The widget did not send the message: it may be busy answering, or Enter no longer sends (update sendToWidget in preview/public/harness.js).');
        }, 100);
    }

    function panel() {
        var active = preview.scenarios.length ? preview.scenarios.join(', ') : 'default';
        var summary = 'Sample data · ' + preview.products[preview.product] + ' · ' +
            preview.surfaces[preview.surface] + ' · ' + active;
        if (preview.unknownScenarios.length) summary += ' (no such case: ' + preview.unknownScenarios.join(', ') + ')';

        var cases = preview.allScenarios.map(function (scenario) {
            var on = preview.scenarios.indexOf(scenario.name) !== -1;
            var next = scenario.name === 'default' ? [] : on
                ? preview.scenarios.filter(function (name) { return name !== scenario.name; })
                : preview.scenarios.concat(scenario.name);
            var attrs = { href: linkTo({ scenario: next.join(',') }), text: scenario.name };
            if (on || (scenario.name === 'default' && !preview.scenarios.length)) attrs['aria-current'] = 'true';
            return el('li', {}, [el('a', attrs), ' ' + scenario.description]);
        });

        var replies = preview.replies.map(function (reply) {
            var send = el('button', { type: 'button', class: 'wap-preview__send', text: reply.say });
            send.addEventListener('click', function () { sendToWidget(reply.say === 'anything else' ? 'How do I speed up my site?' : reply.say); });
            return el('li', {}, [send, ' ' + reply.description]);
        });

        var restart = el('button', { type: 'button', class: 'wap-preview__restart', text: 'Start this case over' });
        restart.addEventListener('click', function () {
            fetch('/preview/reset?token=' + encodeURIComponent(token), { method: 'POST' })
                .then(function () { window.location.reload(); });
        });

        var locales = {};
        preview.locales.forEach(function (locale) { locales[locale] = locale; });

        return el('details', { id: 'wap-preview', class: 'wap-preview' }, [
            el('summary', { text: summary }),
            el('div', { class: 'wap-preview__body' }, [
                choiceRow('Product', preview.products, preview.product, 'product'),
                choiceRow('Place', preview.surfaces, preview.surface, 'surface'),
                choiceRow('Language', locales, preview.locale, 'locale'),
                el('h2', { text: 'Cases (combine them)' }),
                el('ul', {}, cases),
                el('h2', { text: 'Replies: a message starting with the word gets that reply' }),
                el('ul', {}, replies),
                el('p', { class: 'wap-preview__warning', hidden: '' }),
                el('p', {}, [restart]),
                el('p', { class: 'wap-preview__note', text: 'Sample data from preview/, not the real assistant. ' +
                    'How it behaves with real data: deploy the branch to the test environment.' }),
            ]),
        ]);
    }

    document.addEventListener('DOMContentLoaded', function () {
        // ?panel=off leaves the corner label out, for screenshots that show only the page.
        if (new URLSearchParams(window.location.search).get('panel') !== 'off') document.body.append(panel());
        listen();
    });
})();
