import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeMcpContent } from '../src/config/omniRoute.js';

describe('describeMcpContent', () => {
  it('keeps text blocks verbatim', () => {
    const out = describeMcpContent([
      { type: 'text', text: 'Scene: 3 objects' },
      { type: 'text', text: 'Camera at (7, -7, 5)' },
    ]);
    assert.equal(out, 'Scene: 3 objects\nCamera at (7, -7, 5)');
  });

  // The bug: a screenshot arrives as an image block with base64 data and no
  // text at all. Reading only text blocks turned that into an empty string
  // with no error — a call that looks successful and returns nothing.
  it('describes an image block instead of dropping it', () => {
    const out = describeMcpContent([{ type: 'image', data: 'aGVsbG8gd29ybGQ=', mimeType: 'image/png' }]);
    assert.notEqual(out, '', 'an image-only result produced empty output');
    assert.match(out, /image/);
    assert.match(out, /image\/png/);
    assert.match(out, /bytes/);
  });

  it('keeps text alongside a non-text block', () => {
    const out = describeMcpContent([
      { type: 'text', text: 'rendered' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);
    assert.match(out, /rendered/);
    assert.match(out, /image\/png/);
  });

  it('reports an empty non-text block rather than skipping it', () => {
    const out = describeMcpContent([{ type: 'image', mimeType: 'image/png' }]);
    assert.match(out, /empty/);
  });

  it('names an unknown block type and mime rather than guessing', () => {
    const out = describeMcpContent([{ data: 'AAAA' }]);
    assert.match(out, /binary/);
    assert.match(out, /unknown type/);
  });

  it('is empty for no blocks', () => {
    assert.equal(describeMcpContent([]), '');
  });

  it('drops empty text blocks so they do not become blank lines', () => {
    const out = describeMcpContent([{ type: 'text', text: '' }, { type: 'text', text: 'kept' }]);
    assert.equal(out, 'kept');
  });
});
