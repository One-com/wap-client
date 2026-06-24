<?php defined( 'ABSPATH' ) || exit; ?>

<?php
$opts = wp_parse_args( get_option( 'wap_test_options', [] ), [
	'wap_url'         => 'http://localhost:3000',
	'wap_browser_url' => '',
	'product'         => 'wp-rocket',
	'license_key'     => '',
	'mode'            => 'product',
	'mcp_endpoint'    => home_url( '/wp-json/mcp/mcp-adapter-default-server' ),
	'page_context'    => '',
] );
?>

<div class="wrap">
	<h1>WAP Test Client — Settings</h1>

	<div class="notice notice-warning inline">
		<p>
			<strong>Dev tool only.</strong>
			Credentials are stored in WordPress options. Use a dedicated WP Application Password created specifically for this test client.
		</p>
	</div>

	<form method="post" action="options.php">
		<?php settings_fields( 'wap_test_group' ); ?>

		<table class="form-table" role="presentation">
			<tr>
				<th scope="row"><label for="wap_url">WAP Server URL</label></th>
				<td>
					<input type="url" id="wap_url" name="wap_test_options[wap_url]"
						value="<?php echo esc_attr( $opts['wap_url'] ); ?>"
						class="regular-text" placeholder="http://localhost:3000" />
					<p class="description">The root URL of your running WAP backend. Used by WordPress (server-side) for authentication calls.</p>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="wap_browser_url">WAP Browser URL</label></th>
				<td>
					<input type="url" id="wap_browser_url" name="wap_test_options[wap_browser_url]"
						value="<?php echo esc_attr( $opts['wap_browser_url'] ); ?>"
						class="regular-text" placeholder="http://localhost:3000" />
					<p class="description">
						The WAP URL reachable <strong>from your browser</strong>. Only needed when it differs from the server URL
						(e.g. server uses <code>host.docker.internal:3000</code> but your browser needs <code>localhost:3000</code>).
						Leave blank to use the WAP Server URL for both.
					</p>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="product">Product Slug</label></th>
				<td>
					<input type="text" id="product" name="wap_test_options[product]"
						value="<?php echo esc_attr( $opts['product'] ); ?>"
						class="regular-text" placeholder="wp-rocket" />
					<p class="description">Must match a <code>productSlug</code> in the WAP agents table (e.g. <code>wp-rocket</code>, <code>rankmath</code>).</p>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="license_key">License Key</label></th>
				<td>
					<input type="text" id="license_key" name="wap_test_options[license_key]"
						value="<?php echo esc_attr( $opts['license_key'] ); ?>"
						class="regular-text" />
					<p class="description">Your product license key. With <code>DEV_BYPASS_LICENSE=true</code> on the WAP server, any value is accepted.</p>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="mode">Chat Mode</label></th>
				<td>
					<select id="mode" name="wap_test_options[mode]">
						<option value="product" <?php selected( $opts['mode'], 'product' ); ?>>product — talk to one specialist directly</option>
						<option value="orchestrator" <?php selected( $opts['mode'], 'orchestrator' ); ?>>orchestrator — router picks specialist(s)</option>
					</select>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="mcp_endpoint">MCP Endpoint</label></th>
				<td>
					<input type="url" id="mcp_endpoint" name="wap_test_options[mcp_endpoint]"
						value="<?php echo esc_attr( $opts['mcp_endpoint'] ); ?>"
						class="regular-text" />
					<p class="description">The WordPress MCP adapter URL on this site. Default: <code><?php echo esc_html( home_url( '/wp-json/mcp/mcp-adapter-default-server' ) ); ?></code></p>
				</td>
			</tr>
			<tr>
				<th scope="row"><label for="page_context">Page Context</label></th>
				<td>
					<input type="text" id="page_context" name="wap_test_options[page_context]"
						value="<?php echo esc_attr( $opts['page_context'] ); ?>"
						class="regular-text" placeholder="e.g. pricing-page" />
					<p class="description">
						Optional. When set, the backend will try agent role
						<code><?php echo esc_html( $opts['product'] ?? 'product' ); ?>:{page_context}</code>
						before falling back to
						<code><?php echo esc_html( $opts['product'] ?? 'product' ); ?>:standard</code>.
						Leave blank to always use the standard agent.
						In production this should be set automatically by the host plugin.
					</p>
				</td>
			</tr>
		</table>

		<?php submit_button( 'Save Settings' ); ?>
	</form>
</div>
