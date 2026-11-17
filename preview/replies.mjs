/**
 * What the sample assistant answers: each reply is the list of steps one turn
 * streams, with its payloads in samples.json. Plain data and small functions,
 * replayed through the real widget by npm/test-widget.mjs.
 * How replies are chosen and checked: preview/README.md.
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * A reader of the samples file at `file`: its parsed content, read again whenever
 * the file changed on disk, so an edit shows on the next request without
 * restarting the server. A file that does not parse (saved half-way through an
 * edit) keeps the last good copy and says so.
 *
 * @param {URL|string} file
 */
export function samplesReader(file) {
    let loaded = { modified: -1, data: null };
    return () => {
        const modified = statSync(file).mtimeMs;
        if (modified === loaded.modified) return loaded.data;
        try {
            loaded = { modified, data: JSON.parse(readFileSync(file, 'utf8')) };
        } catch (error) {
            if (!loaded.data) throw error;
            console.warn(`The samples file does not parse (${error.message}); keeping the last good copy.`);
            loaded = { ...loaded, modified };
        }
        return loaded.data;
    };
}

/** samples.json, as the replies and the fake read it. */
export const samples = samplesReader(new URL('./samples.json', import.meta.url));

// ── Samples ─────────────────────────────────────────────────────────────────

function fill(value, vars) {
    if (typeof value === 'string') {
        return value.replace(/\{([a-zA-Z.]+)\}/g, (token, key) => (key in vars ? String(vars[key]) : token));
    }
    if (Array.isArray(value)) return value.map((item) => fill(item, vars));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, vars)]));
    }
    return value;
}

/** The sample at `path` in samples.json ("visuals.line"), its {placeholders} filled from `vars`. */
export function sample(path, vars = {}) {
    const value = path.split('.').reduce((node, key) => (node ? node[key] : undefined), samples());
    if (value === undefined) throw new Error(`preview/samples.json has no "${path}".`);
    return fill(value, vars);
}

/** The values samples.json's placeholders stand for, in one turn. */
export function placeholders({ product, agent, agents = [], threadId, origin }) {
    const target = agents.find((candidate) => candidate.role !== agent.role) || agent;
    const vars = { product: product.slug, origin, threadId, threadIdPath: encodeURIComponent(threadId) };
    for (const [prefix, who] of [['source', agent], ['target', target]]) {
        for (const field of ['role', 'agentId', 'name', 'displayName']) vars[`${prefix}.${field}`] = who[field];
    }
    return vars;
}

/** Weeks ending on the last few Mondays, so the sample chart always reads as recent. */
function lastWeeks(count) {
    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    return Array.from({ length: count }, (_, i) => {
        const day = new Date(monday);
        day.setDate(monday.getDate() - (count - 1 - i) * 7);
        return day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });
}

/** The line chart sample, dated up to this week. */
export function lineChart() {
    const chart = sample('visuals.line');
    return { ...chart, categories: lastWeeks(chart.categories.length) };
}

// ── Steps: one helper per event the backend emits ───────────────────────────

/** Milliseconds between two streamed pieces of text, about a model's pace. */
const TOKEN = 28;

/** The pieces a model streams: each word with the whitespace before it. */
export function chunk(text) {
    return text.match(/\s*\S+|\s+$/g) || [];
}

/** Streamed text: text_delta events (app/agents/sse_projector.py, _project_ai_chunk). */
export function say(markdown) {
    return chunk(markdown).map((delta, i) => ({ wait: i === 0 ? 300 : TOKEN, event: { type: 'text_delta', delta } }));
}

/**
 * A tool call: tool_use, then the status line the widget shows for it
 * (sse_projector.py). The status key is samples.json's `tools` entry, which the
 * backend test holds to status_key().
 */
function toolCall(name, input) {
    const key = samples().tools[name];
    if (!key) throw new Error(`preview/samples.json has no status key for the tool "${name}": add it under "tools".`);
    return [
        { wait: 450, event: { type: 'tool_use', tool: name, input } },
        { wait: 0, event: { type: 'status', phase: 'tool', key } },
    ];
}

