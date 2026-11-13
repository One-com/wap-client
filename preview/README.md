# Widget preview

The chat widget on sample data: no backend, no WordPress, no sign in, no VPN and nothing to
install. For anyone changing how the widget looks or reads, designers included (they work through
`/designer`, `.claude/skills/designer/` at the repository root).

```bash
cd wp-client-plugin/wap-client
npm run preview          # http://localhost:4100 (PORT=4101 npm run preview for another port)
```

It needs Node 20 or newer. It serves `assets/wap-chat.js` and `wap-chat.css` as they are on disk,
and listens on 127.0.0.1 only. Plain Node, no dependencies.

## What happens when you edit a file

| You edit | What happens |
|---|---|
| A stylesheet in `assets/` (`wap-chat.css`) | The stylesheet is swapped in place. No reload. |
| `assets/wap-chat.js`, any other file of `assets/`, and everything in `preview/public/` (the corner label's `harness.css` and `harness.js` included) | The open page reloads. The sample conversation survives: it is kept per browser tab. |
| `preview/samples.json` | The file is read again on the next request (its modification time is checked), and the open page reloads. The server does not restart. |
| `includes/*.php`, `i18n/*.po` | They are read again on every page load, with no cache, and the open page reloads. |
| Any other `preview/*.mjs` (replies, scenarios, the fake, pages, products, the server) | `node --watch` restarts the server, because these files are in its import graph. Every sample session starts over. The open page sees the new server, waits until it answers, and reloads. |

## What it shows

The address picks the page, and the label in the bottom-left corner lists every choice (on a
phone it is a small pill in the bottom-right corner):

| Parameter | Values | What changes |
|---|---|---|
| `surface` | `page` (default), `column`, `embed`, `standalone`, `saas` | Where the widget is mounted: the admin page, the docked column, an inline embed in a settings tab, a standalone page, or a SaaS host mounting it the npm way |
| `product` | `wp-rocket` (default), `rankmath`, `onecom` | Gravity brand, agents, welcome screen, permission rows |
| `locale` | `en_US` and every `i18n/*.po` | The strings WordPress hands over in that language |
| `scenario` | see `scenarios.mjs`, joined by commas | The case: a past conversation, the consent gate, a low or spent quota, a paused question, a failing sign in… |
| `panel` | `off` | Leaves the corner label out, for screenshots |

A message starting with a reply's word gets that reply (`chart`, `stats`, `invoice`, `question`,
`permission`, `connect`, `handoff`, `image`, `error`, `dropped`… listed in the corner label, which
also sends them). Any other message gets an ordinary answer.

The wp-admin around the widget uses WordPress core's admin stylesheets (from jsDelivr, pinned),
and the widget is mounted with the markup, scripts and `WapClientConfig` that
`includes/class-chat-widget.php` produces.

## What it is not

The samples have the shapes WAP sends, but they are not WAP: real answers, their length and
timing, and the model's choices differ. Look at the admin chat tester on the test environment
before calling a design right.

## What is read and what is restated

Read from the source files on every page load:

- the strings (`$i18n_defaults` in `includes/class-chat-widget.php`, translated through `i18n/*.po`)
  and the default prompt suggestions;
- the layout each surface adds (`COLUMN_LAYOUT`, `EMBED_LAYOUT`, `STANDALONE_LAYOUT`);
- the plugin version (`wap-client.php`);
- the Gravity version: the PHP's for the WordPress surfaces, `GRAVITY_VERSION` in `assets/wap-chat.js`
  for the SaaS host.

Restated by hand, so they can drift:

- The `WapClientConfig` values `page.mjs` writes: its keys are compared with the PHP's by `npm test`,
  the values are not. Examples: the Mixpanel host and application defaults, the column's side, mode
  and width, `userInitial`, `timeFormat` per locale.
- The mount point markup, its ids and the column wrapper in `page.mjs`: compared with
  `render_chat_root()` and the column and embed classes by `npm test`.
