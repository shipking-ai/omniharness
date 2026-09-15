import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createChannelSplitter,
  parseInlineToolCall,
  splitContent,
  type ContentPiece,
} from '../src/config/channels.js';

/** Everything the splitter would let through as user-visible prose. */
const visible = (pieces: readonly ContentPiece[]): string =>
  pieces.filter((piece) => piece.kind === 'text').map((piece) => piece.text).join('');

/** Feed a stream one chunk at a time, collecting every piece and every frame. */
function stream(chunks: readonly string[]): { pieces: ContentPiece[]; frames: string[] } {
  const splitter = createChannelSplitter();
  const pieces: ContentPiece[] = [];
  const frames: string[] = [];
  let shown = '';
  for (const chunk of chunks) {
    const out = splitter.push(chunk);
    pieces.push(...out);
    shown += visible(out);
    // What the transcript would be holding at this instant. In a terminal a
    // frame is printed, not rendered — anything that appears here has been
    // seen, and cannot be taken back.
    frames.push(shown);
  }
  const tail = splitter.end();
  pieces.push(...tail);
  shown += visible(tail);
  frames.push(shown);
  return { pieces, frames };
}

// --- 1. reasoning never reaches prose --------------------------------------

test('provider reasoning is classified as reasoning, not as prose', () => {
  const pieces = splitContent('<think>Adjusting response style. The user said hi.</think>Workspace is empty.');
  assert.equal(visible(pieces), 'Workspace is empty.');
  assert.deepEqual(
    pieces.filter((piece) => piece.kind === 'reasoning').map((piece) => piece.text),
    ['Adjusting response style. The user said hi.'],
    'it is not discarded either — it goes to the channel it belongs to',
  );
});

test('every reasoning tag these providers use is recognised', () => {
  for (const tag of ['think', 'thinking', 'thought', 'analysis', 'reasoning', 'scratchpad']) {
    const pieces = splitContent(`<${tag}>secret working</${tag}>the answer`);
    assert.equal(visible(pieces), 'the answer', `<${tag}> is not prose`);
  }
});

// --- 2. tool envelopes never reach prose -----------------------------------

test('a raw tool envelope is classified as a tool call, not as prose', () => {
  const pieces = splitContent('<tool>{"name":"index_workspace","arguments":{}}</tool>');
  assert.equal(visible(pieces), '', 'nothing of it is printed');
  const tools = pieces.filter((piece): piece is Extract<ContentPiece, { kind: 'tool' }> => piece.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(parseInlineToolCall(tools[0]!.raw, 1)?.name, 'index_workspace');
});

// --- 3 & 4. the envelope becomes the structured contract -------------------

test('an inline envelope parses into the same shape a structured call has', () => {
  const call = parseInlineToolCall('{"name":"read_file","arguments":{"path":"a.go"}}', 1);
  assert.deepEqual(call, { id: 'inline-1', name: 'read_file', arguments: '{"path":"a.go"}' });
});

test('the field names these backends actually use all mean the same thing', () => {
  for (const body of [
    '{"name":"x","arguments":{"a":1}}',
    '{"name":"x","parameters":{"a":1}}',
    '{"name":"x","input":{"a":1}}',
    '{"name":"x","args":{"a":1}}',
  ]) {
    assert.equal(parseInlineToolCall(body, 1)?.arguments, '{"a":1}', body);
  }
  assert.equal(parseInlineToolCall('{"name":"x","arguments":"{\\"a\\":1}"}', 1)?.arguments, '{"a":1}',
    'arguments already serialised are passed through, not double-encoded');
});

test('an envelope that cannot be understood is dropped, never guessed at', () => {
  // A guess here would be a tool invocation, so there is no guess.
  for (const junk of ['not json at all', '{"no":"name"}', '[1,2,3]', '{}', '"a string"', '{"name":"   "}']) {
    assert.equal(parseInlineToolCall(junk, 1), null, junk);
  }
});

// --- 5. ordinary prose is untouched ----------------------------------------

test('ordinary prose passes through exactly', () => {
  const text = 'The name field in package.json is wrong.\n\nFix it and the build passes.';
  assert.equal(visible(splitContent(text)), text);
});

test('prose containing a less-than sign is not mistaken for markup', () => {
  for (const text of ['a < b and c > d', 'use Array<string> here', 'if (x<y) return;', '<div>markup</div>']) {
    assert.equal(visible(splitContent(text)), text, text);
  }
});

// --- 6 & 7. nothing leaks across chunk boundaries --------------------------

test('a reasoning marker split across chunks never flashes into the transcript', () => {
  const { frames } = stream(['Before. <thi', 'nk>', 'internal reasoning', '</thi', 'nk>', 'After.']);
  for (const frame of frames) {
    for (const leak of ['<thi', '<think', 'nk>', 'internal reasoning', '</thi']) {
      assert.ok(!frame.includes(leak), `"${leak}" was visible in frame ${JSON.stringify(frame)}`);
    }
  }
  assert.equal(frames.at(-1), 'Before. After.');
});

test('a tool marker split across chunks never flashes into the transcript', () => {
  const { frames, pieces } = stream(['<to', 'ol>{"name":"index_wor', 'kspace","arguments":{}}</to', 'ol>done']);
  for (const frame of frames) {
    for (const leak of ['<to', 'ol>', 'index_wor', 'name', '{']) {
      assert.ok(!frame.includes(leak), `"${leak}" was visible in frame ${JSON.stringify(frame)}`);
    }
  }
  assert.equal(frames.at(-1), 'done');
  const tools = pieces.filter((piece): piece is Extract<ContentPiece, { kind: 'tool' }> => piece.kind === 'tool');
  assert.equal(parseInlineToolCall(tools[0]?.raw ?? '', 1)?.name, 'index_workspace', 'and it is still a usable call');
});

test('a marker split one character at a time still never leaks', () => {
  const source = 'Start <think>hidden</think> end <tool>{"name":"t"}</tool> done';
  const { frames } = stream([...source]);
  for (const frame of frames) {
    for (const leak of ['<', '>', 'hidden', 'name', 'think', 'tool']) {
      assert.ok(!frame.includes(leak), `"${leak}" leaked in ${JSON.stringify(frame)}`);
    }
  }
  assert.equal(frames.at(-1), 'Start  end  done');
});

test('a block the provider never closes is still not printed', () => {
  const { pieces, frames } = stream(['Answer. <think>never closed and still going']);
  assert.equal(frames.at(-1), 'Answer. ', 'the unterminated block stays out of prose');
  assert.ok(
    pieces.some((piece) => piece.kind === 'reasoning' && piece.text.includes('never closed')),
    'and is reported on the channel it was opened as',
  );
});

test('an unterminated tool envelope is dropped rather than shown or run', () => {
  const { pieces, frames } = stream(['<tool>{"name":"rm","argum']);
  assert.equal(frames.at(-1), '', 'half an envelope is not prose');
  assert.equal(pieces.filter((piece) => piece.kind === 'tool').length, 0, 'and not a call either');
});

test('a bare less-than at the very end of a reply is released, not swallowed', () => {
  const { frames } = stream(['the answer is x <']);
  assert.equal(frames.at(-1), 'the answer is x <');
});

test('reasoning and tools interleaved with prose keep their order and their channels', () => {
  const pieces = splitContent(
    'One. <think>why</think>Two. <tool>{"name":"a"}</tool>Three.',
  );
  assert.equal(visible(pieces), 'One. Two. Three.');
  assert.deepEqual(pieces.map((piece) => piece.kind), ['text', 'reasoning', 'text', 'tool', 'text']);
});
