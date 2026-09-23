import {
  AudioClip,
  AudioTrack,
  DataModelObject,
  TakeLane,
  type ApiVersion,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

/** An existing audio track the user can target, as shown in the dialog. */
export interface AudioTrackChoice {
  /** Index into `song.tracks`. Stable for the lifetime of one dialog. */
  index: number;
  name: string;
}

/** One output file and where it should land. */
export interface ClipPlacement {
  filePath: string;
  clipName: string;
  /** Name to give the track when it is newly created, or when renaming is on. */
  trackName: string;
  /** Index into `song.tracks`, or `null` to create a new audio track. */
  targetIndex: number | null;
}

/**
 * Lists the Set's audio tracks. Group tracks, MIDI tracks, returns and the
 * main track resolve to other classes and are filtered out.
 */
export function listAudioTracks<V extends ApiVersion>(
  context: ExtensionContext<V>,
): AudioTrackChoice[] {
  const choices: AudioTrackChoice[] = [];
  const tracks = context.application.song.tracks;

  for (let index = 0; index < tracks.length; index++) {
    if (tracks[index] instanceof AudioTrack) {
      choices.push({ index, name: tracks[index]!.name });
    }
  }

  return choices;
}

/**
 * Reads the arrangement start position and pre-selected audio tracks out of
 * the selection Live hands to a context-menu command.
 *
 * `selected_lanes` may contain take lanes as well as tracks, so lanes are
 * resolved up to their owning track. A time selection can span MIDI and group
 * tracks too; those are dropped, since only audio tracks can hold the clips
 * and the dialog would have no row to show them on.
 */
export function readArrangementSelection<V extends ApiVersion>(
  context: ExtensionContext<V>,
  selection:
    | { time_selection_start?: number; time_selection_end?: number; selected_lanes?: Handle[] }
    | undefined,
): { startTime: number; endTime: number; selectedTrackIndexes: number[] } {
  const startTime = Math.max(0, selection?.time_selection_start ?? 0);
  const endTime = Math.max(startTime, selection?.time_selection_end ?? startTime);
  const selectedTrackIndexes: number[] = [];

  const tracks = context.application.song.tracks;
  const indexByHandleId = new Map<bigint, number>();
  for (let index = 0; index < tracks.length; index++) {
    indexByHandleId.set(tracks[index]!.handle.id, index);
  }

  for (const handle of selection?.selected_lanes ?? []) {
    let object: DataModelObject<V>;
    try {
      object = context.getObjectFromHandle(handle, DataModelObject);
    } catch {
      continue; // Lane was deleted, or is a type this SDK version cannot name.
    }

    // A take lane's canonical parent is the track that owns it.
    const owner = object instanceof TakeLane ? object.parent : object;
    if (!(owner instanceof AudioTrack)) continue;

    const index = indexByHandleId.get(owner.handle.id);
    if (index !== undefined && !selectedTrackIndexes.includes(index)) {
      selectedTrackIndexes.push(index);
    }
  }

  selectedTrackIndexes.sort((a, b) => a - b);
  return { startTime, endTime, selectedTrackIndexes };
}

export interface PlacementResult {
  clipsCreated: number;
  tracksCreated: number;
}

/**
 * Creates the arrangement clips, adding audio tracks where the plan asks for
 * them.
 *
 * Tracks are created one at a time so they end up in channel order — Live
 * inserts each new track after the current selection, which the previous
 * creation just moved. The clips are then created inside a single transaction
 * so the whole placement collapses into one undo step.
 */
export async function placeClips<V extends ApiVersion>(
  context: ExtensionContext<V>,
  args: {
    placements: ClipPlacement[];
    startTime: number;
    warp: boolean;
    renameTargetTracks: boolean;
    /** Applied to every clip from this import, or `null` for Live's default. */
    color: number | null;
    onProgress?: (message: string) => Promise<void>;
  },
): Promise<PlacementResult> {
  const { placements, startTime, warp, renameTargetTracks, color, onProgress } = args;
  const song = context.application.song;
  const existingTracks = song.tracks;

  const targets: AudioTrack<V>[] = [];
  let tracksCreated = 0;

  for (const placement of placements) {
    if (placement.targetIndex === null) {
      await onProgress?.(`Creating track "${placement.trackName}"…`);
      const track = await song.createAudioTrack();
      track.name = placement.trackName;
      tracksCreated++;
      targets.push(track);
      continue;
    }

    const track = existingTracks[placement.targetIndex];
    if (!(track instanceof AudioTrack)) {
      throw new Error(
        `Track ${placement.targetIndex + 1} is no longer an audio track. ` +
          `Close the dialog and try again.`,
      );
    }

    if (renameTargetTracks) track.name = placement.trackName;
    targets.push(track);
  }

  await onProgress?.("Placing clips…");

  const clips = await context.withinTransaction(() =>
    Promise.all(
      placements.map((placement, index) =>
        targets[index]!.createAudioClip({
          filePath: placement.filePath,
          startTime,
          isWarped: warp,
        }),
      ),
    ),
  );

  // Naming and colouring are plain property writes, so one transaction keeps
  // them out of the undo history as separate steps.
  context.withinTransaction(() => {
    clips.forEach((clip, index) => {
      clip.name = placements[index]!.clipName;
      if (color !== null) clip.color = color;
    });
  });

  return { clipsCreated: clips.length, tracksCreated };
}

/** The source clip's timing, captured before anything is mutated. */
export interface SourceClipSettings {
  startTime: number;
  endTime: number;
  duration: number;
  warping: boolean;
  warpMode: number;
  looping: boolean;
  startMarker: number;
  endMarker: number;
  loopStart: number;
  loopEnd: number;
}

/** Reads everything needed to mirror a clip's trim and warp onto a new one. */
export function readClipSettings<V extends ApiVersion>(clip: AudioClip<V>): SourceClipSettings {
  return {
    startTime: clip.startTime,
    endTime: clip.endTime,
    duration: clip.duration,
    warping: clip.warping,
    warpMode: clip.warpMode,
    looping: clip.looping,
    startMarker: clip.startMarker,
    endMarker: clip.endMarker,
    loopStart: clip.loopStart,
    loopEnd: clip.loopEnd,
  };
}

/**
 * Splits a multichannel clip in place: one duplicate of its track per channel,
 * each carrying the source track's devices, mixer and routing.
 *
 * Duplicates are created back to front because Live inserts each one directly
 * after the original — going in reverse leaves them in channel order.
 *
 * Each duplicate also inherits a copy of the source clip, so the source clip's
 * range is cleared on the duplicate before the mono clip takes its place. Any
 * other clips on the track are duplicated too; that is what duplicating a
 * track means, and they are left untouched.
 */
export async function splitOntoTrackDuplicates<V extends ApiVersion>(
  context: ExtensionContext<V>,
  args: {
    sourceTrack: AudioTrack<V>;
    source: SourceClipSettings;
    groups: { label: string }[];
    filePaths: string[];
    clipNames: string[];
    color: number | null;
    onProgress?: (message: string) => Promise<void>;
  },
): Promise<PlacementResult> {
  const { sourceTrack, source, groups, filePaths, clipNames, color, onProgress } = args;
  const song = context.application.song;
  const sourceName = sourceTrack.name;

  const duplicates: AudioTrack<V>[] = new Array(groups.length);

  for (let index = groups.length - 1; index >= 0; index--) {
    await onProgress?.(`Duplicating track (${index + 1}/${groups.length})…`);

    const duplicate = await song.duplicateTrack(sourceTrack);
    if (!(duplicate instanceof AudioTrack)) {
      throw new Error("Live returned a duplicate that is not an audio track.");
    }

    duplicate.name = `${sourceName} ${groups[index]!.label}`;
    // Drop the copy of the multichannel clip that came with the duplicate.
    await duplicate.clearClipsInRange(source.startTime, source.endTime);
    duplicates[index] = duplicate;
  }

  await onProgress?.("Placing clips…");

  // Mirror the source clip's trim and loop so a trimmed clip stays trimmed.
  const loopSettings = {
    looping: source.looping,
    startMarker: source.startMarker,
    endMarker: source.endMarker,
    loopStart: source.looping ? source.loopStart : source.startMarker,
    loopEnd: source.looping ? source.loopEnd : source.endMarker,
  };

  const clips = await context.withinTransaction(() =>
    Promise.all(
      duplicates.map((track, index) =>
        track.createAudioClip({
          filePath: filePaths[index]!,
          startTime: source.startTime,
          duration: source.duration,
          isWarped: source.warping,
          loopSettings,
        }),
      ),
    ),
  );

  context.withinTransaction(() => {
    clips.forEach((clip, index) => {
      clip.name = clipNames[index]!;
      if (color !== null) clip.color = color;
      if (source.warping) clip.warpMode = source.warpMode;
    });
  });

  return { clipsCreated: clips.length, tracksCreated: duplicates.length };
}
