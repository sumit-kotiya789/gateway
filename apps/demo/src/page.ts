// The demo's single page (no build step): HTML shell, styles and a small script. Served by server.ts with a strict CSP
// (no inline script or style).

export const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo game wallet</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <header class="top">
    <div class="brand"><span class="mark">◆</span> Crypto Quest <small>demo game wallet</small></div>
    <button id="logout" class="ghost hidden">Log out</button>
  </header>
  <main>
    <section id="login" class="card narrow hidden">
      <h1>Your game wallet</h1>
      <p class="muted">A demo web3 game that uses the payment gateway: every player gets a permanent USDT deposit address, deposits are credited automatically, and players can withdraw to their own wallet.</p>
      <form id="login-form">
        <label>Player name <input id="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_-]+" autocomplete="username" placeholder="e.g. sumit" /></label>
        <button type="submit">Enter the game</button>
      </form>
      <p class="hint">Demo only: the name is the login. Test mode, BSC testnet.</p>
    </section>

    <section id="wallet" class="hidden">
      <div class="grid">
        <div class="card balance">
          <p class="label">Balance</p>
          <p class="big"><span id="balance">0</span> <span class="sym"></span></p>
          <p class="muted" id="who"></p>
        </div>
        <div class="card">
          <p class="label">Deposit (BNB Smart Chain testnet, BEP-20)</p>
          <p class="addr"><code id="address"></code> <button id="copy" class="ghost small">Copy</button></p>
          <p class="muted">Send <span class="sym"></span> to this address from any wallet. It is yours permanently; any amount, any time. Credited after confirmations (about a minute).</p>
        </div>
      </div>

      <div class="card" id="withdraw-card">
        <p class="label">Withdraw</p>
        <form id="withdraw-form" class="row">
          <input id="to" required pattern="0x[0-9a-fA-F]{40}" placeholder="Your wallet address 0x…" spellcheck="false" />
          <input id="amount" required inputmode="decimal" pattern="\\d+(\\.\\d+)?" placeholder="Amount" class="amt" />
          <button type="submit">Withdraw</button>
        </form>
        <p class="muted" id="withdraw-note"></p>
        <p class="error" id="withdraw-error"></p>
      </div>

      <div class="grid">
        <div class="card">
          <p class="label">Deposits</p>
          <table><thead><tr><th>Amount</th><th>Status</th><th>When</th></tr></thead><tbody id="deposits"></tbody></table>
        </div>
        <div class="card">
          <p class="label">Withdrawals</p>
          <table><thead><tr><th>Amount</th><th>To</th><th>Status</th></tr></thead><tbody id="withdrawals"></tbody></table>
        </div>
      </div>
    </section>
  </main>
  <script src="/app.js"></script>
</body>
</html>`;

export const APP_CSS = `
:root { color-scheme: dark; --bg: #0b0d14; --card: #141826; --line: #252b3d; --text: #e9ecf5; --muted: #8d95ab; --accent: #f4b740; --ok: #3ddc84; --bad: #ff6b6b; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: radial-gradient(circle at 20% 0%, #1b1f3a, var(--bg) 55%); color: var(--text); min-height: 100vh; }
.top { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.brand { font-weight: 700; font-size: 1.1rem; } .brand small { color: var(--muted); font-weight: 400; margin-left: 6px; } .mark { color: var(--accent); }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 48px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; margin-bottom: 16px; }
.narrow { max-width: 460px; margin: 40px auto; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.label { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: var(--muted); margin: 0 0 8px; }
.big { font-size: 2.2rem; font-weight: 700; margin: 0; color: var(--accent); }
.muted { color: var(--muted); } .hint { color: var(--muted); font-size: .85rem; } .error { color: var(--bad); min-height: 1.2em; }
.addr code { word-break: break-all; font-size: .95rem; }
input { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #0e1220; color: var(--text); font: inherit; }
label { display: grid; gap: 6px; margin: 12px 0; }
button { padding: 10px 16px; border-radius: 10px; border: 0; background: var(--accent); color: #1a1300; font-weight: 700; cursor: pointer; font: inherit; font-weight: 700; }
button.ghost { background: transparent; color: var(--text); border: 1px solid var(--line); font-weight: 500; } button.small { padding: 4px 10px; }
.row { display: flex; gap: 10px; flex-wrap: wrap; } .row input { flex: 1 1 240px; } .row .amt { flex: 0 1 140px; }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); font-size: .9rem; }
.st-settled, .st-confirmed { color: var(--ok); } .st-failed { color: var(--bad); }
.hidden { display: none; }
`;

export const APP_JS = `
const $ = (id) => document.getElementById(id);
const api = async (method, path, body) => {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'request failed'), { status: r.status });
  return j;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => a ? a.slice(0, 8) + '…' + a.slice(-6) : '';
let timer = null;

async function refresh() {
  let me;
  try { me = await api('GET', '/api/me'); } catch (e) { if (e.status === 401) return show(false); throw e; }
  show(true);
  $('balance').textContent = me.balance;
  document.querySelectorAll('.sym').forEach((n) => { n.textContent = me.symbol; });
  $('who').textContent = 'Player ' + me.username;
  $('address').textContent = me.address;
  $('withdraw-card').classList.toggle('hidden', false);
  $('withdraw-form').classList.toggle('hidden', !me.can_withdraw);
  $('withdraw-note').textContent = me.can_withdraw ? 'Sent automatically within the game operator\\'s limits; a small payout fee applies.' : 'Withdrawals need custody on: this operator receives deposits straight to its own wallet.';
  $('deposits').innerHTML = me.deposits.length ? me.deposits.map((d) => '<tr><td>' + esc(d.amount) + '</td><td class="st-' + esc(d.status) + '">' + esc(d.status) + (d.credited ? ' ✓' : '') + '</td><td>' + new Date(d.at).toLocaleTimeString() + '</td></tr>').join('') : '<tr><td colspan="3" class="muted">No deposits yet</td></tr>';
  $('withdrawals').innerHTML = me.withdrawals.length ? me.withdrawals.map((w) => '<tr><td>' + esc(w.amount) + '</td><td><code>' + esc(short(w.to)) + '</code></td><td class="st-' + esc(w.status) + '">' + esc(w.status) + (w.error ? ' · ' + esc(w.error) : '') + '</td></tr>').join('') : '<tr><td colspan="3" class="muted">No withdrawals yet</td></tr>';
}

function show(loggedIn) {
  $('login').classList.toggle('hidden', loggedIn);
  $('wallet').classList.toggle('hidden', !loggedIn);
  $('logout').classList.toggle('hidden', !loggedIn);
  if (loggedIn && !timer) timer = setInterval(() => { refresh().catch(() => {}); }, 5000);
  if (!loggedIn && timer) { clearInterval(timer); timer = null; }
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('POST', '/api/login', { username: $('username').value }); await refresh(); } catch (err) { alert(err.message); }
});
$('logout').addEventListener('click', async () => { await api('POST', '/api/logout'); show(false); });
$('copy').addEventListener('click', () => { navigator.clipboard.writeText($('address').textContent); $('copy').textContent = 'Copied'; setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500); });
$('withdraw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('withdraw-error').textContent = '';
  try {
    const r = await api('POST', '/api/withdraw', { to: $('to').value, amount: $('amount').value });
    $('amount').value = '';
    $('withdraw-note').textContent = 'Withdrawal ' + r.status + (r.fee && r.fee !== '0' ? ' (payout fee ' + r.fee + ')' : '') + '.';
  } catch (err) { $('withdraw-error').textContent = err.message; }
  await refresh();
});
refresh().catch(() => show(false));
`;
