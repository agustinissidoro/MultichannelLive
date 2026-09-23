import * as path from "node:path";
import type { AudioFileInfo, ChannelGroup } from "../audio/types.js";
import type { SplitMode } from "../audio/grouping.js";
import type { AudioTrackChoice } from "../live/placement.js";

/** What the dialog is handed when it opens. Serialised into the page. */
interface DialogState {
  fileName: string;
  fileMeta: string;
  defaultMode: SplitMode;
  startTime: number;
  tracks: AudioTrackChoice[];
  selectedTrackIndexes: number[];
  groupPlans: Record<SplitMode, ChannelGroup[]>;
  colors: { label: string; value: number }[];
  defaultColorIndex: number;
  destination: { path: string; isCustom: boolean };
  /** Restores the user's choices when the dialog is reopened after a change. */
  initial: DialogFormState | null;
}

/** Everything the user can set in the dialog, independent of which file it is. */
export interface DialogFormState {
  mode: SplitMode;
  startTime: number;
  warp: boolean;
  renameTargetTracks: boolean;
  color: number | null;
  /** Kept per mode, so toggling modes does not lose a routing. */
  assignmentsByMode: Record<SplitMode, (number | null)[]>;
}

/**
 * Why the dialog closed. Changing the output folder has to close it, because
 * a WebView cannot open a native folder chooser or call back into the host —
 * `close_and_send` is its only channel. The caller reopens it afterwards with
 * `form` restored.
 */
export type DialogAction = "confirm" | "changeFolder" | "resetFolder";

/** What the dialog sends back. Fields are re-validated before use. */
export interface DialogResult extends DialogFormState {
  action: DialogAction;
  /** The active mode's routing: one entry per group. */
  assignments: (number | null)[];
}

const STATE_PLACEHOLDER = "__MCL_STATE__";

/**
 * Colours offered for the imported clips, as `0xRRGGBB`.
 *
 * Live keeps a fixed 60-entry clip palette and snaps an assigned colour to its
 * nearest entry, so these are approximations of palette hues rather than exact
 * values — what matters is that one import lands on one colour.
 */
export const CLIP_COLORS: { label: string; value: number }[] = [
  { label: "Blue", value: 0x5aa3f2 },
  { label: "Cyan", value: 0x5ad9f2 },
  { label: "Teal", value: 0x5af2c4 },
  { label: "Green", value: 0x5af27a },
  { label: "Lime", value: 0xb7f25a },
  { label: "Yellow", value: 0xf2f25a },
  { label: "Amber", value: 0xffd25e },
  { label: "Orange", value: 0xff9e3d },
  { label: "Red", value: 0xff5a5a },
  { label: "Pink", value: 0xf25a8a },
  { label: "Magenta", value: 0xf25ac4 },
  { label: "Violet", value: 0xb75af2 },
  { label: "Indigo", value: 0x7a7af2 },
  { label: "Grey", value: 0xb0b0b0 },
];

/** Index into {@link CLIP_COLORS} used when the user does not change it. */
export const DEFAULT_CLIP_COLOR_INDEX = 0;

export function describeAudioFile(info: AudioFileInfo): string {
  const minutes = Math.floor(info.durationSeconds / 60);
  const seconds = Math.floor(info.durationSeconds % 60);
  const depth = info.sampleFormat === "float" ? `${info.bitsPerSample}-bit float` : `${info.bitsPerSample}-bit`;

  return [
    `${info.channelCount} ch`,
    `${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 === 0 ? 0 : 1)} kHz`,
    depth,
    `${minutes}:${String(seconds).padStart(2, "0")}`,
  ].join(" · ");
}

/**
 * Inlines the dialog state into the page and returns a `data:` URL.
 *
 * `showModalDialog` only accepts a URL, so the state has to travel inside the
 * document. `<` is escaped so no value can break out of the script element.
 */
