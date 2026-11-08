<?php
/**
 * WooCommerce payment method: creates a gateway invoice per order and sends the customer to the hosted checkout.
 * Orders are updated from the invoice's current state (webhook, or the thank-you page as a fallback), never from
 * an event payload alone: the gateway does not guarantee event order.
 */

defined( 'ABSPATH' ) || exit;

class GW_Crypto_Gateway extends WC_Payment_Gateway {

	const ID   = 'gateway_crypto';
	const OPEN = array( 'pending', 'detected', 'confirming' );

	public function __construct() {
		$this->id                 = self::ID;
		$this->method_title       = __( 'Crypto (USDT)', 'gateway-crypto' );
		$this->method_description = __( 'Accept USDT through the gateway\'s hosted checkout. Payments go straight to your wallet (non-custodial).', 'gateway-crypto' );
		$this->has_fields         = false;
		$this->supports           = array( 'products' );

		$this->init_form_fields();
		$this->init_settings();
		$this->title       = $this->get_option( 'title' );
		$this->description = $this->get_option( 'description' );

		add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
		add_action( 'woocommerce_thankyou_' . $this->id, array( $this, 'sync_on_return' ) );
	}

	public function init_form_fields() {
		$this->form_fields = array(
			'enabled'        => array(
				'title'   => __( 'Enable', 'gateway-crypto' ),
				'type'    => 'checkbox',
				'label'   => __( 'Accept crypto payments', 'gateway-crypto' ),
				'default' => 'no',
			),
			'title'          => array(
				'title'   => __( 'Title', 'gateway-crypto' ),
				'type'    => 'text',
				'default' => __( 'Pay with USDT', 'gateway-crypto' ),
			),
			'description'    => array(
				'title'   => __( 'Description', 'gateway-crypto' ),
				'type'    => 'textarea',
				'default' => __( 'You will be sent to a secure page to pay with USDT from any wallet.', 'gateway-crypto' ),
			),
			'api_url'        => array(
				'title'       => __( 'Gateway URL', 'gateway-crypto' ),
				'type'        => 'text',
				'description' => __( 'Base URL of the gateway API, e.g. https://pay.example', 'gateway-crypto' ),
				'default'     => '',
			),
			'secret_key'     => array(
				'title'       => __( 'Secret API key', 'gateway-crypto' ),
				'type'        => 'password',
				'description' => __( 'sk_test_… or sk_live_… with scopes read and invoices:write. The key decides test or live mode.', 'gateway-crypto' ),
				'default'     => '',
			),
			'webhook_secret' => array(
				'title'       => __( 'Webhook secret', 'gateway-crypto' ),
				'type'        => 'password',
				/* translators: %s: webhook URL */
				'description' => sprintf( __( 'In the gateway dashboard, add a webhook endpoint for %s and paste its whsec_… secret here.', 'gateway-crypto' ), '<code>' . esc_html( rest_url( 'gateway-crypto/v1/webhook' ) ) . '</code>' ),
				'default'     => '',
			),
			'token'          => array(
				'title'       => __( 'Token', 'gateway-crypto' ),
				'type'        => 'text',
				'description' => __( 'Gateway token id: bsc:usdt for live, bsc-testnet:usdt for test.', 'gateway-crypto' ),
				'default'     => 'bsc:usdt',
			),
			'expires_min'    => array(
				'title'             => __( 'Time to pay (minutes)', 'gateway-crypto' ),
				'type'              => 'number',
				'default'           => '30',
				'custom_attributes' => array(
					'min' => 5,
					'max' => 1440,
				),
			),
		);
	}

	/** USDT is priced 1:1 in the store currency, so only USD (or a USDT currency) stores can offer it. */
	public function is_available() {
		return parent::is_available()
			&& '' !== $this->get_option( 'api_url' )
			&& '' !== $this->get_option( 'secret_key' )
			&& in_array( get_woocommerce_currency(), array( 'USD', 'USDT' ), true );
	}

