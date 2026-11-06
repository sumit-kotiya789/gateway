// React refuses to start when react and react-dom differ (minified error #527: a blank page, nothing in the tests).
// Dependabot once bumped only react-dom; this keeps both SPAs on one exact version.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const deps = (app: string) =>
  (JSON.parse(readFileSync(resolve(import.meta.dirname, `../../../${app}/package.json`), 'utf8')) as { dependencies: Record<string, string> }).dependencies;

describe('react versions', () => {
  it.each(['dashboard', 'admin'])('%s: react and react-dom are the same exact version', (app) => {
    const d = deps(app);
    expect(d['react-dom']).toBe(d.react);
  });
});
