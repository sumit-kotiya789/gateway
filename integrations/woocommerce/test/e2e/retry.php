<?php
// Customer back on the pay page: process_payment again. Prints "<result> <current invoice id>".
$g = WC()->payment_gateways()->payment_gateways()['gateway_crypto'];
$r = $g->process_payment((int) $args[0]);
echo $r['result'] . ' ' . wc_get_order((int) $args[0])->get_meta('_gw_invoice_id') . "\n";
