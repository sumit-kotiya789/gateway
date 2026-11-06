<?php
/**
 * Plugin Name:          Gateway Crypto Payments
 * Description:          Accept USDT in WooCommerce through the gateway's hosted checkout (non-custodial: payments go to your wallet).
 * Version:              1.0.0
 * Requires at least:    6.4
 * Requires PHP:         7.4
 * WC requires at least: 8.3
 * Text Domain:          gateway-crypto
 * License:              GPL-2.0-or-later
 */

defined( 'ABSPATH' ) || exit;

define( 'GW_CRYPTO_VERSION', '1.0.0' );
define( 'GW_CRYPTO_FILE', __FILE__ );

require_once __DIR__ . '/includes/functions.php';

// Uses only order CRUD (get_meta / update_meta_data), so it works with High-Performance Order Storage.
add_action(
	'before_woocommerce_init',
	function () {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
		}
	}
);

add_action(
	'plugins_loaded',
	function () {
		if ( ! class_exists( 'WC_Payment_Gateway' ) ) {
			return; // WooCommerce not active: register nothing
		}
		require_once __DIR__ . '/includes/class-gw-crypto-gateway.php';
		add_filter(
			'woocommerce_payment_gateways',
			function ( $gateways ) {
				$gateways[] = 'GW_Crypto_Gateway';
				return $gateways;
			}
		);
		add_action(
			'woocommerce_blocks_payment_method_type_registration',
			function ( $registry ) {
				require_once __DIR__ . '/includes/class-gw-crypto-blocks.php';
				$registry->register( new GW_Crypto_Blocks() );
			}
		);
		add_action(
			'rest_api_init',
			function () {
				register_rest_route(
					'gateway-crypto/v1',
					'/webhook',
					array(
						'methods'             => 'POST',
						'callback'            => 'gw_crypto_webhook',
						'permission_callback' => '__return_true', // authenticated by the HMAC signature
					)
				);
			}
		);
	}
);

/**
 * Webhook receiver. Verifies the signature, then re-reads the invoice from the API and applies its current state
 * (events may arrive out of order or more than once). Non-2xx makes the gateway retry.
 */
function gw_crypto_webhook( WP_REST_Request $request ) {
	$gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : array();
	$gateway  = $gateways[ GW_Crypto_Gateway::ID ] ?? null;
	if ( ! $gateway ) {
		return new WP_REST_Response( array( 'error' => 'gateway not configured' ), 503 );
	}
	$raw = $request->get_body();
	if ( ! gw_crypto_verify_signature( $raw, (string) $request->get_header( 'gateway-signature' ), (string) $gateway->get_option( 'webhook_secret' ) ) ) {
		return new WP_REST_Response( array( 'error' => 'invalid signature' ), 401 );
	}
	$event      = json_decode( $raw, true );
	$invoice_id = (string) ( $event['data']['invoice_id'] ?? '' );
	$order_ref  = (string) ( $event['data']['external_order_id'] ?? '' );
	$order      = ctype_digit( $order_ref ) ? wc_get_order( (int) $order_ref ) : false;
	if ( '' === $invoice_id || ! $order || $order->get_payment_method() !== GW_Crypto_Gateway::ID ) {
		return new WP_REST_Response( array( 'ignored' => true ), 200 ); // not an order paid with this plugin
	}
	$invoice = $gateway->api( 'GET', '/v1/invoices/' . rawurlencode( $invoice_id ) );
	if ( is_wp_error( $invoice ) ) {
		return new WP_REST_Response( array( 'error' => 'gateway unreachable, retry' ), 503 );
	}
	$gateway->apply_invoice( $order, $invoice );
	return new WP_REST_Response( array( 'ok' => true ), 200 );
}
