/**
 * Turning a thrown value into something a person can act on.
 *
 * Two different failures arrive here wearing the same clothes. Node's fetch
 * throws a bare `fetch failed` for every connection problem, which names
 * neither what was being reached nor what to do about it. And the gateway
 * answers some failures with a paragraph written for whoever maintains the
 * gateway — true, but addressed to the wrong reader.
 *
 * The rule throughout: an error that already says something useful is passed
 * through byte for byte. Rewriting is for the cases where the original text
 * has been read and understood, never a category substituted for a reason.
 */

import { activeGlyphs as g } from '../theme/tokens.js';

/** Connection problems, which fetch reports without saying what it could not reach. */
const UNREACHABLE = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|terminated/i;

/** `OmniRoute 504: ` — the prefix this client puts on a gateway error of its own. */
const STATUS_PREFIX = /^OmniRoute (\d{3}): /;

/**
 * The same status repeated inside the body the gateway sent: `OmniRoute 504:
 * [504]: …`. Ours, then theirs, saying the same thing twice before the
 * sentence starts.
 */
const DOUBLED_STATUS = /^(OmniRoute (\d{3}): )\[\2\]:[ \t]*/;

/**
 * The limiter deadline, in the wall below. `maxWaitMs` is a specific knob with
 * a specific name, which is what makes this safe to recognise: nothing else
 * says it.
 */
const QUEUE_DEADLINE = /maxWaitMs\s*=\s*(\d+)\s*ms/i;

/**
 * `for gemini-web/gemini-3.1-flash-lite` — provider and model, the two names
 * worth keeping.
 *
 * The match has to end on a word character. A model name may contain dots, so
 * a class that ends on one swallows the full stop that ends the sentence and
 * reports a model called `gemini-3.1-flash-lite.`, which is not a model.
 */
const TARGET = /\bfor\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._-]*[A-Za-z0-9_-])/;

export function explainFailure(reason: unknown, endpoint: string): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const cause = reason instanceof Error && reason.cause instanceof Error ? reason.cause.message : '';
  if (UNREACHABLE.test(message) || UNREACHABLE.test(cause)) {
    return `cannot reach OmniRoute at ${endpoint} ${g().dash} check that it is running, `
      + 'or point OMNIROUTE_URL somewhere else. `omniharness doctor` reports the full picture.';
  }
  return explainGateway(message);
}

/**
 * The one gateway failure whose own wording actively misleads the person
 * reading it.
 *
 *     OmniRoute 504: [504]: Request exceeded OmniRoute's local rate-limit
 *     execution expiration (legacy resilienceSettings.requestQueue.maxWaitMs=
 *     60000ms) for gemini-web/gemini-3.1-flash-lite. Bottleneck applies this
 *     deadline only after dispatch; it does not bound queue wait and is not an
 *     upstream-generated timeout.
 *
 * Three facts are in there and all three are load-bearing: a 60 second
 * deadline, which model it was for, and — the second sentence, the one that
 * looks most like noise — that the deadline is OmniRoute's own and the
 * provider never timed out. A reader who skims this concludes the model is
 * down and goes looking in the wrong place. Everything else is the name of the
 * limiter library and the history of which setting is legacy.
 *
 * So this keeps those three facts and the status code, and drops the rest. It
 * is not a summary of an unread string: the deadline and the model are read
 * out of the text, and if the text does not carry them it is left alone.
 *
 * Every other message returns unchanged. `OmniRoute 401: invalid api key` is
 * already the whole story, and a shorter category name in its place would be a
 * worse error, not a better one.
 */
export function explainGateway(message: string): string {
  const flat = message.replace(DOUBLED_STATUS, (_match, prefix: string) => prefix);
  const deadline = QUEUE_DEADLINE.exec(flat);
  if (deadline === null) return flat;

  const ms = Number(deadline[1]);
  const status = STATUS_PREFIX.exec(flat)?.[1];
  const target = TARGET.exec(flat)?.[1];

  const head = status !== undefined ? `OmniRoute ${status}: ` : '';
  const on = target !== undefined ? ` on ${target}` : '';
  const after = Number.isFinite(ms) && ms > 0 ? ` after ${humanMs(ms)}` : '';

  return `${head}stopped waiting${on}${after} ${g().dash} its own limiter set that deadline, `
    + 'not the provider. Retry, or raise resilienceSettings.requestQueue.maxWaitMs.';
}

/**
 * A duration a person reads at a glance. `60000ms` is a number to be converted
 * before it means anything; `60s` is already the answer.
 */
function humanMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${round(seconds)}s`;
  return `${round(seconds / 60)}m`;
}

const round = (value: number): string => String(Math.round(value * 10) / 10);
