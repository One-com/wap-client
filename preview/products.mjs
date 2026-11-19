/**
 * The products the preview can play, and what each one's assistant looks like
 * from the widget: its Gravity brand, its agents, their welcome screens, and the
 * host options its WordPress page passes.
 *
 * Agents and welcome copy follow py-backend/seed.py, the data a fresh local
 * stack starts with. Role, agentId, name and displayName are the fields
 * GET /api/v1/chat/agents answers (AgentRegistry.selectable_roles_for_role);
 * displayName is "{family} {name}", as AgentDefinition.display_name builds it.
 *
 * Links point at `.example` hosts: this is sample data, never a real address.
 */

/** A stable, obviously fake agent id. */
const agentId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function agent(n, familyName, name, role, welcome = {}) {
    return {
        role,
        agentId: agentId(n),
        name,
        familyName,
        displayName: `${familyName} ${name}`,
        welcomeTitle: welcome.title || '',
        welcomeMessage: welcome.message || '',
        promptSuggestions: welcome.suggestions || [],
    };
}

/**
 * Rows of the settings sheet's Permissions section, as a host passes them
 * (see WapPermissionRow in npm/widget.d.ts). Rank Math ships these (RKM-2081).
 */
const RANKMATH_PERMISSIONS = [
    {
        id: 'manage-plugin',
        label: 'Manage your Rank Math plugin',
        options: [{ value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }],
        defaultValue: 'deny',
        hint: 'Let the assistant change Rank Math settings when you ask it to.',
    },
    {
        id: 'manage-site',
        label: 'Manage your WordPress website',
        options: [{ value: 'deny', label: 'Deny' }],
        defaultValue: 'deny',
        badge: 'Coming soon',
    },
];

export const PRODUCTS = {
    'wp-rocket': {
        label: 'WP Rocket',
        brand: 'wp-rocket',
        flavour: 'performance',
        menuTitle: 'WP Rocket',
        pageTitle: 'AI Assistant',
        termsUrl: 'https://wp-rocket.example/terms/',
        privacyUrl: 'https://wp-rocket.example/privacy/',
        siteAccessUrl: 'https://wp-rocket.example/docs/site-access/',
        permissions: [],
        agents: [
            agent(1, 'WP Rocket', 'Assistant', 'wp-rocket:standard', {
                title: 'WP Rocket Assistant',
                message: 'Ask me anything about caching, performance, or WP Rocket settings.',
                suggestions: [
                    'How do I speed up my site?',
                    'Clear my cache',
                    'Which files are slowing my homepage?',
                    'What does Lazy Load do?',
                ],
            }),
            agent(2, 'WP Rocket', 'Performance Analyst', 'wp-rocket:performance'),
        ],
    },
    rankmath: {
        label: 'Rank Math',
        brand: 'rankmath',
        flavour: 'seo',
        menuTitle: 'Rank Math',
        pageTitle: 'AI Assistant',
        termsUrl: 'https://rankmath.example/terms/',
        privacyUrl: 'https://rankmath.example/privacy/',
        siteAccessUrl: 'https://rankmath.example/kb/site-access/',
        permissions: RANKMATH_PERMISSIONS,
        agents: [
            agent(3, 'RankMath', 'SEO Assistant', 'rankmath:standard', {
                title: 'RankMath SEO Assistant',
                message: 'Ask me about SEO scores, sitemaps, schema, or RankMath settings.',
                suggestions: [
                    'Audit my homepage SEO',
                    'Why is my post not ranking?',
                    'Add FAQ schema to this page',
                    'What is my current SEO score?',
                ],
            }),
        ],
    },
    onecom: {
        label: 'one.com',
        // one.com has no Gravity brand of its own on the CDN; the widget's default applies.
        brand: 'group-one',
        flavour: 'general',
        menuTitle: 'one.com',
        pageTitle: 'Site Assistant',
        termsUrl: 'https://onecom.example/terms/',
        privacyUrl: 'https://onecom.example/privacy/',
        siteAccessUrl: '',
        permissions: [],
        agents: [
            agent(4, 'one.com', 'Site Assistant', 'onecom:standard', {
                title: 'one.com Site Assistant',
                message: 'Ask me about your site, plugins, or anything one.com.',
            }),
        ],
    },
};

export const DEFAULT_PRODUCT = 'wp-rocket';

/** The product a request names, or the default one. */
export function productFor(slug) {
    return Object.hasOwn(PRODUCTS, slug) ? { slug, ...PRODUCTS[slug] } : { slug: DEFAULT_PRODUCT, ...PRODUCTS[DEFAULT_PRODUCT] };
}
