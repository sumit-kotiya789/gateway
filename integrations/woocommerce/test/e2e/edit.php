<?php
$o = wc_get_order((int) $args[0]); foreach ($o->get_items() as $i) { $i->set_total('30'); $i->save(); } $o->calculate_totals(false); $o->save(); echo 'new total=' . $o->get_total() . "\n";
