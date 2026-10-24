import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.js';

test('parses header and rows', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n3,4\n'), [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
});

test('handles BOM, CRLF, and no trailing newline', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2'), [{ a: '1', b: '2' }]);
});

test('handles quoted commas, newlines, and doubled quotes', () => {
  const rows = parseCsv('name,note\n"Smith, J","say ""hi""\nthere"\n');
  assert.deepEqual(rows, [{ name: 'Smith, J', note: 'say "hi"\nthere' }]);
});

test('skips blank lines and fills missing trailing fields', () => {
  assert.deepEqual(parseCsv('a,b\n1\n\n'), [{ a: '1', b: '' }]);
});

test('empty input yields no rows', () => {
  assert.deepEqual(parseCsv(''), []);
});