export function buildDialogUrl(
  template: string,
  args: {
    info: AudioFileInfo;
    originalFileName: string;
    defaultMode: SplitMode;
    startTime: number;
    tracks: AudioTrackChoice[];
    selectedTrackIndexes: number[];
    groupPlans: Record<SplitMode, ChannelGroup[]>;
    destination: { path: string; isCustom: boolean };
    initial?: DialogFormState | null;
  },
): string {
  const state: DialogState = {
    fileName: args.originalFileName,
    fileMeta: describeAudioFile(args.info),
    defaultMode: args.defaultMode,
    startTime: args.startTime,
    tracks: args.tracks,
    selectedTrackIndexes: args.selectedTrackIndexes,
    groupPlans: args.groupPlans,
    colors: CLIP_COLORS,
    defaultColorIndex: DEFAULT_CLIP_COLOR_INDEX,
    destination: args.destination,
    initial: args.initial ?? null,
  };

  const serialised = JSON.stringify(state).replace(/</g, "\\u003c");
  const html = template.replace(STATE_PLACEHOLDER, serialised);

  if (html === template) {
    throw new Error(`Dialog template is missing the ${STATE_PLACEHOLDER} placeholder.`);
  }

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Height that fits the routing table without scrolling, within reason. */
export function dialogSize(groupCount: number): { width: number; height: number } {
  return {
    width: 580,
    height: Math.min(780, Math.max(500, 420 + groupCount * 30)),
  };
}

/**
 * Parses what the dialog posted back. Returns `null` when the user cancelled,
 * which the dialog signals with an empty string.
 */
export function parseDialogResult(raw: string, groupCounts: Record<SplitMode, number>): DialogResult | null {
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;

  const mode: SplitMode = value.mode === "stereo" ? "stereo" : "mono";

  const byMode = (value.assignmentsByMode ?? {}) as Record<string, unknown>;

  // The routing for the mode being confirmed has to line up with the file
  // exactly. A mismatch means the reply does not belong to this dialog, and
  // quietly padding it would place clips somewhere the user never chose.
  const activeRaw = Array.isArray(byMode[mode]) ? byMode[mode] : value.assignments;
  if (!Array.isArray(activeRaw) || activeRaw.length !== groupCounts[mode]) {
    throw new Error("The dialog returned a routing that does not match the file. Try again.");
  }

  // The inactive mode's routing only ever re-seeds a reopened dialog, so it is
  // padded rather than rejected.
  const assignmentsByMode: Record<SplitMode, (number | null)[]> = {
    mono: normaliseAssignments(mode === "mono" ? activeRaw : byMode.mono, groupCounts.mono),
    stereo: normaliseAssignments(mode === "stereo" ? activeRaw : byMode.stereo, groupCounts.stereo),
  };

  const assignments = assignmentsByMode[mode];

  const action: DialogAction =
    value.action === "changeFolder" || value.action === "resetFolder" ? value.action : "confirm";

  // Only a colour we actually offered is accepted, so a malformed reply can
  // never push an arbitrary integer into Live.
  const color =
    typeof value.color === "number" && CLIP_COLORS.some((c) => c.value === value.color)
      ? value.color
      : null;

  return {
    action,
    mode,
    startTime: typeof value.startTime === "number" && value.startTime >= 0 ? value.startTime : 0,
    warp: value.warp === true,
    renameTargetTracks: value.renameTargetTracks === true,
    color,
    assignments,
    assignmentsByMode,
  };
}

/** Coerces a routing from the dialog into exactly `length` valid entries. */
function normaliseAssignments(raw: unknown, length: number): (number | null)[] {
  const entries = Array.isArray(raw) ? raw : [];
  return Array.from({ length }, (_, index) => {
    const entry = entries[index];
    return typeof entry === "number" && Number.isInteger(entry) && entry >= 0 ? entry : null;
  });
}

/** Trims a long path down to something that fits the dialog header. */
export function displayFileName(filePath: string): string {
  return path.basename(filePath);
}
