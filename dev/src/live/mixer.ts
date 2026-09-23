import type { ApiVersion, AudioTrack } from "@ableton-extensions/sdk";

/** Raw parameter readings, straight from the mixer. */
export interface MixerReading {
  volume: { value: number; min: number; max: number; defaultValue: number };
  pan: { value: number; min: number; max: number };
}

/**
 * How the volume parameter's number should be read.
 *
 * The SDK calls these `deviceParameterGetInternal{Value,Min,Max}` and does not
 * say what unit "internal" is in, so it is inferred from the range rather than
 * assumed.
 */
export type VolumeUnit = "db" | "normalized";

export interface ResolvedMixer {
  /** Linear multiplier to apply to the samples. */
  gain: number;
  /** The same figure in dB, for display. `-Infinity` when fully down. */
  gainDb: number;
  /** Normalised to -1 (hard left) … 0 (centre) … +1 (hard right). */
  pan: number;
  volumeUnit: VolumeUnit;
  /**
   * True when the gain came out of the fader-curve approximation rather than a
   * dB reading, i.e. it is close but not guaranteed exact.
   */
  approximate: boolean;
}

/**
 * Live's volume fader, as value → dB anchor points.
 *
 * Only two of these are certain: 0.85 is unity and 1.0 is +6 dB. The rest
 * approximate the curve between them, which the SDK gives no way to query.
 * Values between anchors are interpolated linearly in dB.
 *
 * If a bounce comes out at the wrong level, this table is the thing to
 * correct — compare the dB the bounce dialog prints against Live's own mixer
 * readout and adjust. Nothing else depends on these numbers.
 */
const FADER_CURVE: { value: number; db: number }[] = [
  { value: 0.0, db: -Infinity },
  { value: 0.05, db: -60 },
  { value: 0.1, db: -48 },
  { value: 0.2, db: -34 },
  { value: 0.3, db: -25 },
  { value: 0.4, db: -18 },
  { value: 0.5, db: -12.5 },
  { value: 0.6, db: -8 },
  { value: 0.7, db: -4.5 },
  { value: 0.8, db: -1.5 },
  { value: 0.85, db: 0 },
  { value: 0.9, db: 1.5 },
  { value: 0.95, db: 3.6 },
  { value: 1.0, db: 6 },
];

/** Reads a track's volume and pan. Sends are not part of a pre-FX bounce. */
export async function readMixer<V extends ApiVersion>(
  track: AudioTrack<V>,
): Promise<MixerReading> {
  const mixer = track.mixer;
  const [volumeValue, panValue] = await Promise.all([
    mixer.volume.getValue(),
    mixer.panning.getValue(),
  ]);

  return {
    volume: {
      value: volumeValue,
      min: mixer.volume.min,
      max: mixer.volume.max,
      defaultValue: mixer.volume.defaultValue,
    },
    pan: { value: panValue, min: mixer.panning.min, max: mixer.panning.max },
  };
}

/**
 * Turns raw readings into a linear gain and a normalised pan position.
 *
 * A volume range that dips below -1 is taken to already be in dB and is used
 * as-is; anything else is treated as Live's 0…1 fader position and run through
 * {@link FADER_CURVE}.
 */
export function resolveMixer(reading: MixerReading): ResolvedMixer {
  const { volume, pan } = reading;
  const volumeUnit: VolumeUnit = volume.min < -1 ? "db" : "normalized";

  const gainDb =
    volumeUnit === "db"
      ? volume.value
      : faderValueToDb(normalise(volume.value, volume.min, volume.max));

  return {
    gain: gainDb === -Infinity ? 0 : Math.pow(10, gainDb / 20),
    gainDb,
    pan: normaliseSigned(pan.value, pan.min, pan.max),
    volumeUnit,
    approximate: volumeUnit === "normalized",
  };
}

function normalise(value: number, min: number, max: number): number {
  if (!(max > min)) return value;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Maps a parameter onto -1…+1, treating the midpoint of its range as centre. */
function normaliseSigned(value: number, min: number, max: number): number {
  if (!(max > min)) return 0;
  const centre = (min + max) / 2;
  const span = (max - min) / 2;
  return Math.min(1, Math.max(-1, (value - centre) / span));
}

/** Interpolates the fader curve, linearly in dB between anchor points. */
export function faderValueToDb(value: number): number {
  if (value <= 0) return -Infinity;
  if (value >= 1) return FADER_CURVE[FADER_CURVE.length - 1]!.db;

  for (let i = 1; i < FADER_CURVE.length; i++) {
    const upper = FADER_CURVE[i]!;
    if (value > upper.value) continue;

    const lower = FADER_CURVE[i - 1]!;
    if (lower.db === -Infinity) {
      // Fade the bottom segment out smoothly instead of jumping from silence.
      const ratio = (value - lower.value) / (upper.value - lower.value);
      return upper.db + (1 - ratio) * -60;
    }

    const ratio = (value - lower.value) / (upper.value - lower.value);
    return lower.db + ratio * (upper.db - lower.db);
  }

  return 0;
}

/**
 * Live's pan control is a balance: panning right attenuates the left channel
 * and leaves the right alone. It is not constant-power, so centre is unity on
 * both sides.
 */
export function panGains(pan: number): { left: number; right: number } {
  return {
    left: pan <= 0 ? 1 : Math.max(0, 1 - pan),
    right: pan >= 0 ? 1 : Math.max(0, 1 + pan),
  };
}

/** Formats a gain for display, e.g. `"-6.0 dB"`. */
export function formatDb(db: number): string {
  if (db === -Infinity) return "-∞ dB";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

/** Formats a pan position the way Live shows it: `"C"`, `"25L"`, `"50R"`. */
export function formatPan(pan: number): string {
  const amount = Math.round(Math.abs(pan) * 50);
  if (amount === 0) return "C";
  return `${amount}${pan < 0 ? "L" : "R"}`;
}
