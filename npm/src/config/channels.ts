/**
 * Splitting a provider's `content` into the channels it should have used.
 *
 * The chat protocol has three separate channels — visible text, reasoning, and
 * structured tool calls — and this client handles all three. Not every provider
 * behind the gateway uses them. A bridged or scraped backend with no native
 * function calling and no reasoning field inlines both into `content` as
 * markup:
 *
 *     <think>Adjusting response style…</think>
 *     <tool>{"name":"index_workspace","arguments":{}}</tool>
 *
 * Everything in `content` used to be classified as visible text, so that markup
 * reached the transcript and was rendered as the assistant's prose: the model's
 * private reasoning and the raw tool envelope, printed to the user. That is an
 * event-classification bug, not a rendering one, and this is the layer where
 * provider-shaped data becomes the harness's typed channels — so this is where
 * it is fixed.
 *
 * The splitter is a state machine rather than a regex over the finished string,
 * because content arrives in deltas and a marker can be cut anywhere:
 *
 *     "<thi" | "nk>" | "internal" | "</thi" | "nk>"
 *
 * A regex per chunk would emit `<thi` as prose and then take it back, which in
 * a terminal means it has already been printed. So text is only released once
 * it cannot turn out to be the start of a marker: any tail that is still a
 * viable prefix of an opening tag is held until the next chunk resolves it.
 *
 * Pure and synchronous. It knows nothing about the terminal, the engine, or
 * HTTP; it is exercised directly, one chunk at a time, in the tests.
 */

/** Tags whose contents are the model's private reasoning. Never user-visible. */
const REASONING_TAGS = ['think', 'thinking', 'thought', 'analysis', 'reasoning', 'scratchpad'] as const;
/** Tags whose contents are a tool-call envelope that should have been structured. */
const TOOL_TAGS = ['tool', 'tool_call', 'tool_use', 'function_call', 'function', 'invoke'] as const;

const KIND_OF = new Map<string, 'reasoning' | 'tool'>([
  ...REASONING_TAGS.map((tag) => [tag, 'reasoning'] as const),
  ...TOOL_TAGS.map((tag) => [tag, 'tool'] as const),
]);

/** `<think>`, `<tool_call>`, `<invoke name="x">` — an opening tag and its name. */
const OPEN = new RegExp(`<(${[...KIND_OF.keys()].join('|')})(\\s[^<>]*)?>`, 'i');

/**
 * One classified piece of a provider's content stream.
 *
 * `tool` carries the envelope verbatim; parsing it is the caller's job, because
 * what a valid call looks like belongs to the tool layer and not here.
 */
export type ContentPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'tool'; readonly raw: string };

export interface ChannelSplitter {
  /** Classify another delta. Returns only pieces that are safe to release. */
  push(chunk: string): readonly ContentPiece[];
  /** End of stream: release whatever was held back. */
  end(): readonly ContentPiece[];
}

/**
 * Length of the tail of `buffer` that could still become an opening tag.
 *
 * `"a < b"` holds one character until the next chunk proves it is not `<think>`;
 * `"…text<thi"` holds four. Anything shorter than the whole tag is ambiguous
 * until more arrives, and releasing it early is the bug this exists to prevent.
 */
function heldOpenPrefix(buffer: string): number {
  const start = buffer.lastIndexOf('<');
  if (start === -1) return 0;
  const tail = buffer.slice(start).toLowerCase();
  // A complete tag would have been matched already, so any tail containing '>'
  // is settled text.
  if (tail.includes('>')) return 0;
  const viable = [...KIND_OF.keys()].some((tag) => `<${tag}`.startsWith(tail) || tail.startsWith(`<${tag}`));
  return viable ? buffer.length - start : 0;
}

/** Length of the tail of `buffer` that could still become `closing`. */
function heldClosePrefix(buffer: string, closing: string): number {
  const most = Math.min(buffer.length, closing.length - 1);
  for (let take = most; take > 0; take -= 1) {
    if (closing.slice(0, take).toLowerCase() === buffer.slice(buffer.length - take).toLowerCase()) return take;
  }
  return 0;
}

