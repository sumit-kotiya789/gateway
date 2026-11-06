<?php
/**
 * Cart and Checkout blocks support (the default checkout since WooCommerce 8.3). Payment itself still runs through
 * GW_Crypto_Gateway::process_payment via the Store API.
 */

defined( 'ABSPATH' ) || exit;

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class GW_Crypto_Blocks extends AbstractPaymentMethodType {

	protected $name = GW_Crypto_Gateway::ID;

	public function initialize() {
		$this->settings = get_option( 'woocommerce_' . GW_Crypto_Gateway::ID . '_settings', array() );
	}

	public function is_active() {
		$gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : array();
		return isset( $gateways[ GW_Crypto_Gateway::ID ] ) && $gateways[ GW_Crypto_Gateway::ID ]->is_available();
	}

	public function get_payment_method_script_handles() {
		wp_register_script(
			'gateway-crypto-blocks',
			plugins_url( 'assets/blocks.js', GW_CRYPTO_FILE ),
			array( 'wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities' ),
			GW_CRYPTO_VERSION,
			true
		);
		return array( 'gateway-crypto-blocks' );
	}

	public function get_payment_method_data() {
		return array(
			'title'       => $this->get_setting( 'title' ),
			'description' => $this->get_setting( 'description' ),
			'supports'    => array( 'products' ),
		);
	}
}
