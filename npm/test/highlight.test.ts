import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightCode } from '../src/tui/format/highlight.js';

const colorOf = (line: { text: string; color?: string }[], text: string): string | undefined =>
  line.find((s) => s.text === text)?.color;

// json is in the highlightable set, and there is a dedicated JSON
// highlighter that colours keys, strings, numbers and literals. The renderer
// the app actually calls reached only the generic keyword highlighter, so
// every JSON block rendered as if the JSON highlighter did not exist.
test('highlights a JSON block with the JSON highlighter', () => {
  const [line] = highlightCode(['{"name": "omniharness", "port": 20128, "on": true}'], 'json', 200);
  assert.ok(line, 'expected a highlighted line');
  assert.equal(colorOf(line, '"name"'), 'green', 'JSON keys/strings should use the string colour');
  assert.equal(colorOf(line, '20128'), 'yellow', 'JSON numbers should use the number colour');
  assert.equal(colorOf(line, 'true'), 'cyan', 'JSON literals should use the literal colour');
});

// The characters must survive highlighting exactly, or the hard-slicing that
// wraps long lines would corrupt the output.
test('preserves the JSON line exactly', () => {
  const src = '{"a": 1, "b": [true, null]}';
  const [line] = highlightCode([src], 'json', 200);
  assert.equal(line?.map((s) => s.text).join(''), src);
});

test('still highlights a non-JSON language generically', () => {
  const [line] = highlightCode(['const x = 1;'], 'ts', 200);
  assert.equal(colorOf(line ?? [], 'const'), 'magenta', 'keywords should use the keyword colour');
});

test('leaves an unknown language unstyled', () => {
  const [line] = highlightCode(['whatever this is'], 'brainfuck', 200);
  assert.deepEqual(line, [{ text: 'whatever this is', color: 'cyan' }]);
});

// --- wrapping --------------------------------------------------------------

const rowText = (row: readonly { text: string }[]): string => row.map((s) => s.text).join('');

test('an overlong code line wraps at a break, with the continuation indented', () => {
  const line = "  return { verbose: argv.includes('--verbose') };";
  const rows = highlightCode([line], 'ts', 40).map(rowText);
  assert.ok(rows.length > 1, 'it wraps');
  for (const row of rows) assert.ok(row.length <= 40, `a row of ${row.length} columns: ${JSON.stringify(row)}`);
  // Cut after the "(", not in the middle of the string literal.
  assert.match(rows[0] ?? '', /includes\($/, `first row ${JSON.stringify(rows[0])}`);
  // The continuation hangs past the line's own two-space indent.
  for (const row of rows.slice(1)) assert.match(row, /^ {4}\S/, `continuation ${JSON.stringify(row)}`);
  // Nothing is lost or added but the hang.
  assert.equal(rows[0] + rows.slice(1).map((row) => row.slice(4)).join(''), line);
});

test('a code line with nowhere to break is still cut to the width', () => {
  const line = 'x'.repeat(95);
  const rows = highlightCode([line], undefined, 40).map(rowText);
  for (const row of rows) assert.ok(row.length <= 40, `a row of ${row.length} columns`);
  assert.equal(rows[0], 'x'.repeat(40));
  assert.equal(rows[0] + rows.slice(1).map((row) => row.slice(2)).join(''), line);
});