	public function process_payment( $order_id ) {
		$order  = wc_get_order( $order_id );
		$amount = wc_format_decimal( $order->get_total(), wc_get_price_decimals() );
		$token  = $this->get_option( 'token' );

		// Back on the pay page with an invoice still open for the same amount: reuse it (same address, no new invoice).
		$existing = (string) $order->get_meta( '_gw_invoice_id' );
		if ( '' !== $existing ) {
			$inv = $this->api( 'GET', '/v1/invoices/' . rawurlencode( $existing ) );
			if ( ! is_wp_error( $inv ) && in_array( $inv['status'], self::OPEN, true ) && $inv['token'] === $token && gw_crypto_same_amount( $inv['amount'], $amount ) ) {
				return array(
					'result'   => 'success',
					'redirect' => $inv['checkout_url'],
				);
			}
		}

		// One idempotency key per attempt, saved only on success: a retry after a timeout returns the same invoice.
		$attempt = (int) $order->get_meta( '_gw_attempt' ) + 1;
		$inv     = $this->api(
			'POST',
			'/v1/invoices',
			array(
				'amount'            => $amount,
				'token'             => $token,
				'external_order_id' => gw_crypto_order_ref( $order->get_id(), $attempt ),
				/* translators: %s: order number */
				'description'       => sprintf( __( 'Order #%s', 'gateway-crypto' ), $order->get_order_number() ),
				'expires_in'        => 60 * max( 5, min( 1440, (int) $this->get_option( 'expires_min', 30 ) ) ),
				'success_url'       => $this->get_return_url( $order ),
				'cancel_url'        => $order->get_cancel_order_url_raw(),
			),
			'wc-' . $order->get_id() . '-' . $attempt
		);
		if ( is_wp_error( $inv ) ) {
			wc_add_notice( __( 'Crypto payment is unavailable right now. Please try again or choose another payment method.', 'gateway-crypto' ), 'error' );
			return array( 'result' => 'failure' );
		}

		$order->update_meta_data( '_gw_invoice_id', $inv['id'] );
		$order->update_meta_data( '_gw_attempt', $attempt );
		/* translators: 1: invoice id, 2: amount, 3: token */
		$order->add_order_note( sprintf( __( 'Crypto invoice %1$s created for %2$s %3$s.', 'gateway-crypto' ), $inv['id'], $inv['amount'], $inv['token'] ) );
		$order->save();

		return array(
			'result'   => 'success',
			'redirect' => $inv['checkout_url'],
		);
	}

	/** Thank-you page: catch up without waiting for the webhook (or when none is configured). */
	public function sync_on_return( $order_id ) {
		$order = wc_get_order( $order_id );
		$id    = $order ? (string) $order->get_meta( '_gw_invoice_id' ) : '';
		if ( '' === $id || ! $order->has_status( array( 'pending', 'on-hold' ) ) ) {
			return;
		}
		$inv = $this->api( 'GET', '/v1/invoices/' . rawurlencode( $id ) );
		if ( ! is_wp_error( $inv ) ) {
			$this->apply_invoice( $order, $inv );
		}
	}

	/**
	 * Moves the order to match the invoice's current state. Idempotent: safe for repeated and out-of-order webhooks.
	 * Only the order's current invoice may cancel or hold it; an earlier invoice of the same order may still pay it.
	 */
	public function apply_invoice( WC_Order $order, array $inv ) {
		if ( gw_crypto_order_id_from_ref( (string) ( $inv['external_order_id'] ?? '' ) ) !== $order->get_id() ) {
			return; // not this order's invoice
		}
		$state = $inv['id'] . ':' . $inv['status'];
		if ( $order->get_meta( '_gw_state' ) === $state ) {
			return; // nothing new: webhook retry or duplicate event
		}
		$this->transition( $order, $inv );
		$order->update_meta_data( '_gw_state', $state );
		$order->save();
	}

