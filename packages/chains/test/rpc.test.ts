import { describe, expect, it } from 'vitest';
import { resolveRpcUrls } from '../src/index.js';

describe('resolveRpcUrls', () => {
  it('substitutes env placeholders and keeps literal URLs', () => {
    expect(resolveRpcUrls(['https://a.example/${KEY}', 'https://public.example'], { KEY: 'k1' })).toEqual({
      urls: ['https://a.example/k1', 'https://public.example'],
      missing: [],
    });
  });

  it('drops URLs with unset variables instead of sending a blank key', () => {
    expect(resolveRpcUrls(['https://a.example/${KEY}', '${WHOLE_URL}', 'https://b.example'], {})).toEqual({
      urls: ['https://b.example'],
      missing: ['KEY', 'WHOLE_URL'],
    });
  });

  it('drops non-http(s)/ws(s) results', () => {
    expect(resolveRpcUrls(['${U}'], { U: 'file:///etc/passwd' }).urls).toEqual([]);
  });
});
