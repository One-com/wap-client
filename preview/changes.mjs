/**
 * What the preview does when files change on disk: swap the widget's stylesheets
 * in place when only they changed, reload the page otherwise. Pure, so npm/test-widget.mjs
 * covers it; server.mjs does the watching and the broadcasting.
 */

/**
 * @param {string[]} files paths relative to wp-client-plugin/wap-client, e.g. "assets/wap-chat.css"
 * @returns {{event: 'css'|'reload', data: string, line: string}} the live-stream event, its payload and the log line
 */
export function describeChange(files) {
    // The in-place swap (restyle() in public/harness.js) covers /assets/ stylesheets only.
    const widgetCss = (file) => file.startsWith('assets/') && file.endsWith('.css');
    const event = files.length > 0 && files.every(widgetCss) ? 'css' : 'reload';
    const names = files.join(', ');
    return {
        event,
        data: files.join(','),
        line: `  changed: ${names} -> ${event === 'css' ? 'restyled' : 'reloaded'}`,
    };
}