/** A tool call and, a moment later, its result (sse_projector.py). The widget draws nothing for the result. */
export function tool(name, input = {}) {
    return [...toolCall(name, input), { wait: 1100, event: { type: 'tool_result', tool: name, output: 'ok' } }];
}

/**
 * A chart, a row of figures or an HTML block. The backend sends the visual in
 * place of render_visual's tool result (sse_projector.py, _project_visual).
 */
export function visual(payload) {
    return [...toolCall('render_visual', { kind: payload.kind, title: payload.title }), { wait: 900, event: { type: 'visual', visual: payload } }];
}

/**
 * A question that pauses the run (interrupt_payloads.AskUserPayload.to_sse_event).
 * `then(answer)` gives the steps the run goes on with once /chat/resume brings the answer.
 */
export function ask(event, then) {
    return [{ wait: 500, event, then }];
}

// ── Prose ───────────────────────────────────────────────────────────────────

const ANSWERS = {
    performance: `Your homepage takes **3.4 s** to show its main content on mobile. Three things account for most of it:

1. **Render-blocking CSS.** Two stylesheets load before anything paints. *Remove unused CSS* would cut them to what the page uses.
2. **Heavy images.** The hero image weighs 1.8 MB. With *LazyLoad* on, the images below the fold wait until the visitor scrolls.
3. **Third-party scripts.** The chat and analytics scripts run before your content. *Delay JavaScript execution* holds them until the visitor interacts.

Want me to turn on the first two? You can undo either one from **WP Rocket → Settings** at any time.`,
    seo: `Your homepage scores **72/100**. Three fixes would lift it the most:

1. **Focus keyword missing from the title.** "Handmade ceramics" is in your content but not in the SEO title.
2. **Meta description too short.** It is 64 characters long; aim for 120 to 160.
3. **No internal links.** Link to two or three of your product pages from the homepage copy.

Shall I draft a new title and meta description for you to review?`,
    general: `Here is where your site stands:

- **WordPress 6.9** is up to date.
- **3 plugins** have updates waiting: Contact Form 7, Yoast Duplicate Post and Redirection.
- **Backups** ran last night at 02:00 and finished in 4 minutes.

Shall I update the three plugins? I will make a backup first.`,
};

const LONG = `## How caching makes your site faster

When a visitor opens a page, WordPress normally builds it from scratch: it runs PHP, queries the database and assembles the HTML. **Page caching** keeps a copy of that finished HTML, so the next visitor gets it straight away.

### What WP Rocket caches

| What | Where it is kept | How long |
| --- | --- | --- |
| Pages and posts | \`wp-content/cache/wp-rocket\` | 10 hours by default |
| Minified CSS and JavaScript | \`wp-content/cache/min\` | Until the next change |
| Critical path CSS | \`wp-content/cache/critical-css\` | Until the next change |

### When the cache is cleared

The cache of a page is cleared automatically when you:

- publish or update it,
- add or approve a comment on it,
- change a widget or a menu it shows.

> Clearing the whole cache makes the next visits slower for a moment, until each page is cached again. The *Preload* option rebuilds it in the background.

### Excluding a page

Some pages must never be cached, such as a cart or a member area. Add their address under **Cache → Cache Rules → Never Cache URL(s)**, one per line:

\`\`\`
/cart/
/my-account/(.*)
\`\`\`

Developers can do the same in code:

\`\`\`php
add_filter( 'rocket_cache_reject_uri', function ( $uris ) {
    $uris[] = '/cart/';
    return $uris;
} );
\`\`\`

---

That covers the basics. Ask me about any of these settings and I can check how they are set on your site.`;

// ── The catalogue ───────────────────────────────────────────────────────────

/**
 * Each reply: `name` and `words` (what to type), `description` (what it shows),
 * and `steps(ctx)`, where ctx is {product, agent, agents, threadId, origin}.
 * `refuse()`, instead of steps, answers the request itself with an HTTP error
 * before any stream starts. `media` is what the backend approves for display.
 */
