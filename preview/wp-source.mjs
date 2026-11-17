/**
 * What WordPress hands the widget, read from the PHP that hands it over rather
 * than restated here: the strings (the `$i18n_defaults` table in
 * includes/class-chat-widget.php, translated through i18n/wap-client-<locale>.po)
 * and each surface's layout defaults (the *_LAYOUT constants).
 *
 * Read on every page load, so the preview shows what a wp-admin page shows
 * today, and an edit to those files shows on the next reload. A string the .po
 * file does not translate stays in English, as it does in WordPress.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** PHP string literal body to text: single quotes know only \' and \\, double quotes more. */
function unquotePhp(body, quote) {
    if (quote === "'") return body.replace(/\\(['\\])/g, '$1');
    return body.replace(/\\(["\\$])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/** A .po string literal body to text. */
function unquotePo(body) {
    return body.replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c));
}

/**
 * The `$i18n_defaults = [ ... ];` table: key to English msgid. Entries that are
 * not a plain `__('…', 'wap-client')` are left out; the one today is
 * `assistantName`, which WordPress fills from the page's menu title.
 */
export function readI18nDefaults(phpSource) {
    const block = /\$i18n_defaults\s*=\s*\[(.*?)\n\s*\];/s.exec(phpSource);
    if (!block) throw new Error('class-chat-widget.php has no $i18n_defaults table.');

    const strings = {};
    const entry = /'(\w+)'\s*=>\s*__\(\s*(['"])((?:\\.|(?!\2).)*)\2\s*,\s*'wap-client'\s*\)/gs;
    for (const match of block[1].matchAll(entry)) {
        strings[match[1]] = unquotePhp(match[3], match[2]);
    }
    return strings;
}

/** The prompt chips WordPress passes as `suggestions` when a product filters none in. */
export function readDefaultSuggestions(phpSource) {
    const block = /'suggestions'\s*=>\s*apply_filters\(\s*'wap_client_suggestions',\s*\[(.*?)\]/s.exec(phpSource);
    if (!block) throw new Error("class-chat-widget.php has no 'suggestions' => apply_filters( 'wap_client_suggestions', [...] ); update readDefaultSuggestions in preview/wp-source.mjs.");
    return [...block[1].matchAll(/__\(\s*(['"])((?:\\.|(?!\1).)*)\1/gs)].map((m) => unquotePhp(m[2], m[1]));
}

/** The Gravity design system version the PHP loads its stylesheet and script from. */
export function readGravityVersion(phpSource) {
    const versions = new Set([...phpSource.matchAll(/gravity\.group-cdn\.one\/(v[\d.]+)\//g)].map((m) => m[1]));
    if (versions.size !== 1) {
        throw new Error(`class-chat-widget.php names ${versions.size} Gravity versions (${[...versions].join(', ') || 'none'}), expected one; update readGravityVersion in preview/wp-source.mjs.`);
    }
    return [...versions][0];
}

/** msgid to msgstr, for the singular entries of a .po file that have a translation. */
export function readPo(poSource) {
    const translations = {};
    let field = null;
    let entry = { msgid: '', msgstr: '' };

    const flush = () => {
        if (entry.msgid && entry.msgstr) translations[entry.msgid] = entry.msgstr;
        entry = { msgid: '', msgstr: '' };
        field = null;
    };

    for (const raw of poSource.split(/\r?\n/)) {
        const line = raw.trim();
        let match;
        if (line === '' || line.startsWith('#')) {
            if (line === '') flush();
            continue;
        }
        if ((match = /^(msgid|msgstr)\s+"(.*)"$/.exec(line))) {
            if (match[1] === 'msgid' && field === 'msgstr') flush();
            field = match[1];
            entry[field] = unquotePo(match[2]);
        } else if ((match = /^"(.*)"$/.exec(line)) && field) {
            entry[field] += unquotePo(match[1]);
        } else {
            // msgctxt, msgid_plural, msgstr[n]: not used by wap-client; skip the entry.
            field = null;
        }
    }
    flush();
    return translations;
}

export class WordPressSource {
    /** @param {string} packageRoot wp-client-plugin/wap-client */
    constructor(packageRoot) {
        this.includes = join(packageRoot, 'includes');
        this.php = join(this.includes, 'class-chat-widget.php');
        this.i18nDir = join(packageRoot, 'i18n');
    }

    /**
     * The layout a PHP surface adds to the product's own: `private const NAME = [...]`
     * in includes/<file>, e.g. COLUMN_LAYOUT in class-chat-column.php.
     */
    layout(file, constant) {
        const source = readFileSync(join(this.includes, file), 'utf8');
        const block = new RegExp(`const ${constant}\\s*=\\s*\\[(.*?)\\];`, 's').exec(source);
        if (!block) throw new Error(`includes/${file} has no ${constant}.`);
        const layout = {};
        for (const [, key, value] of block[1].matchAll(/'(\w+)'\s*=>\s*'([^']*)'/g)) layout[key] = value;
        return layout;
    }

    /** The Gravity version a WordPress page loads. */
    gravityVersion() {
        return readGravityVersion(readFileSync(this.php, 'utf8'));
    }

    /** Locales with a .po file, plus en_US, which is the msgids themselves. */
    locales() {
        const found = readdirSync(this.i18nDir)
            .map((name) => /^wap-client-([a-z]{2}_[A-Z]{2})\.po$/.exec(name))
            .filter(Boolean)
            .map((m) => m[1]);
        return ['en_US', ...found.sort()];
    }

    /** The `i18n` and `suggestions` WordPress would localise for `locale`. */
    forLocale(locale) {
        const source = readFileSync(this.php, 'utf8');
        const english = readI18nDefaults(source);
        const suggestions = readDefaultSuggestions(source);

        let translate = (text) => text;
        if (locale !== 'en_US' && this.locales().includes(locale)) {
            const po = readPo(readFileSync(join(this.i18nDir, `wap-client-${locale}.po`), 'utf8'));
            translate = (text) => po[text] || text;
        }

        const i18n = {};
        for (const [key, text] of Object.entries(english)) i18n[key] = translate(text);

        return {
            i18n,
            suggestions: suggestions.map(translate),
            connecting: translate('Connecting to the assistant…'),
        };
    }
}
