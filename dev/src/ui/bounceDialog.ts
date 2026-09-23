import type { DialogAction } from "./dialog.js";
import { sanitizeFileName } from "../audio/grouping.js";

/**
 * One channel of one rendered track, as offered in the dialog.
 *
 * Routing is per rendered channel rather than per track because a stereo
 * track renders two channels; routing by track would quietly drop one of them.
 */
export interface BounceSource {
  /** Short marker shown in the row, e.g. the track number. */
  badge: string;
  /** Human label, e.g. `"Gtr Amb (L)"`. */
  label: string;
  /** The mixer setting this channel would get, e.g. `"-6.0 dB · 25R"`. */
  mixerLabel: string;
}

const STATE_PLACEHOLDER = "__MCL_STATE__";

/** Hard ceiling on output channels, matching the dialog's own clamp. */
export const MAX_BOUNCE_CHANNELS = 64;

/** What the user can set in the bounce dialog. */
export interface BounceFormState {
  fileName: string;
  channelCount: number;
  /** Whether to fold each track's volume and pan into the rendered audio. */
  applyMixer: boolean;
  /** One entry per source channel: output channel index, or `null` to skip. */
  assignments: (number | null)[];
}

export interface BounceDialogResult extends BounceFormState {
  action: DialogAction;
}

interface BounceDialogState {
  rangeLabel: string;
  sources: BounceSource[];
  defaultChannelCount: number;
  defaultFileName: string;
  /** Shown when the gain came from the fader-curve approximation. */
  volumeIsApproximate: boolean;
  destination: { path: string; isCustom: boolean };
  initial: BounceFormState | null;
}

/**
 * Describes the range being bounced, e.g. `"5 tracks · bars 9–17 · 0:16"`.
 *
 * Bars assume 4/4 because the SDK exposes no time signature — `Song` has
 * tempo and grid but no numerator or denominator. The beat values are what
 * actually drive the render, so this is a readout only.
 */
export function describeBounceRange(args: {
  trackCount: number;
  startTime: number;
  endTime: number;
  tempo: number;
}): string {
  const beats = Math.max(0, args.endTime - args.startTime);
  const seconds = args.tempo > 0 ? (beats / args.tempo) * 60 : 0;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);

  const startBar = Math.floor(args.startTime / 4) + 1;
  const endBar = Math.floor(args.endTime / 4) + 1;

  return [
    `${args.trackCount} ${args.trackCount === 1 ? "track" : "tracks"}`,
    `bars ${startBar}–${endBar}`,
    `${minutes}:${String(remainder).padStart(2, "0")}`,
  ].join(" · ");
}

export function buildBounceDialogUrl(
  template: string,
  args: {
    rangeLabel: string;
    sources: BounceSource[];
    defaultFileName: string;
    volumeIsApproximate: boolean;
    destination: { path: string; isCustom: boolean };
    initial?: BounceFormState | null;
  },
): string {
  const state: BounceDialogState = {
    rangeLabel: args.rangeLabel,
    sources: args.sources,
    defaultChannelCount: Math.min(MAX_BOUNCE_CHANNELS, Math.max(1, args.sources.length)),
    defaultFileName: args.defaultFileName,
    volumeIsApproximate: args.volumeIsApproximate,
    destination: args.destination,
    initial: args.initial ?? null,
  };

  const serialised = JSON.stringify(state).replace(/</g, "\\u003c");
  const html = template.replace(STATE_PLACEHOLDER, serialised);

  if (html === template) {
    throw new Error(`Bounce dialog template is missing the ${STATE_PLACEHOLDER} placeholder.`);
  }

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function bounceDialogSize(sourceCount: number): { width: number; height: number } {
  return {
    width: 580,
    height: Math.min(800, Math.max(510, 440 + sourceCount * 30)),
  };
}

/**
 * Parses the bounce dialog's reply. Returns `null` when cancelled.
 *
 * Everything is re-validated here rather than trusted: the dialog disables its
 * own confirm button on a clash, but a reply that gets through anyway must not
 * be able to drop a track silently or write outside the chosen folder.
 */
export function parseBounceResult(raw: string, sourceCount: number): BounceDialogResult | null {
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;

  const action: DialogAction =
    value.action === "changeFolder" || value.action === "resetFolder" ? value.action : "confirm";

  const channelCount = Math.min(
    MAX_BOUNCE_CHANNELS,
    Math.max(1, Math.floor(typeof value.channelCount === "number" ? value.channelCount : 1)),
  );

  const rawAssignments = Array.isArray(value.assignments) ? value.assignments : [];
  if (rawAssignments.length !== sourceCount) {
    throw new Error("The dialog returned a routing that does not match the selection. Try again.");
  }

  const assignments = rawAssignments.map((entry) =>
    typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry < channelCount
      ? entry
      : null,
  );

  // Only enforce a usable routing on confirm; a folder change carries whatever
  // half-finished state the user had.
  if (action === "confirm") {
    const used = new Set<number>();
    for (const entry of assignments) {
      if (entry === null) continue;
      if (used.has(entry)) {
        throw new Error(
          `Two sources are assigned to channel ${entry + 1}. Give each its own channel.`,
        );
      }
      used.add(entry);
    }
    if (used.size === 0) throw new Error("Nothing is assigned to a channel.");
  }

  // A name from a text field goes straight into a path, so strip anything that
  // could climb out of the destination folder.
  const requested = typeof value.fileName === "string" ? value.fileName : "";
  const fileName = sanitizeFileName(requested.replace(/\.wav$/i, "")) || "Multichannel Bounce";

  return { action, fileName, channelCount, applyMixer: value.applyMixer === true, assignments };
}
