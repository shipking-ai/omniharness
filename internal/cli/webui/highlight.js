// A small syntax highlighter.
//
// Written rather than pulled in, for the same reason as everything else here:
// the binary ships one file and fetches nothing. A real grammar-based
// highlighter is a megabyte of JavaScript and a bundler to go with it; this is
// one pass of a combined regular expression per language, which is enough to
// read code by and cannot be wrong in a way that loses characters — the token
// stream is reassembled from the same string it was cut from, so anything the
// scanner does not recognise still appears, unstyled.

(function (root) {
  'use strict';

  const KEYWORDS = {
    go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
    js: 'async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield',
    ts: 'abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends finally for from function if implements import in instanceof interface let namespace new number of private protected public readonly return static string super switch this throw try type typeof var void while yield',
    python: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
    rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while',
    shell: 'case do done elif else esac fi for function if in local return then until while export source alias',
    css: '',
    html: '',
    json: 'true false null',
    yaml: 'true false null yes no',
    toml: 'true false',
    markdown: '',
    text: '',
  };

  // Literal types share one scanner; only the keyword set and a couple of
  // comment forms differ, which is the whole reason this fits in a file.
  const COMMENT = {
    go: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    js: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    ts: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    rust: /\/\/[^\n]*|\/\*[\s\S]*?\*\//,
    css: /\/\*[\s\S]*?\*\//,
    python: /#[^\n]*/,
    shell: /#[^\n]*/,
    yaml: /#[^\n]*/,
    toml: /#[^\n]*/,
    html: /<!--[\s\S]*?-->/,
  };

  const STRING = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/;
  const NUMBER = /\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/;

  function escapeHTML(s) {
    return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
  }

  // highlight returns HTML for one file's text.
  //
  // Everything is escaped on the way out, including the parts that matched
  // nothing: the input is a file from disk, and a file containing "<script>"
  // is completely ordinary.
  function highlight(code, language) {
    if (language === 'markdown' || language === 'text' || !KEYWORDS[language]) {
      if (language !== 'markdown') return escapeHTML(code);
    }

    const words = (KEYWORDS[language] || '').split(' ').filter(Boolean);
    const parts = [];
    if (COMMENT[language]) parts.push('(?<c>' + COMMENT[language].source + ')');
    parts.push('(?<s>' + STRING.source + ')');
    if (words.length) parts.push('(?<k>\\b(?:' + words.join('|') + ')\\b)');
    parts.push('(?<n>' + NUMBER.source + ')');
    // A name immediately followed by "(" is being called or declared. Cheap,
    // and it is most of what makes code skimmable.
    parts.push('(?<f>\\b[A-Za-z_][A-Za-z0-9_]*(?=\\())');

    const scanner = new RegExp(parts.join('|'), 'g');
    let out = '';
    let last = 0;
    let m;
    while ((m = scanner.exec(code)) !== null) {
      // Guard against a zero-width match spinning the loop forever; a
      // catastrophic pattern would otherwise hang the window.
      if (m.index === scanner.lastIndex) { scanner.lastIndex++; continue; }
      out += escapeHTML(code.slice(last, m.index));
      const g = m.groups;
      const cls = g.c ? 'c' : g.s ? 's' : g.k ? 'k' : g.n ? 'n' : 'f';
      out += '<span class="t' + cls + '">' + escapeHTML(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    out += escapeHTML(code.slice(last));
    return out;
  }

  root.OHHighlight = { highlight: highlight, escapeHTML: escapeHTML };
})(window);
