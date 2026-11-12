/**
 * RPC URLs in the registry may reference env vars as `${NAME}` so provider API keys never live in the DB or repo.
 * URLs whose variables are unset are dropped (reported in `missing`), never sent with a blank key. A URL listed twice
 * (an env var set to one of the public witnesses) is kept once: one provider must never count as two confirmation
 * votes (RPC_QUORUM).
 */
export function resolveRpcUrls(urls: readonly string[], env: Record<string, string | undefined>): { urls: string[]; missing: string[] } {
  const out: string[] = [];
  const missing: string[] = [];
  for (const template of urls) {
    const before = missing.length;
    const url = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
      const v = env[name];
      if (!v) {
        missing.push(name);
        return '';
      }
      return v;
    });
    if (missing.length === before && /^(https?|wss?):\/\//.test(url) && !out.includes(url)) out.push(url);
  }
  return { urls: out, missing };
}