	private function transition( WC_Order $order, array $inv ) {
		$current = $order->get_meta( '_gw_invoice_id' ) === $inv['id'];
		$open    = $order->has_status( array( 'pending', 'on-hold', 'failed' ) );
		$total   = wc_format_decimal( $order->get_total(), wc_get_price_decimals() );

		switch ( $inv['status'] ) {
			case 'paid':
			case 'overpaid':
			case 'settled':
				if ( ! $open ) {
					return;
				}
				if ( ! gw_crypto_same_amount( $inv['amount'], $total ) ) {
					/* translators: 1: invoice amount, 2: order total */
					$this->hold( $order, sprintf( __( 'Crypto invoice paid for %1$s but the order total is %2$s. Check before shipping.', 'gateway-crypto' ), $inv['amount'], $total ) );
					return;
				}
				/* translators: 1: amount received, 2: token */
				$order->add_order_note( sprintf( __( 'Crypto payment confirmed: %1$s %2$s received.', 'gateway-crypto' ), $inv['amount_received'], $inv['token'] ) );
				$order->payment_complete( $inv['id'] );
				return;
			case 'underpaid':
			case 'late_payment':
				if ( $open ) {
					/* translators: 1: invoice status, 2: amount received, 3: amount expected */
					$this->hold( $order, sprintf( __( 'Crypto invoice is %1$s (%2$s of %3$s received). Resolve it in the gateway dashboard.', 'gateway-crypto' ), $inv['status'], $inv['amount_received'], $inv['amount'] ) );
				}
				return;
			case 'held':
				if ( $open ) {
					$this->hold( $order, __( 'Crypto payment received but held for review by the payment gateway. Do not ship until it is released.', 'gateway-crypto' ) );
				}
				return;
			case 'failed':
				if ( $current && $open ) {
					$order->update_status( 'failed', __( 'Crypto payment rejected by the payment gateway review. Any refund is handled outside the gateway.', 'gateway-crypto' ) );
				}
				return;
			case 'expired':
			case 'cancelled':
				if ( $current && $order->has_status( 'pending' ) ) {
					/* translators: %s: invoice status */
					$order->update_status( 'cancelled', sprintf( __( 'Crypto invoice %s without payment.', 'gateway-crypto' ), $inv['status'] ) );
				}
				return;
			case 'detected':
			case 'confirming':
				if ( $current && $order->has_status( 'pending' ) ) {
					$this->hold( $order, __( 'Crypto payment seen on chain, waiting for confirmations. Do not ship yet.', 'gateway-crypto' ) );
				}
				return;
		}
	}

	private function hold( WC_Order $order, string $note ) {
		if ( $order->has_status( 'on-hold' ) ) {
			$order->add_order_note( $note );
		} else {
			$order->update_status( 'on-hold', $note );
		}
	}

	/** Gateway API call. Returns the decoded JSON or WP_Error. Never logs the key. */
	public function api( string $method, string $path, ?array $body = null, ?string $idempotency_key = null ) {
		$args = array(
			'method'  => $method,
			'timeout' => 15,
			'headers' => array(
				'Authorization' => 'Bearer ' . $this->get_option( 'secret_key' ),
				'Accept'        => 'application/json',
			),
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}
		if ( null !== $idempotency_key ) {
			$args['headers']['Idempotency-Key'] = $idempotency_key;
		}
		$res = wp_remote_request( untrailingslashit( $this->get_option( 'api_url' ) ) . $path, $args );
		if ( is_wp_error( $res ) ) {
			wc_get_logger()->error( "$method $path failed: " . $res->get_error_message(), array( 'source' => 'gateway-crypto' ) );
			return $res;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( $code < 200 || $code >= 300 || ! is_array( $data ) ) {
			$err = is_array( $data ) && isset( $data['error']['code'] ) ? $data['error']['code'] : 'unexpected response';
			wc_get_logger()->error( "$method $path: HTTP $code $err", array( 'source' => 'gateway-crypto' ) );
			return new WP_Error( 'gateway_crypto_api', "HTTP $code $err" );
		}
		return $data;
	}
}