export const REPLIES = [
    {
        name: 'answer',
        words: [],
        description: 'Anything else: two working steps, then a formatted answer.',
        steps: ({ product }) => [
            ...tool('mcp-adapter-discover-abilities'),
            ...tool('mcp-adapter-execute-ability', { ability_name: `${product.slug}/get-settings` }),
            ...say(ANSWERS[product.flavour] || ANSWERS.general),
        ],
    },
    {
        name: 'short',
        words: ['short', 'hello', 'thanks'],
        description: 'A one-line answer, no working steps.',
        steps: () => say("You're welcome! Ask me anything else about your site whenever you need."),
    },
    {
        name: 'long',
        words: ['long', 'article'],
        description: 'A long answer: headings, a table, a quote, code blocks. Scrolls the chat.',
        steps: () => [...tool('web_fetch'), ...say(LONG)],
    },
    {
        name: 'steps',
        words: ['steps', 'tools'],
        description: 'Six working steps in a row before a short answer.',
        steps: () => [
            ...['mcp-adapter-discover-abilities', 'get_options', 'web_search', 'web_fetch', 'update_option', 'check_status']
                .flatMap((name) => tool(name)),
            ...say('Done. I checked your settings, read the documentation, and turned on **Preload cache**.'),
        ],
    },
    {
        name: 'chart',
        words: ['chart', 'line'],
        description: 'A line chart with two series, then a sentence about it.',
        steps: () => [
            ...visual(lineChart()),
            ...say('Your mobile score rose **34 points** in eight weeks, most of it the week *Delay JavaScript execution* went on.'),
        ],
    },
    {
        name: 'bars',
        words: ['bars', 'bar'],
        description: 'A bar chart with a unit.',
        steps: () => [
            ...visual(sample('visuals.bars')),
            ...say('The homepage is the slowest. Its hero image is the largest element; compressing it would help most.'),
        ],
    },
    {
        name: 'gauge',
        words: ['gauge'],
        description: 'A score gauge.',
        steps: () => [...visual(sample('visuals.gauge')), ...say('**82** is a good score. The next step up is fixing layout shifts.')],
    },
    {
        name: 'stats',
        words: ['stats', 'kpi'],
        description: 'A row of figures, good, warning, bad and neutral.',
        steps: () => [...visual(sample('visuals.stats')), ...say('Layout shift is the one to fix: an ad slot pushes the page down as it loads.')],
    },
    {
        name: 'html',
        words: ['html'],
        description: 'A free-form HTML visual, drawn in a sealed frame.',
        steps: () => [...visual(sample('visuals.html')), ...say('All three changes are live. The cache was cleared so visitors get the new version.')],
    },
    {
        name: 'invoice',
        words: ['invoice', 'document'],
        description: 'A generated invoice: a card with a preview and a PDF download.',
        steps: (ctx) => [
            ...say('Here is the invoice for Acme Ceramics. Check the line items before you send it.'),
            { wait: 1200, event: { type: 'document', document: sample('document', placeholders(ctx)) } },
        ],
    },
    {
        name: 'image',
        words: ['image'],
        description: 'An answer with an image from the documentation, shown inline.',
        steps: () => [
            ...tool('web_fetch'),
            ...say(`The settings moved in WP Rocket 3.24. This is the new dashboard:\n\n![The WP Rocket dashboard](${samples().media.image.images[0]})\n\nLazyLoad is now under **Page Optimization → Image & Media**.`),
        ],
        get media() { return samples().media.image; },
    },
    {
        name: 'video',
        words: ['video'],
        description: 'An answer with a YouTube video, shown as a card.',
        steps: () => say(`This short video walks through the new dashboard:\n\nhttps://www.youtube.com/watch?v=${samples().media.video.videos[0]}\n\nEvery setting you had before is still there, in the places the video shows.`),
        get media() { return samples().media.video; },
    },
    {
        name: 'question',
        words: ['question'],
        description: 'A question with three options and a free-text answer.',
        steps: () => [
            ...say('I can lighten your homepage in a few ways.'),
            ...ask(sample('questions.choose'), (answer) => [
                ...tool('update_option'),
                ...say(`Done: **${answer}** is on. Reload your homepage in a private window to see the difference.`),
            ]),
        ],
    },
    {
        name: 'multi',
        words: ['multi'],
        description: 'A question where several options can be picked.',
        steps: () => ask(sample('questions.multi'), (answer) => say(`Noted. I will keep these out of the cache: **${answer}**.`)),
    },
    {
        name: 'permission',
        words: ['permission'],
        description: 'The assistant asks before running one action: Allow or Don’t allow.',
        steps: (ctx) => [
            ...say('I can turn that on for you.'),
            ...ask(sample('questions.permission', placeholders(ctx)), (answer) => (answer === 'reject'
                ? say('OK, I left everything as it was.')
                : [...tool('mcp-adapter-execute-ability', { ability_name: `${ctx.product.slug}/update-settings` }), ...say('Done. **LazyLoad** is on.')])),
        ],
    },
    {
        name: 'permissions',
        words: ['permissions'],
        description: 'The assistant asks before running several actions at once.',
        steps: (ctx) => ask(sample('questions.permissions', placeholders(ctx)), (answer) => say(answer === 'reject'
            ? 'OK, nothing was changed.'
            : 'All three are done. Your cache is rebuilding in the background.')),
    },
    {
        name: 'connect',
        words: ['connect'],
        description: 'The assistant needs another service: an Authorize card and a sample sign-in pop-up.',
        steps: (ctx) => ask(sample('questions.connect', placeholders(ctx)), (answer) => (answer === 'cancel'
            ? say('No problem. I can still help with what is on your site itself.')
            : [...tool('search_insights_query'), ...say('Connected. Your site got **1,284 clicks** from search last week, up 12%.')])),
    },
    {
        name: 'handoff',
        words: ['handoff'],
        description: 'The assistant suggests another agent of the family, and switches on Accept.',
        steps: (ctx) => {
            if (ctx.agents.length < 2) {
                return say('This product has a single agent, so there is no one to hand over to. Try the **handoff** reply with WP Rocket.');
            }
            const vars = placeholders(ctx);
            return ask(sample('questions.handoff', vars), (answer) => (answer === 'handoff-decline'
                ? say('Sure, let’s keep going here.')
                : [{ wait: 300, event: sample('handoff', vars) }]));
        },
    },
    {
        // Never typed: the fake answers with it when an accepted handoff sends
        // the widget to the target agent's /chat/stream with a handoff_token.
        name: 'handed-over',
        words: [],
        hidden: true,
        description: 'The target agent picks up after an accepted handoff.',
        steps: () => [
            ...visual(lineChart()),
            ...say('I measured your homepage every week. Mobile went from **48 to 82** since *Delay JavaScript execution* went on; the remaining gap is the hero image.'),
        ],
    },
    {
        name: 'error',
        words: ['error'],
        description: 'The reply starts, then fails with a reference number.',
        steps: () => [
            ...tool('mcp-adapter-discover-abilities'),
            ...say('Let me look at your'),
            { wait: 600, event: { ...sample('errors.failed'), timestamp: new Date().toISOString() } },
        ],
    },
    {
        name: 'timeout',
        words: ['timeout'],
        description: 'The reply times out (the backend’s stream_timeout).',
        steps: () => [...tool('web_fetch'), { wait: 2500, event: sample('errors.timeout') }],
    },
    {
        name: 'dropped',
        words: ['dropped'],
        description: 'The connection drops mid-answer, with no end to the stream.',
        steps: () => [...say('Here is what I found on your homepage: the'), { wait: 400, drop: true }],
    },
    {
        name: 'too-fast',
        words: ['too-fast'],
        description: 'Too many messages in a minute: the backend refuses with a 429.',
        refuse: () => ({ status: 429, body: { detail: { ...sample('refusals.rate'), resetAt: Date.now() + 45_000 } } }),
    },
];

/**
 * The reply a message asks for: the one whose word starts it ("chart", or
 * "chart of my scores"), else the default answer. Only the first word counts,
 * so an ordinary question such as "why is my site slow?" gets an ordinary answer.
 */
export function replyFor(message) {
    const first = String(message).trim().toLowerCase().replace(/^\//, '').split(/[^a-z0-9-]+/)[0] || '';
    return REPLIES.find((reply) => reply.words.includes(first)) || REPLIES[0];
}
