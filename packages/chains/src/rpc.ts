/**
 * RPC URLs in the registry may reference env vars as `${NAME}` so provider API keys never live in the DB or repo.
 * URLs whose variables are unset are dropped (reported in `missing`), never sent with a blank key.
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
    if (missing.length === before && /^(https?|wss?):\/\//.test(url)) out.push(url);
  }
  return { urls: out, missing };
}
