import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/common/config.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toEqual({ NODE_ENV: 'development', HOST: '0.0.0.0', PORT: 3000, LOG_LEVEL: 'info' });
  });

  it('coerces and validates PORT', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('fails fast without echoing values', () => {
    try {
      loadConfig({ NODE_ENV: 'super-secret-value' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('NODE_ENV');
      expect((e as Error).message).not.toContain('super-secret-value');
    }
  });
});
