#!/usr/bin/env bash
# End-to-end check of the WooCommerce plugin on real WordPress + WooCommerce (Docker) against a mock gateway API
# (mock.mjs: invoices in memory, webhooks signed like apps/server). Needs Docker and internet (downloads WooCommerce).
#   bash integrations/woocommerce/test/e2e/e2e.sh     (exit 0 = pass; containers are removed at the end)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep container paths as written
here="$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))"
plugin="$(cd "$(dirname "$0")/../../gateway-crypto" && (pwd -W 2>/dev/null || pwd))"
net=gwwc

cleanup() { docker rm -f gwwc-db gwwc-wp gwwc-mock >/dev/null 2>&1 || true; docker volume rm gwwc-wp >/dev/null 2>&1 || true; docker network rm $net >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker network create $net >/dev/null
docker run -d --name gwwc-db --network $net -e MARIADB_ROOT_PASSWORD=r -e MARIADB_DATABASE=wp -e MARIADB_USER=wp -e MARIADB_PASSWORD=wp mariadb:11 >/dev/null
docker volume create gwwc-wp >/dev/null
db_env=(-e WORDPRESS_DB_HOST=gwwc-db -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wp)
mounts=(-v gwwc-wp:/var/www/html -v "$plugin:/var/www/html/wp-content/plugins/gateway-crypto:ro" -v "$here:/e2e:ro")
docker run -d --name gwwc-wp --network $net --network-alias wordpress "${db_env[@]}" "${mounts[@]}" wordpress:php8.2-apache >/dev/null
docker run -d --name gwwc-mock --network $net --network-alias mock -e HOOK='http://wordpress/?rest_route=/gateway-crypto/v1/webhook' -v "$here:/m:ro" node:24-alpine node /m/mock.mjs >/dev/null

# wp-cli; keeps its exit status, hides the container's missing-sendmail noise.
wp() {
  local out rc=0
  out="$(docker run --rm --network $net --user 33:33 "${db_env[@]}" "${mounts[@]}" wordpress:cli wp "$@" 2>&1)" || rc=$?
  grep -v -i 'sendmail\|mail function' <<<"$out" || true
  return $rc
}
hook() { docker exec gwwc-mock wget -qO- "http://localhost/_test/$1"; }
expect() { if ! grep -q -- "$2" <<<"$3"; then echo "FAIL: $1 (wanted '$2')"; echo "$3"; exit 1; fi; echo "ok: $1"; }
order() { local out; out="$(wp eval-file /e2e/order.php)"; echo "$out" | sed -n 's/^order=\([0-9]*\).*/\1/p;s/^invoice=//p' | paste -sd ' '; }

# Retry until MariaDB is up and the WordPress container has copied its files into the volume.
for i in $(seq 1 60); do
  wp core install --url=http://wordpress --title=t --admin_user=a --admin_password=a --admin_email=a@example.com --skip-email >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo 'FAIL: WordPress did not come up'; exit 1; }
  sleep 3
done
wp plugin install woocommerce --activate >/dev/null
wp plugin activate gateway-crypto >/dev/null
wp option update woocommerce_currency USD >/dev/null
wp option update woocommerce_gateway_crypto_settings --format=json \
  '{"enabled":"yes","title":"Pay with USDT","description":"d","api_url":"http://mock","secret_key":"sk_test_e2e","webhook_secret":"whsec_e2e","token":"nexis:usdt","expires_min":"30"}' >/dev/null

out="$(wp eval-file /e2e/order.php)"
expect 'gateway available for a USD store' 'available=true' "$out"
expect 'pay page reuses the open invoice' 'reused=true' "$out"
read -r id inv < <(echo "$out" | sed -n 's/^order=\([0-9]*\).*/\1/p;s/^invoice=//p' | paste -sd ' ')

expect 'bad signature refused' '"status":401' "$(hook "$inv/detected/0?secret=whsec_wrong")"
hook "$inv/detected/0" >/dev/null
expect 'detected: on hold' 'status=on-hold' "$(wp eval-file /e2e/status.php "$id")"
hook "$inv/paid/25" >/dev/null
hook "$inv/paid/25" >/dev/null
s="$(wp eval-file /e2e/status.php "$id")"
expect 'paid: processing, invoice as transaction id' "status=processing paid_tx=$inv" "$s"
[ "$(grep -c 'payment confirmed' <<<"$s")" = 1 ] && echo 'ok: retried webhook adds no duplicate note' || { echo 'FAIL: duplicate note'; exit 1; }

read -r id inv < <(order)
hook "$inv/expired/0" >/dev/null
expect 'expired: cancelled' 'status=cancelled' "$(wp eval-file /e2e/status.php "$id")"

read -r id inv < <(order)
hook "$inv/underpaid/20" >/dev/null
expect 'underpaid: on hold with amounts' '20 of 25 received' "$(wp eval-file /e2e/status.php "$id")"

read -r id inv < <(order)
wp eval-file /e2e/edit.php "$id" >/dev/null
hook "$inv/paid/25" >/dev/null
expect 'paid invoice for a changed order total: held, not completed' 'status=on-hold' "$(wp eval-file /e2e/status.php "$id")"

read -r id inv < <(order)
hook "$inv/paid/25?secret=whsec_wrong" >/dev/null
wp eval "do_action('woocommerce_thankyou_gateway_crypto', $id);" >/dev/null
expect 'no webhook: thank-you page catches up' 'status=processing' "$(wp eval-file /e2e/status.php "$id")"

read -r id inv < <(order)
hook "$inv/expired/0?secret=whsec_wrong" >/dev/null # expiry webhook lost: the order is still pending
out="$(wp eval-file /e2e/retry.php "$id")"
expect 'pay again after expiry: new invoice (order ref gets a suffix, no 409)' '^success ' "$out"
inv2="${out##* }"
[ "$inv2" != "$inv" ] && echo 'ok: a different invoice' || { echo 'FAIL: same invoice reused'; exit 1; }
hook "$inv/expired/0" >/dev/null # the old invoice's webhook arrives late
expect 'old invoice expiring does not cancel the order' 'status=pending' "$(wp eval-file /e2e/status.php "$id")"
hook "$inv2/paid/25" >/dev/null
expect 'second invoice paid: processing' "status=processing paid_tx=$inv2" "$(wp eval-file /e2e/status.php "$id")"

# Gateway risk review (D-094): held, then released or rejected.
read -r id inv < <(order)
hook "$inv/held/25" >/dev/null
expect 'held for review: on hold' 'held for review' "$(wp eval-file /e2e/status.php "$id")"
hook "$inv/paid/25" >/dev/null
expect 'released: processing' 'status=processing' "$(wp eval-file /e2e/status.php "$id")"
read -r id inv < <(order)
hook "$inv/held/25" >/dev/null
hook "$inv/failed/25" >/dev/null
expect 'rejected: failed' 'status=failed' "$(wp eval-file /e2e/status.php "$id")"

echo 'e2e ok'
