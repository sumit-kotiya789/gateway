// Official token and network marks wherever an amount, token or network is shown (D-112). One symbol (USDT) now lives
// on several networks, so a bare "USDT" is ambiguous: every token carries its network's logo and tag (BEP-20, ERC-20,
// Polygon). Shared with the admin console. Logos are <img> data: URIs (CSP img-src allows data:; no inline styles).
import { logoUri, networkOf, tokenLogo, type LogoKey } from '@gw/networks';

function Logo(props: { logo: LogoKey | null; fallback: string; className: string }) {
  if (props.logo) return <img className={props.className} src={logoUri(props.logo)} alt="" />;
  return <span className={`${props.className} logo-generic`}>{Array.from(props.fallback)[0]?.toUpperCase() ?? '?'}</span>;
}

/** A token's logo with its network's logo as a corner badge. Decorative: the symbol is always written next to it. */
export function TokenIcon(props: { token: string; symbol?: string | null; size?: 'lg' }) {
  const n = props.token.includes(':') ? networkOf(props.token) : undefined;
  return (
    <span className={`token-icon${props.size ? ` ${props.size}` : ''}`} aria-hidden="true">
      <Logo logo={tokenLogo(props.token)} fallback={props.symbol ?? props.token} className="ti-main" />
      {n && <img className="ti-badge" src={logoUri(n.logo)} alt="" />}
    </span>
  );
}

/** [logo] USDT  BEP-20: a token by its official ticker, logo and network tag. `token` is the registry id ("bsc:usdt"). */
export function Asset(props: { token: string; symbol?: string | null; tag?: boolean }) {
  const n = networkOf(props.token);
  const sym = props.symbol ?? props.token;
  return (
    <span className="asset" title={n ? `${sym} on ${n.name}` : props.token}>
      <TokenIcon token={props.token} symbol={sym} />
      <span className="asset-sym">{sym}</span>
      {props.tag !== false && n && <span className="asset-tag">{n.tag}</span>}
    </span>
  );
}

/** 25.5 [logo] USDT BEP-20. */
export function Amount(props: { value: string; token: string; symbol?: string | null; tag?: boolean }) {
  return (
    <span className="amount num">
      {props.value} <Asset token={props.token} symbol={props.symbol ?? null} tag={props.tag ?? true} />
    </span>
  );
}

/** [logo] Ethereum: a network by its official name and logo. Takes a chain id or a token id. */
export function NetworkName(props: { chain: string; label?: string | null }) {
  const n = networkOf(props.chain);
  return (
    <span className="network">
      {n && <img className="net-logo" src={logoUri(n.logo)} alt="" />}
      <span>{props.label ?? n?.name ?? props.chain}</span>
    </span>
  );
}

/** Option text for a native <select> (no images there): "USDT · BEP-20 · BNB Smart Chain". */
export function tokenOptionText(token: string, symbol: string): string {
  const n = networkOf(token);
  return n ? `${symbol} · ${n.tag} · ${n.name}` : `${symbol} · ${token}`;
}

/** Picks a token by its logo, ticker and network (a native <select> cannot show logos). Radio inputs: keyboard works. */
export function TokenPicker(props: { label: string; name: string; tokens: readonly { id: string; symbol: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="field">
      <span id={`${props.name}-label`}>{props.label}</span>
      <div className="token-picker" role="radiogroup" aria-labelledby={`${props.name}-label`}>
        {props.tokens.map((t) => {
          const n = networkOf(t.id);
          return (
            <label key={t.id} className={`token-option${t.id === props.value ? ' on' : ''}`}>
              <input type="radio" name={props.name} value={t.id} checked={t.id === props.value} onChange={() => { props.onChange(t.id); }} />
              <TokenIcon token={t.id} symbol={t.symbol} size="lg" />
              <span className="to-text">
                <b>{t.symbol}</b>
                <small>{n ? `${n.name} · ${n.tag}` : t.id}</small>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
