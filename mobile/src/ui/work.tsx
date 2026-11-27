import {
  useEffect,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  View,
} from 'react-native';
import type { JsonValue } from '../core';
import { Glyph } from './glyph';
import type { GlyphName } from './glyph.types';
import { useReducedMotion } from './primitives';
import { Text, useType } from './text';
import { type Palette, type Status, weights } from './theme';
import { useAccent, usePalette, useStatus, useTheme } from './theme-context';
import { type WorkPhase, workWords } from './work-layout';

/**
 * The Agent's work for one reply as a quiet line over its answer, the same
 * design as the web chat (`DESIGN.md`, "Agent work line"): no sheet of its
 * own, a 12 mark in a gutter as wide as the reply bubble's inline padding so
 * the words sit on the reply's text column, and the steps hanging off a
 * hairline rail through the mark when open.
 */
const GUTTER = 16;
const MARK = 12;
const RAIL = MARK / 2;

/** The current server-clock time, ticking each second while `live`. */
function useServerNow(live: boolean, offset: number): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    if (!live) return;
    const tick = () => setNow(Date.now() + offset);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [live, offset]);
  return now;
}

/** The running marker: an accent dot with a ring that fades out. */
function LiveDot() {
  const accent = useAccent();
  const reduced = useReducedMotion();
  const [ring] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(ring, {
        toValue: 1,
        duration: 1600,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [ring, reduced]);
  return (
    <View style={{ width: 7, height: 7 }}>
      {reduced ? null : (
        <Animated.View
          style={{
            position: 'absolute',
            width: 7,
            height: 7,
            borderRadius: '50%',
            backgroundColor: accent.fill,
            opacity: ring.interpolate({
              inputRange: [0, 1],
              outputRange: [0.5, 0],
            }),
            transform: [
              {
                scale: ring.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 2.6],
                }),
              },
            ],
          }}
        />
      )}
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: accent.fill,
        }}
      />
    </View>
  );
}

function phaseMark(
  phase: WorkPhase,
  c: Palette,
  hue: Status,
): { glyph: GlyphName; color: string; size: number } | undefined {
  switch (phase) {
    case 'failed':
      return { glyph: 'warning', color: hue.danger.ink, size: 11 };
    case 'cancelled':
      return { glyph: 'stop', color: c.inkSoft, size: 9 };
    case 'incomplete':
      return { glyph: 'alert', color: hue.warning.ink, size: 11 };
    default:
      return undefined;
  }
}

export function WorkLine({
  phase,
  startedAt,
  endedAt,
  clockOffset = 0,
  steps,
  current,
  hasProcess,
  expanded,
  onToggle,
}: {
  phase: WorkPhase;
  /** Server-clock milliseconds; null without a known time. */
  startedAt: number | null;
  endedAt: number | null;
  /** Server clock minus this device's, for a line that counts up. */
  clockOffset?: number;
  steps: number;
  current?: string;
  hasProcess: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const c = usePalette();
  const hue = useStatus();
  const type = useType();
  const ticking = phase === 'running' && startedAt !== null && endedAt === null;
  const now = useServerNow(ticking, clockOffset);
  const end = endedAt ?? (ticking ? now : null);
  const words = workWords({
    phase,
    elapsed: startedAt === null || end === null ? null : end - startedAt,
    steps,
    current,
  });
  const mark = phaseMark(phase, c, hue);
  const leadColor = mark && phase !== 'cancelled' ? mark.color : c.inkSoft;
  const line = (pressed: boolean) => (
    <>
      <View
        style={{
          // A larger text size scales the mark past its slot; the words
          // then move over rather than run into it.
          minWidth: MARK,
          marginRight: GUTTER - MARK,
          alignItems: 'center',
        }}
      >
        {phase === 'running' ? (
          <LiveDot />
        ) : mark ? (
          <Glyph name={mark.glyph} size={mark.size} color={mark.color} />
        ) : null}
      </View>
      <Text
        style={[
          type.small,
          { flexShrink: 1, color: pressed ? c.ink : c.inkSoft },
        ]}
        numberOfLines={2}
      >
        <Text
          style={{
            fontWeight: weights.label,
            color: pressed ? c.ink : leadColor,
          }}
        >
          {words.lead}
        </Text>
        {words.rest}
      </Text>
      {hasProcess ? (
        <View
          style={{
            marginLeft: 4,
            transform: [{ rotate: expanded ? '90deg' : '0deg' }],
          }}
        >
          <Glyph name="chevron" size={10} color={c.inkSoft} />
        </View>
      ) : null}
    </>
  );
  const style = {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    maxWidth: '100%',
  } as const;
  return hasProcess ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={words.lead + words.rest}
      onPress={onToggle}
      style={style}
    >
      {({ pressed }) => line(pressed)}
    </Pressable>
  ) : (
    <View style={style} accessible accessibilityLabel={words.lead + words.rest}>
      {line(false)}
    </View>
  );
}