- The SaaS host's layout (`SURFACES.saas` in `page.mjs`), copied from the npm example in
  `docs/wap-client-overview.md`. Nothing compares it.
- The wp-admin chrome (menu, toolbar, footer, the product screens beside the column and in the
  embed's tab): an approximation of core's markup. Nothing compares it.
- The products in `products.mjs`: agents and welcome copy follow `py-backend/seed.py`, the Rank Math
  permission rows follow RKM-2081. Nothing compares them.

## How it is kept true

| File | Holds | Held by |
|---|---|---|
| `samples.json` | Every payload and answer shape the fake sends: charts, question cards, handoffs, documents, media, status keys, refusals, the history response and its entries, the agent list, the quota, the welcome text, `message_start`, the 409 on resume | `py-backend/tests/test_widget_preview_samples.py` rebuilds each one through the backend's own code (`visual_payload`, `AskUserPayload`, `SseProjector`, `ChatTurnStream`, `flatten_history_for_ui`, `AgentRegistry`, the chat and welcome routes…) |
| `replies.mjs` | The replies: which word triggers them, their steps and wording | `npm/test-widget.mjs` replays every one through `wap-chat.js` |
| `scenarios.mjs` | The cases | Same: every case is loaded in the widget |
| `fake-wap.mjs` | The answers to each WAP endpoint and admin-ajax action | `npm/test-widget.mjs` fails when the widget calls an endpoint or an admin-ajax action, or handles a stream event, that the fake does not cover |
| `page.mjs`, `wp-source.mjs` | The host pages, read from the PHP | `npm/test-widget.mjs` compares the config keys, the strings, the suggestions, the mount points and the Gravity version with the PHP, in both directions |
| `products.mjs` | The products | Nothing: see above |

So when the backend changes a payload, `pytest` names the sample to update; when the widget starts
handling a new event or calling a new endpoint, `npm test` asks for its sample; when the PHP
changes what it hands the widget, `npm test` names the file to update. Adding a case or a reply is
one entry in `scenarios.mjs` or `replies.mjs`; a new payload shape goes in `samples.json`, where
the backend test checks it.

The backend test reads `samples.json` from the repository, which the `py-app` container does not
mount (only `./py-backend`): there it is skipped. In CI it must run, so a missing file fails it.

## What stays unchecked

These shapes are written by hand in the fake and held only on the widget side (`npm test` replays
them). Checking them needs a change to `py-backend/app/` or heavy fixtures.

- `GET /chat/{thread}/documents/{id}/pdf`: the response headers and the PDF body. The backend renders
  it with its PDF stack; the fake builds a one-page file.
- The `error` stream events (`errors.failed`, `errors.timeout`): the backend writes them as inline
  dicts in `chat_stream_runner.py`, with no builder to call.
- The `text_delta` and `tool_result` stream events: plain dicts, and the widget draws nothing for the
  result.
- The bodies of the 401 (session expired or invalid), 503 and 404 answers, and the 400 `invalid_grant`
  of `/mcp/oauth/redeem`: they come from the auth dependency and the OAuth route, which need the
  whole app to run.
- `POST /chat/new`, `/mcp/oauth/redeem` and `/me/data/erase` answer an empty 204: the widget does not
  read their bodies.
- The admin-ajax answers: they are WordPress's, in PHP, so `py-backend` cannot hold them.
- `/saas/session` and `/saas/consent`: the preview's own stand-in for a SaaS host's backend.
- A WAP path the widget writes in pieces, such as `'/api/' + 'v1/chat/'`: the endpoint test fails on a path it cannot read whole (`api/v` without `api/v1`), but not on one split elsewhere.
- The `routing` stream event: the widget handles it, but nothing in `py-backend/app` sends it, so no
  reply sends it either (`WIDGET_ONLY` in `npm/test-widget.mjs`).

`preview/` is development-only: `.gitattributes` keeps it out of the Composer package and
`scripts/check-dist-contents.sh` asserts it; the npm package ships `dist/` only.
