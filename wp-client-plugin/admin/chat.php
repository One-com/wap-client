<?php defined( 'ABSPATH' ) || exit; ?>

<div class="wrap" id="wap-test-wrap">
	<h1>WAP Test Client</h1>

	<div id="wap-toolbar">
		<div id="wap-status">
			<span id="wap-status-dot" class="wap-dot disconnected"></span>
			<span id="wap-status-text">Disconnected</span>
		</div>
		<div id="wap-actions">
			<button id="wap-connect-btn" class="button button-primary">Connect</button>
			<button id="wap-disconnect-btn" class="button" style="display:none">Disconnect</button>
			<button id="wap-clear-btn" class="button" style="display:none">Clear</button>
			<button id="wap-delete-btn" class="button" style="display:none">Delete my data</button>
			<span id="wap-agent-label"></span>
		</div>
	</div>

	<div id="wap-messages" aria-live="polite" aria-label="Chat messages"></div>

	<div id="wap-input-row">
		<textarea
			id="wap-input"
			rows="3"
			placeholder="Type a message… (Ctrl+Enter to send)"
			disabled
			aria-label="Message input"
		></textarea>
		<button id="wap-send-btn" class="button button-primary" disabled>Send</button>
	</div>

	<div id="wap-footer">
		<span id="wap-usage"></span>
		<a href="<?php echo esc_url( admin_url( 'admin.php?page=wap-test-settings' ) ); ?>">Settings</a>
	</div>
</div>
