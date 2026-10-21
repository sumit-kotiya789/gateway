import { describe, expect, it } from 'vitest';
import { esc, html, jsonForHtml, raw } from '../../src/modules/checkout/html.js';

describe('html tagged template (escape by default)', () => {
  it('escapes every interpolation', () => {
    const evil = `<script>alert("x")</script>' onerror=x`;
    expect(html`<p title="${evil}">${evil}</p>`.value).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39; onerror=x">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39; onerror=x</p>',
    );
  });

  it('nests SafeHtml without double-escaping, and only raw() bypasses escaping', () => {
    const inner = html`<b>${'a&b'}</b>`;
    expect(html`<div>${inner}</div>`.value).toBe('<div><b>a&amp;b</b></div>');
    expect(html`${raw('<svg></svg>')}`.value).toBe('<svg></svg>');
  });

  it('renders arrays, numbers, and drops null/undefined/false', () => {
    expect(html`${[html`<i>1</i>`, '<2>']}|${42}|${null}${undefined}${false}`.value).toBe('<i>1</i>&lt;2&gt;|42|');
  });

  it('refuses to stringify arbitrary objects', () => {
    expect(() => html`${{ a: 1 }}`).toThrow(TypeError);
    expect(html`${10n}`.value).toBe('10');
  });

  it('esc and jsonForHtml cannot close a script tag', () => {
    expect(esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    const j = jsonForHtml({ s: '</script><script>alert(1)</script>&' });
    expect(j).not.toContain('</script>');
    expect(JSON.parse(j)).toEqual({ s: '</script><script>alert(1)</script>&' });
  });
});
