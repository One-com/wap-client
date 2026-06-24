/**
 * WAP Test Client — chat interface
 *
 * Auth call goes via WordPress admin-ajax.php (server-side) to avoid CORS.
 * The streaming chat fetch goes directly from the browser to WapTest.wapUrl —
 * the WAP server must respond with CORS headers (Access-Control-Allow-Origin: *).
 * In development this is enabled automatically when NODE_ENV !== "production".
 */

/* global WapTest */

( function () {
	'use strict';

	// ── State ──────────────────────────────────────────────────────────────
	let token      = null;
	let convId     = null;
	let streaming  = false;

	// ── DOM refs ────────────────────────────────────────────────────────────
	const statusDot     = document.getElementById( 'wap-status-dot' );
	const statusText    = document.getElementById( 'wap-status-text' );
	const connectBtn    = document.getElementById( 'wap-connect-btn' );
	const disconnectBtn = document.getElementById( 'wap-disconnect-btn' );
	const clearBtn      = document.getElementById( 'wap-clear-btn' );
	const deleteBtn     = document.getElementById( 'wap-delete-btn' );
	const agentLabel    = document.getElementById( 'wap-agent-label' );
	const messages      = document.getElementById( 'wap-messages' );
	const input         = document.getElementById( 'wap-input' );
	const sendBtn       = document.getElementById( 'wap-send-btn' );
	const usageEl       = document.getElementById( 'wap-usage' );

	// ── Connect ─────────────────────────────────────────────────────────────
	connectBtn.addEventListener( 'click', async () => {
		connectBtn.disabled = true;
		setStatus( 'connecting', 'Connecting…' );
		try {
			await authenticate();
		} catch ( err ) {
			setStatus( 'disconnected', 'Disconnected' );
			appendEvent( 'error', '⚠ ' + err.message );
		} finally {
			connectBtn.disabled = false;
		}
	} );

	async function authenticate() {
		const resp = await fetch( WapTest.ajaxUrl, {
			method : 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body   : new URLSearchParams( {
				action     : 'wap_test_auth',
				_ajax_nonce: WapTest.nonce,
			} ),
		} );

		const json = await resp.json();
		if ( ! json.success ) {
			throw new Error( json.data?.message ?? 'Authentication failed' );
		}

		token  = json.data.token;
		convId = null;

		const agentName  = json.data.agent?.name  ?? 'unknown agent';
		const agentModel = json.data.agent?.model ?? '';
		const mode       = json.data.mode         ?? WapTest.mode;

		setStatus( 'connected', 'Connected' );
		agentLabel.textContent = agentName + ( agentModel ? '  (' + agentModel + ', ' + mode + ')' : '' );

		connectBtn.style.display    = 'none';
		disconnectBtn.style.display = '';
		clearBtn.style.display      = '';
		deleteBtn.style.display     = '';
		input.disabled              = false;
		sendBtn.disabled            = false;
		input.focus();
	}

	// ── Disconnect ──────────────────────────────────────────────────────────
	disconnectBtn.addEventListener( 'click', disconnect );

	function disconnect() {
		token = null; convId = null;
		setStatus( 'disconnected', 'Disconnected' );
		agentLabel.textContent      = '';
		connectBtn.style.display    = '';
		disconnectBtn.style.display = 'none';
		clearBtn.style.display      = 'none';
		deleteBtn.style.display     = 'none';
		input.disabled              = true;
		sendBtn.disabled            = true;
	}

	// ── Delete my data ──────────────────────────────────────────────────────
	deleteBtn.addEventListener( 'click', function () {
		if ( ! window.confirm( 'This will permanently delete all your conversation history with the AI assistant. This cannot be undone. Continue?' ) ) {
			return;
		}
		fetch( WapTest.wapUrl + '/api/v1/me/data/erase', {
			method:  'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
		} )
			.then( function ( res ) {
				if ( res.ok || res.status === 401 ) return;
				throw new Error( 'HTTP ' + res.status );
			} )
			.then( function () {
				messages.innerHTML = '';
				convId = null;
				usageEl.textContent = '';
				appendEvent( 'info', 'Your data has been deleted.' );
				deleteBtn.disabled = true;
			} )
			.catch( function ( err ) {
				appendEvent( 'error', '⚠ Delete failed: ' + err.message );
			} );
	} );

	// ── Clear ───────────────────────────────────────────────────────────────
	clearBtn.addEventListener( 'click', () => {
		messages.innerHTML = '';
		convId = null;
		usageEl.textContent = '';
	} );

	// ── Send ─────────────────────────────────────────────────────────────────
	sendBtn.addEventListener( 'click', sendMessage );

	input.addEventListener( 'keydown', ( e ) => {
		if ( e.key === 'Enter' && ( e.ctrlKey || e.metaKey ) && ! streaming ) {
			e.preventDefault();
			sendMessage();
		}
	} );

	async function sendMessage() {
		const text = input.value.trim();
		if ( ! text || streaming || ! token ) return;

		streaming        = true;
		sendBtn.disabled = true;
		input.disabled   = true;
		usageEl.textContent = '';

		appendBubble( 'user', text );
		input.value = '';

		try {
			await streamChat( text );
		} catch ( err ) {
			appendEvent( 'error', '⚠ ' + err.message );
		} finally {
			streaming        = false;
			sendBtn.disabled = false;
			input.disabled   = false;
			input.focus();
		}
	}

	// ── Streaming chat ───────────────────────────────────────────────────────
	async function streamChat( message ) {
		const resp = await fetch( WapTest.wapUrl + '/api/v1/chat/stream', {
			method : 'POST',
			headers: {
				'Content-Type' : 'application/json',
				'Authorization': 'Bearer ' + token,
			},
			body: JSON.stringify( Object.assign(
				{ message, conversation_id: convId || undefined },
				WapTest.pageContext ? { page_context: WapTest.pageContext } : {}
			) ),
		} );

		if ( ! resp.ok ) {
			const err = await resp.json().catch( () => ( {} ) );
			// Token expired → auto-disconnect so user knows to reconnect
			if ( resp.status === 401 ) { disconnect(); }
			throw new Error( err.message ?? err.error ?? 'HTTP ' + resp.status );
		}

		const reader  = resp.body.getReader();
		const decoder = new TextDecoder();
		let   buffer  = '';
		let   bubble  = null;

		while ( true ) {
			const { value, done } = await reader.read();
			if ( done ) break;

			buffer += decoder.decode( value, { stream: true } );
			const parts = buffer.split( '\n\n' );
			buffer = parts.pop(); // keep the trailing incomplete chunk

			for ( const part of parts ) {
				const line = part.trim();
				if ( ! line.startsWith( 'data:' ) ) continue;
				const raw = line.slice( 5 ).trim();
				if ( raw === '[DONE]' ) break;

				let event;
				try {
					event = JSON.parse( raw );
				} catch {
					continue;
				}
				bubble = handleEvent( event, bubble );
			}
		}
	}

	// ── Event rendering ──────────────────────────────────────────────────────
	function handleEvent( event, bubble ) {
		switch ( event.type ) {
			case 'message_start':
				convId = event.conversationId;
				bubble = createBubble( 'assistant' );
				break;

			case 'text_delta':
				if ( bubble ) {
					// textContent += is safe and doesn't re-parse HTML
					bubble.querySelector( '.wap-bubble-text' ).textContent += event.delta;
					scrollBottom();
				}
				break;

			case 'routing': {
				const detail = event.routing === 'single'
					? 'Routing → ' + ( event.specialist ?? '' )
					: 'Multi-agent → ' + ( event.specialists ?? [] ).join( ', ' );
				appendEvent( 'routing', detail, event.reasoning );
				break;
			}

			case 'specialist_start':
				appendEvent( 'specialist', '⟳ Calling ' + event.specialist + '…', null, 'specialist-' + event.specialist );
				break;

			case 'specialist_done': {
				const existing = document.getElementById( 'specialist-' + event.specialist );
				if ( existing ) {
					existing.textContent = '✓ ' + event.specialist;
					appendEvent( 'specialist-preview', event.preview, null, null, existing.parentElement );
				}
				break;
			}

			case 'synthesis_start':
				appendEvent( 'synthesis', '⚙ Synthesising…' );
				bubble = createBubble( 'assistant' );
				break;

			case 'tool_use':
				appendEvent( 'tool', null, null, null, null, {
					summary: 'tool call: ' + event.tool,
					body   : JSON.stringify( event.input, null, 2 ),
				} );
				break;

			case 'tool_result':
				appendEvent( 'tool', null, null, null, null, {
					summary: 'tool result: ' + event.tool,
					body   : JSON.stringify( event.output, null, 2 ),
				} );
				break;

			case 'message_end':
				if ( event.usage ) {
					usageEl.textContent =
						'↑ ' + event.usage.inputTokens + ' tokens in  ' +
						'↓ ' + event.usage.outputTokens + ' tokens out';
				}
				break;

			case 'error':
				appendEvent( 'error', '⚠ ' + event.message );
				break;
		}

		return bubble;
	}

	// ── DOM helpers ───────────────────────────────────────────────────────────

	function createBubble( role ) {
		const wrap = document.createElement( 'div' );
		wrap.className = 'wap-bubble ' + role;

		const label = document.createElement( 'span' );
		label.className = 'wap-bubble-label';
		label.textContent = role === 'user' ? 'You' : 'Agent';

		const text = document.createElement( 'div' );
		text.className = 'wap-bubble-text';

		wrap.appendChild( label );
		wrap.appendChild( text );
		messages.appendChild( wrap );
		scrollBottom();
		return wrap;
	}

	function appendBubble( role, text ) {
		const wrap = createBubble( role );
		wrap.querySelector( '.wap-bubble-text' ).textContent = text;
	}

	/**
	 * @param {string} cls       - CSS class for the event div
	 * @param {string|null} text - Simple text label
	 * @param {string|null} sub  - Secondary text (shown in <details>)
	 * @param {string|null} id   - Optional id for the inner span
	 * @param {Element|null} parent - Append to this element instead of messages
	 * @param {{summary:string, body:string}|null} collapsible - Renders a <details>
	 */
	function appendEvent( cls, text, sub, id, parent, collapsible ) {
		const target = parent || messages;

		if ( collapsible ) {
			const details = document.createElement( 'details' );
			details.className = 'wap-event ' + cls;
			const summary = document.createElement( 'summary' );
			summary.textContent = collapsible.summary;
			const pre = document.createElement( 'pre' );
			pre.textContent = collapsible.body;
			details.appendChild( summary );
			details.appendChild( pre );
			target.appendChild( details );
			scrollBottom();
			return;
		}

		const div = document.createElement( 'div' );
		div.className = 'wap-event ' + cls;

		if ( id ) {
			const span = document.createElement( 'span' );
			span.id = id;
			span.textContent = text;
			div.appendChild( span );
		} else {
			div.textContent = text;
		}

		if ( sub ) {
			const small = document.createElement( 'small' );
			small.textContent = ' — ' + sub;
			div.appendChild( small );
		}

		target.appendChild( div );
		scrollBottom();
	}

	function setStatus( state, label ) {
		statusDot.className  = 'wap-dot ' + state;
		statusText.textContent = label;
	}

	function scrollBottom() {
		messages.scrollTop = messages.scrollHeight;
	}
} )();
