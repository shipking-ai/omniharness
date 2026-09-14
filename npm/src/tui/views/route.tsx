/**
 * The route lens — what OmniRoute did, and what it cost.
 *
 * This is where the routing detail lives so that the run lens does not have to
 * carry it. The rule the whole view obeys: every figure here was reported by
 * the gateway. Nothing is derived from an assumption, nothing is defaulted to
 * zero, and a session in which the gateway reported nothing shows an honest
 * "not reported yet" rather than a table of zeroes that would read as free,
 * instant and single-attempt.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { clip } from '../format/clip.js';
import { millis, tokens } from '../format/units.js';
import { Field, Heading, LABEL_WIDTH, meterBar } from '../components/atoms.js';
import { contextUse, fallbackHistory, routeFields, usageFields } from '../state/selectors.js';
import type { WindowIndex } from '../format/context.js';
import type { Glyphs, Theme } from '../theme/tokens.js';
import type { AppState } from '../state/types.js';

export interface RouteViewProps {
  readonly state: AppState;
  readonly width: number;
  readonly rows: number;
  readonly theme: Theme;
  readonly glyphs: Glyphs;
  readonly windows: WindowIndex;
}

export function RouteView({ state, width, rows, theme, glyphs, windows }: RouteViewProps): React.ReactElement {
  const route = routeFields(state);
  const usage = usageFields(state);
  const fallbacks = fallbackHistory(state);
  const meter = contextUse(state, windows);

  return <Box flexDirection="column" marginTop={1}>
    <Box flexDirection="row" justifyContent="space-between" width={width}>
      <Heading theme={theme}>route</Heading>
      <Text color={theme.muted}>{state.session.endpoint}</Text>
    </Box>

    {route.map((field) => (
      <Field
        key={field.label}
        label={field.label}
        value={field.value}
        theme={theme}
        width={width}
        color={field.label === 'reason' ? theme.warn : undefined}
      />
    ))}
    {state.route.current === undefined
      ? <Text color={theme.muted}>the gateway has not reported a decision yet</Text>
      : null}

    {meter !== undefined
      ? <Box flexDirection="column" marginTop={1}>
          <Heading theme={theme}>context</Heading>
          <Text>
            <Text color={theme.muted}>{'window'.padEnd(LABEL_WIDTH)}</Text>
            <Text color={meter.zone === 'danger' ? theme.error : meter.zone === 'warn' ? theme.warn : theme.muted}>
              {meterBar(meter.fraction, 12, glyphs)} {Math.round(meter.fraction * 100)}%
            </Text>
            <Text color={theme.muted}>{'  '}{tokens(meter.used)} of {tokens(meter.window)}</Text>
          </Text>
        </Box>
      : null}

    {usage.length > 0
      ? <Box flexDirection="column" marginTop={1}>
          <Heading theme={theme}>measured</Heading>
          {usage.map((field) => (
            <Field key={field.label} label={field.label} value={field.value} theme={theme} width={width} />
          ))}
        </Box>
      : null}

    {fallbacks.length > 0
      ? <Box flexDirection="column" marginTop={1}>
          <Heading theme={theme}>failovers</Heading>
          {fallbacks.slice(0, Math.max(1, rows - 12)).map((decision, index) => (
            <Text key={`${decision.at}-${index}`} color={theme.warn}>
              {glyphs.dot} attempt {decision.attempts + 1} {glyphs.dot} {decision.provider ?? 'unknown provider'}
              <Text color={theme.muted}>
                {decision.reason !== undefined ? ` ${glyphs.dot} ${clip(decision.reason, Math.max(8, width - 34))}` : ''}
                {millis(decision.latencyMs) !== undefined ? ` ${glyphs.dot} ${millis(decision.latencyMs)}` : ''}
              </Text>
            </Text>
          ))}
        </Box>
      : null}
  </Box>;
}