export function createChannelSplitter(): ChannelSplitter {
  let buffer = '';
  let inside: { tag: string; kind: 'reasoning' | 'tool'; body: string } | null = null;

  const drain = (out: ContentPiece[]): void => {
    for (;;) {
      if (inside === null) {
        const open = OPEN.exec(buffer);
        if (open !== null) {
          const before = buffer.slice(0, open.index);
          if (before !== '') out.push({ kind: 'text', text: before });
          const tag = (open[1] ?? '').toLowerCase();
          inside = { tag, kind: KIND_OF.get(tag) ?? 'reasoning', body: '' };
          buffer = buffer.slice(open.index + open[0].length);
          continue;
        }
        const hold = heldOpenPrefix(buffer);
        const release = buffer.slice(0, buffer.length - hold);
        if (release !== '') out.push({ kind: 'text', text: release });
        buffer = buffer.slice(buffer.length - hold);
        return;
      }

      const closing = `</${inside.tag}>`;
      const at = buffer.toLowerCase().indexOf(closing);
      if (at !== -1) {
        const body = inside.body + buffer.slice(0, at);
        // Reasoning has already been streamed out piece by piece; only a tool
        // envelope is withheld until it is whole, because half a JSON object is
        // not a tool call.
        if (inside.kind === 'tool') out.push({ kind: 'tool', raw: body.trim() });
        else if (buffer.slice(0, at) !== '') out.push({ kind: 'reasoning', text: buffer.slice(0, at) });
        buffer = buffer.slice(at + closing.length);
        inside = null;
        continue;
      }

      const hold = heldClosePrefix(buffer, closing);
      const take = buffer.slice(0, buffer.length - hold);
      if (take !== '') {
        if (inside.kind === 'tool') inside.body += take;
        else out.push({ kind: 'reasoning', text: take });
      }
      buffer = buffer.slice(buffer.length - hold);
      return;
    }
  };

  return {
    push(chunk: string): readonly ContentPiece[] {
      if (chunk === '') return [];
      const out: ContentPiece[] = [];
      buffer += chunk;
      drain(out);
      return out;
    },
    end(): readonly ContentPiece[] {
      const out: ContentPiece[] = [];
      if (inside !== null) {
        // A block the provider never closed. Its contents are still whatever
        // the tag said they were, so they are still not prose: unterminated
        // reasoning is reported as reasoning and an unterminated envelope is
        // dropped, because a half-written tool call cannot be run and must not
        // be shown.
        if (inside.kind === 'reasoning' && buffer !== '') out.push({ kind: 'reasoning', text: buffer });
        buffer = '';
        inside = null;
        return out;
      }
      // Held text that never became a tag — a bare '<' at the end of a reply.
      if (buffer !== '') out.push({ kind: 'text', text: buffer });
      buffer = '';
      return out;
    },
  };
}

/** Split a whole, non-streamed body. The same machine, fed once. */
export function splitContent(content: string): readonly ContentPiece[] {
  const splitter = createChannelSplitter();
  return [...splitter.push(content), ...splitter.end()];
}

/**
 * A tool-call envelope the provider wrote as text, as a structured call.
 *
 * Accepts the field names these backends actually use for the same thing, and
 * returns null for anything that is not recognisably a call — an envelope that
 * cannot be understood is dropped rather than guessed at, because the guess
 * would be a tool invocation.
 */
export function parseInlineToolCall(raw: string, index: number): { id: string; name: string; arguments: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const name = record.name ?? record.tool ?? record.function;
  if (typeof name !== 'string' || name.trim() === '') return null;
  const args = record.arguments ?? record.parameters ?? record.input ?? record.args ?? {};
  const serialised = typeof args === 'string' ? args : JSON.stringify(args);
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : `inline-${index}`;
  return { id, name: name.trim(), arguments: serialised };
}