/** The hairline the open process hangs off, on the line's mark. */
export function WorkRail({ children }: PropsWithChildren) {
  const c = usePalette();
  return (
    <View
      style={{
        marginLeft: RAIL - 0.5,
        paddingLeft: GUTTER - RAIL - 0.5,
        borderLeftWidth: 1,
        borderLeftColor: c.hairline,
        // Each step is a full 44-point target; they stack without a gap.
        paddingVertical: 2,
      }}
    >
      {children}
    </View>
  );
}

export type StepState = 'running' | 'done' | 'failed' | 'thinking';

/** One step on the rail. Expands into a mono slip when it has detail. */
export function StepRow({
  state,
  label,
  detail,
  body,
}: {
  state: StepState;
  label: string;
  /** A path or command shown after the label. */
  detail?: string;
  body?: ReactNode;
}) {
  const c = usePalette();
  const hue = useStatus();
  const type = useType();
  const { radii } = useTheme();
  // A running step shows its detail until the reader folds it; a finished
  // one starts folded. One value drives the slip, chevron and state.
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? state === 'running';
  const icon =
    state === 'running' ? (
      <ActivityIndicator
        size="small"
        color={c.inkSoft}
        style={{ transform: [{ scale: 0.6 }] }}
      />
    ) : state === 'failed' ? (
      <Glyph name="warning" size={11} color={hue.danger.ink} />
    ) : state === 'thinking' ? (
      <Glyph name="sparkle" size={11} color={c.inkSoft} />
    ) : (
      <Glyph name="check" size={11} color={c.inkSoft} />
    );
  const status =
    state === 'running'
      ? 'In progress'
      : state === 'failed'
        ? 'Failed'
        : undefined;
  const row = (
    <>
      <View style={{ minWidth: 16, alignItems: 'flex-start' }}>{icon}</View>
      <Text
        style={[type.small, { flexShrink: 1, color: c.ink }]}
        numberOfLines={2}
      >
        {label}
      </Text>
      {detail ? (
        <Text
          style={[type.mono, { flex: 1 }]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {detail}
        </Text>
      ) : (
        <View style={{ flex: 1 }} />
      )}
      {body ? (
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Glyph name="chevron" size={10} color={c.inkSoft} />
        </View>
      ) : null}
    </>
  );
  const rowStyle = {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  } as const;
  return (
    <View>
      {body ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={detail ? `${label}, ${detail}` : label}
          accessibilityValue={status ? { text: status } : undefined}
          onPress={() => setChoice(!open)}
          style={({ pressed }) => [
            rowStyle,
            {
              borderRadius: radii.sm,
              backgroundColor: pressed ? c.hover : 'transparent',
            },
          ]}
        >
          {row}
        </Pressable>
      ) : (
        <View
          style={rowStyle}
          accessible
          accessibilityLabel={detail ? `${label}, ${detail}` : label}
          accessibilityValue={status ? { text: status } : undefined}
        >
          {row}
        </View>
      )}
      {body && open ? (
        <View
          style={{
            marginLeft: 24,
            marginTop: 2,
            marginBottom: 6,
            padding: 12,
            borderRadius: radii.sm,
            backgroundColor: c.muted,
          }}
        >
          {body}
        </View>
      ) : null}
    </View>
  );
}

/** The slip a step opens into: its request and what came back. */
export function StepSlip({
  request,
  output,
  error,
}: {
  request?: JsonValue;
  output?: string;
  error?: boolean;
}) {
  const hue = useStatus();
  const type = useType();
  return (
    <View style={{ gap: 8 }}>
      {request !== undefined ? (
        <Text selectable style={type.mono}>
          {JSON.stringify(request, null, 2)}
        </Text>
      ) : null}
      {output !== undefined ? (
        <Text
          selectable
          style={[type.mono, error && { color: hue.danger.ink }]}
        >
          {output || 'No output.'}
        </Text>
      ) : null}
    </View>
  );
}

function record(value: JsonValue | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

/**
 * A tool's name as the timeline shows it: a Run Command's stated purpose,
 * else its words ("write_file" → "Write file"), as on the web.
 */
export function toolStepLabel(
  name: string,
  args: JsonValue | undefined,
  label?: string,
): string {
  const purpose = record(args)?.purpose;
  if (name === 'run_command' && typeof purpose === 'string' && purpose.trim()) {
    return purpose.replace(/\s+/g, ' ').trim();
  }
  if (label) return label;
  const words = name.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The argument worth showing after the label: a path, else a command. */
export function toolStepDetail(
  args: JsonValue | undefined,
): string | undefined {
  const fields = record(args);
  const value = fields?.path ?? fields?.command;
  return typeof value === 'string' ? value : undefined;
}
