<?php
/**
 * Pure helpers (no WordPress calls), covered by test/selfcheck.php.
 */

defined( 'ABSPATH' ) || exit;

/**
 * Verifies the `gateway-signature` header: `t=<unix>,v1=<hex>[,v1=<hex>]`, HMAC-SHA256 of "<t>.<raw body>".
 * Any v1 may match (two during a secret rotation); `t` must be within $tolerance seconds.
 */
function gw_crypto_verify_signature( string $raw_body, string $header, string $secret, int $tolerance = 300, ?int $now = null ): bool {
	if ( '' === $secret ) {
		return false;
	}
	$t    = null;
	$sigs = array();
	foreach ( explode( ',', $header ) as $part ) {
		$kv = explode( '=', $part, 2 );
		if ( 2 !== count( $kv ) ) {
			continue;
		}
		if ( 't' === $kv[0] && ctype_digit( $kv[1] ) ) {
			$t = (int) $kv[1];
		} elseif ( 'v1' === $kv[0] ) {
			$sigs[] = $kv[1];
		}
	}
	if ( null === $t || abs( ( $now ?? time() ) - $t ) > $tolerance ) {
		return false;
	}
	$expected = hash_hmac( 'sha256', $t . '.' . $raw_body, $secret );
	foreach ( $sigs as $sig ) {
		if ( hash_equals( $expected, $sig ) ) {
			return true;
		}
	}
	return false;
}

/**
 * external_order_id of an order's invoice. The gateway keeps it unique per merchant and mode, so a later attempt
 * (the first invoice expired, or the total changed) gets a suffix: "42", then "42-2", "42-3".
 */
function gw_crypto_order_ref( int $order_id, int $attempt ): string {
	return $attempt <= 1 ? (string) $order_id : $order_id . '-' . $attempt;
}

/** Order id from an external_order_id written by gw_crypto_order_ref, or null. */
function gw_crypto_order_id_from_ref( string $ref ): ?int {
	return preg_match( '/^([1-9]\d{0,18})(?:-[1-9]\d{0,5})?$/', $ref, $m ) ? (int) $m[1] : null;
}

/** Canonical decimal string ("025.50" -> "25.5", "10.00" -> "10"), or null if not a plain non-negative decimal. */
function gw_crypto_canonical_amount( string $amount ): ?string {
	if ( ! preg_match( '/^(\d+)(?:\.(\d+))?$/', trim( $amount ), $m ) ) {
		return null;
	}
	$int  = ltrim( $m[1], '0' );
	$frac = rtrim( $m[2] ?? '', '0' );
	return ( '' === $int ? '0' : $int ) . ( '' === $frac ? '' : '.' . $frac );
}

/** Exact decimal equality without floats (the gateway trims trailing zeros, WooCommerce pads them). */
function gw_crypto_same_amount( string $a, string $b ): bool {
	$ca = gw_crypto_canonical_amount( $a );
	return null !== $ca && gw_crypto_canonical_amount( $b ) === $ca;
}
