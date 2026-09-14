import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, byId, search } from '../src/tui/commands/registry.js';
import { accept, completions, isSlash, parseSlash } from '../src/tui/commands/slash.js';

test('every command is uniquely named and addressable', () => {
  assert.equal(new Set(COMMANDS.map((command) => command.id)).size, COMMANDS.length);
  assert.equal(new Set(COMMANDS.map((command) => command.name)).size, COMMANDS.length);
  for (const command of COMMANDS) assert.equal(byId(command.id), command);
});

test('every command says what it does, in lower case, without a trailing period', () => {
  for (const command of COMMANDS) {
    assert.ok(command.title.length > 0, `${command.id} has a title`);
    assert.ok(!command.title.endsWith('.'), `${command.id} title is a label, not a sentence`);
    assert.ok(/^[a-z][a-z- ]*$/.test(command.name), `${command.name} is typeable without guessing a capital`);
  }
});

test('an empty query lists everything, in table order', () => {
  assert.deepEqual(search('').map((command) => command.id), COMMANDS.map((command) => command.id));
});

test('a name prefix outranks a match buried in a description', () => {
  const [first] = search('route');
  assert.equal(first?.id, 'view.route');
});

test('a query only matches at the start of a word, so unrelated commands stay out', () => {
  const ids = search('rou').map((command) => command.id);
  assert.ok(ids.includes('view.route'));
  assert.ok(!ids.includes('perm.acceptEdits'), '"through" is not a match for "rou"');
});

test('a query that matches nothing returns nothing rather than the whole table', () => {
  assert.deepEqual(search('zzzz'), []);
});

// --- slash parsing ---------------------------------------------------------

test('plain prompts are not commands', () => {
  assert.equal(isSlash('fix the race'), false);
  assert.equal(parseSlash('fix the race'), null);
});

test('a command with no argument resolves exactly', () => {
  const parsed = parseSlash('/route');
  assert.equal(parsed?.command?.id, 'view.route');
  assert.equal(parsed?.argument, '');
});

test('a two-word command is not shadowed by a shorter one', () => {
  assert.equal(parseSlash('/mode build')?.command?.id, 'mode.build');
  assert.equal(parseSlash('/perms accept-edits')?.command?.id, 'perm.acceptEdits');
});

test('an argument keeps the case and spacing the user typed', () => {
  const parsed = parseSlash('/save My-Session.2');
  assert.equal(parsed?.command?.id, 'session.save');
  assert.equal(parsed?.argument, 'My-Session.2');
});

test('an unknown command resolves to no command rather than to the closest guess', () => {
  const parsed = parseSlash('/rout');
  assert.equal(parsed?.command, undefined);
  assert.equal(parsed?.typed, 'rout');
});

test('completion offers what has been typed so far and nothing else', () => {
  assert.deepEqual(completions('/ro').map((command) => command.name), ['route']);
  assert.ok(completions('/mode ').every((command) => command.name.startsWith('mode ')));
  assert.deepEqual(completions('fix'), []);
});

test('accepting a completion leaves the caret where the argument goes', () => {
  assert.equal(accept(byId('view.route')!), '/route');
  assert.equal(accept(byId('session.save')!), '/save ');
});
