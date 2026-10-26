import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../../src/modules/exports/csv.js';

describe('csv', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    [' padded ', '" padded "'],
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ['+1', "'+1"],
    ['-2', "'-2"],
    ['@sum', "'@sum"],
    ['\tx', "'\tx"], // the prefix makes the tab inner whitespace: no quoting needed
  ])('%j', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('null and undefined are empty; rows end with CRLF', () => {
    expect(csvRow(['a', null, undefined, 3, 4n, true])).toBe('a,,,3,4,true\r\n');
  });
});
