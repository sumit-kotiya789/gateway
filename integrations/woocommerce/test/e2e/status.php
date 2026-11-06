<?php
$o = wc_get_order((int) $args[0]);
echo 'status=' . $o->get_status() . ' paid_tx=' . $o->get_transaction_id() . "\n";
foreach (array_reverse(wc_get_order_notes(['order_id' => $o->get_id()])) as $n) echo '  note: ' . $n->content . "\n";
