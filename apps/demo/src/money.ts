// Decimal strings in token units <-> integer minor units (bigint). The gateway API speaks token units.

export function toMinor(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('amount must be a plain decimal like 12.5');
  const [int = '0', frac = ''] = amount.split('.');
  if (frac.length > decimals) throw new Error(`at most ${String(decimals)} decimals`);
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function fromMinor(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${(a / base).toString()}${frac ? `.${frac}` : ''}`;
}
