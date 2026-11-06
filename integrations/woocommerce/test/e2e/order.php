<?php
$p = new WC_Product_Simple(); $p->set_name('Mug'); $p->set_regular_price('25'); $p->save();
$o = wc_create_order(); $o->add_product($p, 1); $o->set_payment_method('gateway_crypto'); $o->calculate_totals(); $o->save();
$g = WC()->payment_gateways()->payment_gateways()['gateway_crypto'];
echo 'available=' . var_export($g->is_available(), true) . "\n";
$r1 = $g->process_payment($o->get_id());
$o = wc_get_order($o->get_id());
$r2 = $g->process_payment($o->get_id());
echo 'order=' . $o->get_id() . ' total=' . $o->get_total() . ' status=' . $o->get_status() . "\n";
echo 'invoice=' . $o->get_meta('_gw_invoice_id') . "\n";
echo 'redirect=' . $r1['redirect'] . ' reused=' . var_export($r1['redirect'] === $r2['redirect'], true) . "\n";
