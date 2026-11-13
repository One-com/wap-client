/**
 * The cases the preview can start in, chosen with ?scenario= and combined with
 * commas (?scenario=returning,quota-low). Each changes the sample session before
 * the page loads: what the fake answers (the conversation, the quota, a failing
 * call) or what the page passes the widget. A new case is one entry here.
 *
 * Keep a case to what the real backend or WordPress could answer: the shapes
 * are the ones replies.mjs and fake-wap.mjs already send.
 */

import { lineChart, sample, say } from './replies.mjs';

/** Milliseconds from now to the first day of next month, 00:00, as /chat/quota's resetAt. */
function nextMonth() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
}

export const SCENARIOS = {
    default: {
        description: 'A user who accepted the terms and has not chatted yet: the welcome screen.',
        apply: () => {},
    },
    'first-visit': {
        description: 'The terms consent gate, shown before the first chat.',
        apply: (session) => {
            session.consentGranted = false;
        },
    },
    returning: {
        description: 'A past conversation, restored from history: text, a chart and an invoice.',
        apply: (session) => {
            const user = (content) => sample('history.user', { content });
            const assistant = (content) => sample('history.assistant', { content });
            const threadIdPath = encodeURIComponent(session.threadId(session.defaultRole));
            session.seed(session.defaultRole, [
                user('How did my mobile score change since I turned on Delay JS?'),
                assistant('It rose from **48 to 82** in eight weeks. Here is the trend:'),
                { ...sample('history.visual'), visual: lineChart() },
                user('Great. Can you make an invoice for the audit I did for Acme?'),
                assistant('Here it is. Check the line items before you send it.'),
                { ...sample('history.document'), document: sample('document', { threadIdPath }) },
            ]);
        },
    },
    'paused-question': {
        description: 'A conversation left on an unanswered question: the card comes back on reload.',
        apply: (session) => {
            session.seed(session.defaultRole, [
                sample('history.user', { content: 'Make my homepage lighter' }),
                sample('history.assistant', { content: 'I can lighten your homepage in a few ways.' }),
            ]);
            session.pause(session.defaultRole, sample('questions.choose'), (answer) => say(`Done: **${answer}** is on.`));
        },
    },
    'quota-low': {
        description: 'Three messages left this month: the quota warning above the composer.',
        apply: (session) => {
            session.quota = { enabled: true, total: 50, remaining: 3, resetAt: nextMonth() };
        },
    },
    'quota-spent': {
        description: 'No messages left this month: the composer is locked and sending is refused.',
        apply: (session) => {
            session.quota = { enabled: true, total: 50, remaining: 0, resetAt: nextMonth() };
        },
    },
    'no-quota': {
        description: 'The monthly limit is switched off on the backend (/chat/quota answers enabled: false).',
        apply: (session) => {
            session.quota = { enabled: false };
        },
    },
    'one-agent': {
        description: 'Only one agent in the family: no agent picker in the composer.',
        apply: (session) => {
            session.agents = session.agents.slice(0, 1);
        },
    },
    'no-welcome': {
        description: 'The agent has no welcome text set: the widget falls back to its own.',
        apply: (session) => {
            session.agents = session.agents.map((agent) => ({
                ...agent, welcomeTitle: '', welcomeMessage: '', promptSuggestions: [],
            }));
        },
    },
    'expired-token': {
        description: 'The first call finds the session expired (401): the widget gets a new one, unseen.',
        apply: (session) => {
            session.expireTokenOnce = true;
        },
    },
    'sign-in-fails': {
        description: 'WordPress cannot get a session for the assistant: the widget cannot connect.',
        apply: (session) => {
            session.authFailure = 'The assistant is unavailable right now. Please try again later.';
        },
    },
    'backend-down': {
        description: 'The WAP backend answers 503 to everything.',
        apply: (session) => {
            session.backendDown = true;
        },
    },
    slow: {
        description: 'Everything streams four times slower, to look at loading states.',
        apply: (session) => {
            session.pace = 4;
        },
    },
    instant: {
        description: 'No streaming delays: each reply arrives at once. Handy for screenshots.',
        apply: (session) => {
            session.pace = 0;
        },
    },
};

export const DEFAULT_SCENARIO = 'default';

/** The scenarios a comma list names, in order, and the names that are none. */
export function namedScenarios(list) {
    const asked = String(list || '').split(',').map((name) => name.trim()).filter(Boolean);
    return {
        chosen: asked.filter((name) => Object.hasOwn(SCENARIOS, name)),
        unknown: asked.filter((name) => !Object.hasOwn(SCENARIOS, name)),
    };
}
