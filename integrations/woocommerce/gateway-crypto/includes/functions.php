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
