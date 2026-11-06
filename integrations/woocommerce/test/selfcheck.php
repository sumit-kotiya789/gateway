<?php
// Self-check for the plugin's pure helpers: `php integrations/woocommerce/test/selfcheck.php` (exit 0 = pass).
// The signature vector was produced by the server's own signer (apps/server webhooks/delivery.ts signatureHeader).

define( 'ABSPATH', __DIR__ );
require __DIR__ . '/../gateway-crypto/includes/functions.php';

function check( bool $ok, string $what ): void {
	if ( ! $ok ) {
		fwrite( STDERR, "FAIL: $what\n" );
		exit( 1 );
	}
}

$body   = '{"id":"evt_1","object":"event","type":"invoice.paid","data":{"invoice_id":"inv_1","status":"paid","external_order_id":"42"}}';
$header = 't=1762400000,v1=e274dc3d303a5bbeb6d31909c071c91b5246c565480478941b69ef80402eae3d,v1=452fce51ff0494e10740a7c24d2fa05733f7af74fc8d2260d3f5b678038d2e7c';
$now    = 1762400000 + 60;

check( gw_crypto_verify_signature( $body, $header, 'whsec_old', 300, $now ), 'old secret during rotation' );
check( gw_crypto_verify_signature( $body, $header, 'whsec_new', 300, $now ), 'new secret during rotation' );
check( ! gw_crypto_verify_signature( $body, $header, 'whsec_other', 300, $now ), 'wrong secret' );
check( ! gw_crypto_verify_signature( $body, $header, '', 300, $now ), 'empty secret never verifies' );
check( ! gw_crypto_verify_signature( $body . ' ', $header, 'whsec_new', 300, $now ), 'body changed' );
check( ! gw_crypto_verify_signature( $body, $header, 'whsec_new', 300, 1762400000 + 301 ), 'too old' );
check( ! gw_crypto_verify_signature( $body, $header, 'whsec_new', 300, 1762400000 - 301 ), 'too far in the future' );
check( ! gw_crypto_verify_signature( $body, 'v1=abc', 'whsec_new', 300, $now ), 'no timestamp' );
check( ! gw_crypto_verify_signature( $body, '', 'whsec_new', 300, $now ), 'no header' );

check( gw_crypto_same_amount( '25', '25.00' ), '25 = 25.00' );
check( gw_crypto_same_amount( '0.5', '0.50' ), '0.5 = 0.50' );
check( gw_crypto_same_amount( '1000000.000000000000000001', '1000000.000000000000000001' ), '18 decimals exact' );
check( ! gw_crypto_same_amount( '25', '25.01' ), '25 != 25.01' );
check( ! gw_crypto_same_amount( '1000000.000000000000000001', '1000000' ), 'no float rounding' );
check( ! gw_crypto_same_amount( '-1', '-1' ), 'negative refused' );
check( ! gw_crypto_same_amount( '1e3', '1000' ), 'exponent refused' );
check( '0' === gw_crypto_canonical_amount( '000.000' ), 'zero canonical' );

check( '42' === gw_crypto_order_ref( 42, 1 ) && '42-2' === gw_crypto_order_ref( 42, 2 ), 'order ref per attempt' );
check( 42 === gw_crypto_order_id_from_ref( '42' ) && 42 === gw_crypto_order_id_from_ref( '42-3' ), 'order id from ref' );
foreach ( array( '', '0', '042', '42-', '42-0', '42-2-3', 'x42', '42 ', '-42' ) as $bad ) {
	check( null === gw_crypto_order_id_from_ref( $bad ), "ref refused: '$bad'" );
}

echo "selfcheck ok\n";
