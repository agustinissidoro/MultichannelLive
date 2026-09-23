import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  AudioClip,
  AudioTrack,
  DataModelObject,
  Sample,
  Track,
  initialize,
  type ActivationContext,
  type ApiVersion,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

// esbuild inlines these HTML files as strings at build time.
import bounceTemplate from "../ui/bounce.html";
import dialogTemplate from "../ui/interface.html";
import messageTemplate from "../ui/message.html";

import { outputFileNameFor, planGroups, sanitizeFileName, uniquePath, type SplitMode } from "./audio/grouping.js";
import { probeNative, probeViaFfmpeg } from "./audio/probe.js";
import { AbortedError, deinterleave } from "./audio/split.js";
import { estimateBounceSize, interleave, type ChannelSource } from "./audio/interleave.js";
import type { AudioFileInfo, ChannelGroup } from "./audio/types.js";
import {
  listAudioTracks,
  placeClips,
  readArrangementSelection,
  readClipSettings,
  splitOntoTrackDuplicates,
  type ClipPlacement,
} from "./live/placement.js";
import {
  CLIPS_FOLDER_NAME,
  resolveClipsDirectory,
  tryCustomDirectory,
  type Destination,
} from "./live/project.js";
import { readSettings, writeSettings } from "./live/settings.js";
import {
  formatDb,
  formatPan,
  panGains,
  readMixer,
  resolveMixer,
  type ResolvedMixer,
} from "./live/mixer.js";
import {
  CLIP_COLORS,
  DEFAULT_CLIP_COLOR_INDEX,
  buildDialogUrl,
  dialogSize,
  displayFileName,
  parseDialogResult,
  type DialogAction,
  type DialogResult,
} from "./ui/dialog.js";
import {
  bounceDialogSize,
  buildBounceDialogUrl,
  describeBounceRange,
  parseBounceResult,
  type BounceDialogResult,
} from "./ui/bounceDialog.js";
import { pickAudioFiles, pickFolder } from "./util/filePicker.js";

const API_VERSION = "1.0.0";

const COMMAND_LOAD = "multichannellive.load";
const COMMAND_LOAD_ON_TRACK = "multichannellive.loadOnTrack";
const COMMAND_SPLIT_CLIP = "multichannellive.splitClip";
const COMMAND_SPLIT_SAMPLE = "multichannellive.splitSample";
const COMMAND_BOUNCE = "multichannellive.bounce";

export function activate(activation: ActivationContext): void {
  const context = initialize(activation, API_VERSION);

  context.commands.registerCommand(COMMAND_LOAD, (...args) => {
    void guard(context, async () => {
      const selection = readArrangementSelection(context, args[0] as never);
      await loadFiles(context, {
        startTime: selection.startTime,
        selectedTrackIndexes: selection.selectedTrackIndexes,
      });
    });
  });

  // Same flow, but reached from a track header, where there is no time
  // selection to read a position from.
  context.commands.registerCommand(COMMAND_LOAD_ON_TRACK, (...args) => {
    void guard(context, async () => {
      const track = resolveHandle(context, args[0], AudioTrack);
      await loadFiles(context, {
        startTime: 0,
        selectedTrackIndexes: compact([track ? trackIndexOf(context, track) : null]),
      });
    });
  });

  context.commands.registerCommand(COMMAND_SPLIT_CLIP, (...args) => {
    void guard(context, async () => {
      const clip = resolveHandle(context, args[0], AudioClip);
      if (!clip) throw new Error("Could not read that clip.");
      await splitClipToMono(context, clip);
    });
  });

  context.commands.registerCommand(COMMAND_SPLIT_SAMPLE, (...args) => {
    void guard(context, async () => {
      const sample = resolveHandle(context, args[0], Sample);
      if (!sample) throw new Error("Could not read that sample.");

      await loadFiles(context, {
        filePaths: [sample.filePath],
        startTime: 0,
        selectedTrackIndexes: [],
      });
    });
  });

  context.commands.registerCommand(COMMAND_BOUNCE, (...args) => {
    void guard(context, () => bounceSelection(context, args[0] as never));
  });

  void context.ui
    .registerContextMenuAction(
      "AudioTrack.ArrangementSelection",
      "Load Multichannel File…",
      COMMAND_LOAD,
    )
    .catch((error: unknown) => console.error("Could not register arrangement action:", error));

  void context.ui
    .registerContextMenuAction(
      "AudioTrack.ArrangementSelection",
      "Multichannel Bounce…",
      COMMAND_BOUNCE,
    )
    .catch((error: unknown) => console.error("Could not register bounce action:", error));

  void context.ui
    .registerContextMenuAction(
      "AudioTrack",
      "Load Multichannel File…",
      COMMAND_LOAD_ON_TRACK,
    )
    .catch((error: unknown) => console.error("Could not register track action:", error));

  void context.ui
    .registerContextMenuAction("AudioClip", "Split to Mono", COMMAND_SPLIT_CLIP)
    .catch((error: unknown) => console.error("Could not register clip action:", error));

  void context.ui
    .registerContextMenuAction("Sample", "Load Multichannel File…", COMMAND_SPLIT_SAMPLE)
    .catch((error: unknown) => console.error("Could not register sample action:", error));

  console.log("MultichannelLive activated");
}

/**
 * Loads one or more multichannel files, asking how to route each one.
 *
 * Files are handled one at a time so every file gets its own routing dialog —
 * channel counts and layouts rarely match across a batch.
 */
async function loadFiles<V extends ApiVersion>(
  context: ExtensionContext<V>,
  args: {
    filePaths?: string[];
    startTime: number;
    selectedTrackIndexes: number[];
  },
): Promise<void> {
  const filePaths = args.filePaths ?? (await pickAudioFiles());
  if (filePaths.length === 0) return;

  const tempDirectory = context.environment.tempDirectory ?? os.tmpdir();

  // Work out where the clips will go before anything else, so an unsaved Set
  // is caught before the user spends time on the routing dialog.
  const destination = await resolveDestination(context, tempDirectory);
  if (!destination) return;
  if (!destination.isSavedProject && !(await confirmUnsavedProject(context, destination))) {
    return;
  }

  for (const filePath of filePaths) {
    await loadOneFile(context, {
      filePath,
      tempDirectory,
      destination,
      startTime: args.startTime,
      selectedTrackIndexes: args.selectedTrackIndexes,
    });
  }
}

/**
 * Works out where de-interleaved files should be written.
 *
 * A folder the user chose wins over the Project folder, and takes the Set's
 * save state out of the picture entirely. If that folder has since become
 * unwritable — an unplugged drive, a deleted folder — we offer the Project
 * folder instead rather than dead-ending, and leave the preference alone so
 * it starts working again when the drive comes back.
 *
 * Returns `null` when the user backed out.
 */
async function resolveDestination<V extends ApiVersion>(
  context: ExtensionContext<V>,
  tempDirectory: string,
): Promise<Destination | null> {
  const settings = await readSettings(context.environment.storageDirectory);

  if (settings.outputDirectory) {
    const custom = await tryCustomDirectory(settings.outputDirectory);
    if (custom) return custom;

    const answer = await showMessage(context, {
      kind: "warning",
      title: "Your chosen output folder is not available",
      body:
        "The folder below could not be opened or written to. It may be on a " +
        "drive that is not connected.\n\n" +
        "You can write into this Set's Project folder instead, or cancel and " +
        "reconnect the drive.",
      path: settings.outputDirectory,
      confirmLabel: "Use the Project folder",
      cancelLabel: "Cancel",
    });
    if (answer !== "ok") return null;
  }

  const project = await resolveClipsDirectory(context, tempDirectory);
  return {
    directory: project.directory,
    isCustom: false,
    isSavedProject: project.isSavedProject,
  };
}

/**
 * Warns that the Set has no Project folder yet and asks whether to continue.
 *
 * Live only creates a Project folder when a Set is saved. Until then there is
 * nowhere durable to put the split files, so they land next to wherever Live
 * currently keeps imported media — a temporary location that Live is free to
 * clean up, and that "Collect All and Save" will not have gathered from.
 */
async function confirmUnsavedProject<V extends ApiVersion>(
  context: ExtensionContext<V>,
  destination: { directory: string },
): Promise<boolean> {
  const answer = await showMessage(context, {
    kind: "warning",
    title: "This Live Set has not been saved",
    body:
      "Without a saved Set there is no Project folder, so the split clips " +
      "would be written to the temporary location below. Live may clear that " +
      "folder, and the clips would go missing.\n\n" +
      "Save the Set first, or continue and use \u201cSave to \u2192 Change\u2026\u201d " +
      "in the next dialog to pick a folder of your own.",
    path: destination.directory,
    confirmLabel: "Continue anyway",
    cancelLabel: "Cancel",
  });

  return answer === "ok";
}

async function loadOneFile<V extends ApiVersion>(
  context: ExtensionContext<V>,
  args: {
    filePath: string;
    tempDirectory: string;
    destination: Destination;
    startTime: number;
    selectedTrackIndexes: number[];
  },
): Promise<void> {
  const { filePath, tempDirectory } = args;
  const info = await probeFile(context, filePath, tempDirectory);

  try {
    const groupPlans: Record<SplitMode, ChannelGroup[]> = {
      mono: planGroups(info, "mono"),
      stereo: planGroups(info, "stereo"),
    };

    const routing = await chooseRouting(context, {
      info,
      originalFileName: displayFileName(filePath),
      startTime: args.startTime,
      selectedTrackIndexes: args.selectedTrackIndexes,
      groupPlans,
      destination: args.destination,
      tempDirectory,
    });

    if (!routing) return; // Cancelled.

    await splitAndPlace(context, {
      info,
      originalFileName: displayFileName(filePath),
      clipsDirectory: routing.destination.directory,
      groups: groupPlans[routing.choice.mode],
      choice: routing.choice,
    });
  } finally {
    // Drop the intermediate WAV that ffmpeg produced, if there was one.
    if (info.decodedFrom) await fs.rm(info.filePath, { force: true }).catch(() => {});
  }
}

/**
 * Shows the routing dialog, reopening it whenever the user changes the output
 * folder.
 *
 * A WebView dialog cannot open a native folder chooser or call back into the
 * host — `close_and_send` is its only channel — so changing the folder means
 * closing the dialog, running the chooser, and opening it again. Everything
 * the user had already set travels out and back in, so nothing is lost.
 *
 * Returns `null` when the user cancelled.
 */
async function chooseRouting<V extends ApiVersion>(
  context: ExtensionContext<V>,
  args: {
    info: AudioFileInfo;
    originalFileName: string;
    startTime: number;
    selectedTrackIndexes: number[];
    groupPlans: Record<SplitMode, ChannelGroup[]>;
    destination: Destination;
    tempDirectory: string;
  },
): Promise<{ choice: DialogResult; destination: Destination } | null> {
  const counts = { mono: args.groupPlans.mono.length, stereo: args.groupPlans.stereo.length };

  const outcome = await withFolderChange<DialogResult>(
    context,
    args.tempDirectory,
    args.destination,
    async (destination, initial) =>
      parseDialogResult(
        await context.ui.showModalDialog(
          buildDialogUrl(dialogTemplate, {
            info: args.info,
            originalFileName: args.originalFileName,
            defaultMode: "mono",
            startTime: args.startTime,
            tracks: listAudioTracks(context),
            selectedTrackIndexes: args.selectedTrackIndexes,
            groupPlans: args.groupPlans,
            destination: { path: destination.directory, isCustom: destination.isCustom },
            initial,
          }),
          ...sizeArgs(Math.max(counts.mono, counts.stereo)),
        ),
        counts,
      ),
  );

  return outcome ? { choice: outcome.result, destination: outcome.destination } : null;
}

/**
 * Bounces the selected tracks over the selected arrangement range into one
 * interleaved multichannel file.
 *
 * Tracks are rendered *before* the routing dialog opens, because a stereo
 * track renders two channels and a mono one renders one — routing per track
 * rather than per rendered channel would quietly drop a stereo track's right
 * side. Rendering first means the dialog can offer exactly the channels that
 * actually exist.
 */
async function bounceSelection<V extends ApiVersion>(
  context: ExtensionContext<V>,
  selection: never,
): Promise<void> {
  const { startTime, endTime, selectedTrackIndexes } = readArrangementSelection(context, selection);

  if (selectedTrackIndexes.length === 0) {
    throw new Error("Select one or more audio tracks in the arrangement, then try again.");
  }
  if (endTime <= startTime) {
    throw new Error("Select a time range in the arrangement, then try again.");
  }

  const allTracks = context.application.song.tracks;
  const tracks = selectedTrackIndexes
    .map((index) => allTracks[index])
    .filter((track): track is AudioTrack<V> => track instanceof AudioTrack);

  if (tracks.length === 0) throw new Error("No audio tracks are selected.");

  const tempDirectory = context.environment.tempDirectory ?? os.tmpdir();
  const destination = await resolveDestination(context, tempDirectory);
  if (!destination) return;
  if (!destination.isSavedProject && !(await confirmUnsavedProject(context, destination))) {
    return;
  }

  // Render first, then route. Renders land in the extension's temp directory.
  const rendered = await renderTracks(context, tracks, startTime, endTime);
  if (!rendered) return;

  try {
    const sources: {
      badge: string;
      label: string;
      mixerLabel: string;
      info: AudioFileInfo;
      channel: number;
      gain: number;
    }[] = [];

    for (const track of rendered) {
      const sides = panGains(track.mixer.pan);

      for (let channel = 0; channel < track.info.channelCount; channel++) {
        const isStereo = track.info.channelCount === 2;
        const side = isStereo ? ` (${track.info.channelNames[channel] ?? channel + 1})` : "";

        // Pan is a left/right balance, so it only means anything on a stereo
        // render. A mono render gets the volume and nothing else.
        const panGain = isStereo ? (channel === 0 ? sides.left : sides.right) : 1;

        sources.push({
          badge: String(track.trackNumber),
          label: `${track.name}${side}`,
          mixerLabel: isStereo
            ? `${formatDb(track.mixer.gainDb)} · pan ${formatPan(track.mixer.pan)}`
            : formatDb(track.mixer.gainDb),
          info: track.info,
          channel,
          gain: track.mixer.gain * panGain,
        });
      }
    }

    const rangeLabel = describeBounceRange({
      trackCount: tracks.length,
      startTime,
      endTime,
      tempo: context.application.song.tempo,
    });

    const outcome = await withFolderChange<BounceDialogResult>(
      context,
      tempDirectory,
      destination,
      async (dest, initial) =>
        parseBounceResult(
          await context.ui.showModalDialog(
            buildBounceDialogUrl(bounceTemplate, {
              rangeLabel,
              sources: sources.map(({ badge, label, mixerLabel }) => ({ badge, label, mixerLabel })),
              defaultFileName: "Multichannel Bounce",
              volumeIsApproximate: rendered.some((track) => track.mixer.approximate),
              destination: { path: dest.directory, isCustom: dest.isCustom },
              initial,
            }),
            bounceDialogSize(sources.length).width,
            bounceDialogSize(sources.length).height,
          ),
          sources.length,
        ),
    );

    if (!outcome) return;

    const { result, destination: chosen } = outcome;
    const channelMap: (ChannelSource | null)[] = new Array(result.channelCount).fill(null);
    result.assignments.forEach((outputChannel, sourceIndex) => {
      if (outputChannel === null) return;
      const source = sources[sourceIndex]!;
      channelMap[outputChannel] = {
        info: source.info,
        channel: source.channel,
        gain: result.applyMixer ? source.gain : 1,
      };
    });

    const outputPath = uniquePath(chosen.directory, `${result.fileName}.wav`);

    const bounceOutcome = await context.ui.withinProgressDialog(
      "Writing the multichannel file…",
      { progress: 0 },
      async (update, signal): Promise<{ ok: boolean; error?: Error; summary?: string }> => {
        try {
          const written = await interleave({
            channelMap,
            outputPath,
            signal,
            onProgress: (fraction) =>
              update("Writing the multichannel file…", Math.round(fraction * 100)),
          });

          return {
            ok: true,
            summary:
              `${written.channelCount} channels · ` +
              `${(written.sampleRate / 1000).toFixed(written.sampleRate % 1000 === 0 ? 0 : 1)} kHz · ` +
              `${written.bitsPerSample}-bit · ` +
              estimateBounceSize(written.channelCount, written.frameCount, written.bitsPerSample),
          };
        } catch (error) {
          if (error instanceof AbortedError) return { ok: false };
          return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
        }
      },
    );

    const bounced = bounceOutcome as { ok: boolean; error?: Error; summary?: string };
    if (bounced.error) throw bounced.error;
    if (!bounced.ok) return;

    await showMessage(context, {
      kind: "info",
      title: "Bounce complete",
      body: bounced.summary ?? "",
      path: outputPath,
    });
  } finally {
    // The renders were only ever scratch input for the interleaver.
    await Promise.all(
      rendered.map((track) => fs.rm(track.info.filePath, { force: true }).catch(() => {})),
    );
  }
}

interface RenderedTrack {
  name: string;
  trackNumber: number;
  info: AudioFileInfo;
  mixer: ResolvedMixer;
}

/**
 * Renders each track's pre-effects audio over the range.
 *
 * Returns `null` if the user cancelled. On any failure the renders already
 * made are deleted, so a cancelled bounce leaves nothing behind in temp.
 */
async function renderTracks<V extends ApiVersion>(
  context: ExtensionContext<V>,
  tracks: AudioTrack<V>[],
  startTime: number,
  endTime: number,
): Promise<RenderedTrack[] | null> {
  const outcome = await context.ui.withinProgressDialog(
    `Rendering ${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}…`,
    { progress: 0 },
    async (update, signal): Promise<{ ok: boolean; error?: Error; rendered?: RenderedTrack[] }> => {
      const rendered: RenderedTrack[] = [];

      try {
        for (let index = 0; index < tracks.length; index++) {
          if (signal.aborted) throw new AbortedError();

          const track = tracks[index]!;
          await update(
            `Rendering "${track.name}" (${index + 1}/${tracks.length})…`,
            Math.round((index / tracks.length) * 100),
          );

          const renderedPath = await context.resources.renderPreFxAudio(track, startTime, endTime);
          const info = await probeNative(renderedPath);
          if (!info) {
            throw new Error(`Live produced a file we could not read for "${track.name}".`);
          }

          // Read the mixer alongside the render, so the dialog can show what
          // each channel's level and pan would become.
          const mixer = resolveMixer(await readMixer(track));

          rendered.push({ name: track.name, trackNumber: index + 1, info, mixer });
        }

        return { ok: true, rendered };
      } catch (error) {
        await Promise.all(
          rendered.map((entry) => fs.rm(entry.info.filePath, { force: true }).catch(() => {})),
        );
        if (error instanceof AbortedError) return { ok: false };
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  );

  const result = outcome as { ok: boolean; error?: Error; rendered?: RenderedTrack[] };
  if (result.error) throw result.error;
  return result.ok ? (result.rendered ?? []) : null;
}

/**
 * Runs a dialog, reopening it whenever the user changes the output folder.
 *
 * A WebView dialog cannot open a native folder chooser or call back into the
 * host — `close_and_send` is its only channel — so changing the folder means
 * closing the dialog, running the chooser, and opening it again. Whatever the
 * dialog posted back is handed straight to the next `show` call as `initial`,
 * so nothing the user had set is lost.
 *
 * Returns `null` when the user cancelled.
 */
async function withFolderChange<T extends { action: DialogAction }>(
  context: ExtensionContext<ApiVersion>,
  tempDirectory: string,
  start: Destination,
  show: (destination: Destination, initial: T | null) => Promise<T | null>,
): Promise<{ result: T; destination: Destination } | null> {
  const storageDirectory = context.environment.storageDirectory;

  let destination = start;
  let initial: T | null = null;

  for (;;) {
    const result = await show(destination, initial);
    if (!result) return null;
    if (result.action === "confirm") return { result, destination };

    initial = result;

    if (result.action === "resetFolder") {
      await writeSettings(storageDirectory, { outputDirectory: null });
      const next = await resolveDestination(context, tempDirectory);
      if (!next) return null;
      destination = next;
      continue;
    }

    const folder = await pickFolder();
    if (!folder) continue; // Chooser cancelled: leave the folder as it was.

    const custom = await tryCustomDirectory(folder);
    if (!custom) {
      await showMessage(context, {
        kind: "error",
        title: "Cannot write to that folder",
        body: "The folder below could not be created or written to. Pick another one.",
        path: folder,
      });
      continue;
    }

    await writeSettings(storageDirectory, { outputDirectory: folder });
    destination = custom;
  }
}

/**
 * Splits a multichannel clip into mono clips on duplicates of its own track,
 * without asking anything: one duplicate per channel, each keeping the source
 * track's devices and mixer, and the source clip muted afterwards.
 */
async function splitClipToMono<V extends ApiVersion>(
  context: ExtensionContext<V>,
  clip: AudioClip<V>,
): Promise<void> {
  const trackIndex = trackIndexOf(context, clip);
  const sourceTrack = trackIndex === null ? null : context.application.song.tracks[trackIndex];
  if (!(sourceTrack instanceof AudioTrack)) {
    throw new Error("This clip is not on an audio track in the arrangement.");
  }

  const tempDirectory = context.environment.tempDirectory ?? os.tmpdir();
  const filePath = clip.filePath;
  const info = await probeFile(context, filePath, tempDirectory);

  try {
    if (info.channelCount < 2) {
      await showMessage(context, {
        kind: "info",
        title: "Nothing to split",
        body: `"${displayFileName(filePath)}" is already mono.`,
      });
      return;
    }

    const destination = await resolveDestination(context, tempDirectory);
    if (!destination) return;
    if (!destination.isSavedProject && !(await confirmUnsavedProject(context, destination))) {
      return;
    }

    // Read the clip's timing before anything is created, so the mono clips can
    // mirror its trim, loop and warp settings exactly.
    const source = readClipSettings(clip);
    const groups = planGroups(info, "mono");
    const baseName = path.parse(displayFileName(filePath)).name;

    const outcome = await context.ui.withinProgressDialog(
      `Splitting ${displayFileName(filePath)} to mono\u2026`,
      { progress: 0 },
      async (update, signal): Promise<{ ok: boolean; error?: Error; clips?: number }> => {
        const outputPaths = groups.map((group) =>
          uniquePath(destination.directory, outputFileNameFor(baseName, group)),
        );
        let placementStarted = false;

        try {
          await deinterleave({
            info,
            groups,
            outputPaths,
            signal,
            onProgress: (fraction) =>
              update(`Splitting ${groups.length} channels\u2026`, Math.round(fraction * 90)),
          });

          if (signal.aborted) throw new AbortedError();

          placementStarted = true;
          const result = await splitOntoTrackDuplicates(context, {
            sourceTrack,
            source,
            groups,
            filePaths: outputPaths,
            clipNames: groups.map((group) => `${baseName} ${group.label}`),
            color: CLIP_COLORS[DEFAULT_CLIP_COLOR_INDEX]!.value,
            onProgress: (message) => update(message, 95),
          });

          // Muting last means a failure above leaves the Set as it was.
          clip.muted = true;

          await update("Done", 100);
          return { ok: true, clips: result.clipsCreated };
        } catch (error) {
          if (!placementStarted) {
            await Promise.all(outputPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})));
          }
          if (error instanceof AbortedError) return { ok: false };
          return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
        }
      },
    );

    const result = outcome as { ok: boolean; error?: Error; clips?: number };
    if (result.error) throw result.error;
    if (result.ok) {
      console.log(`MultichannelLive: split ${displayFileName(filePath)} into ${result.clips} mono clips`);
    }
  } finally {
    if (info.decodedFrom) await fs.rm(info.filePath, { force: true }).catch(() => {});
  }
}

/**
 * Reads the file's header. Containers that need an ffmpeg decode first go
 * behind a progress dialog, since decoding a long recording is not instant and
 * Live would otherwise just appear to hang.
 */
async function probeFile<V extends ApiVersion>(
  context: ExtensionContext<V>,
  filePath: string,
  tempDirectory: string,
): Promise<AudioFileInfo> {
  const native = await probeNative(filePath);
  if (native) return native;

  const outcome = await context.ui.withinProgressDialog(
    `Decoding ${path.basename(filePath)}\u2026`,
    {},
    async (): Promise<{ info?: AudioFileInfo; error?: Error }> => {
      try {
        return { info: await probeViaFfmpeg(filePath, tempDirectory) };
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  );

  const result = outcome as { info?: AudioFileInfo; error?: Error };
  if (result.error) throw result.error;
  return result.info!;
}

async function splitAndPlace<V extends ApiVersion>(
  context: ExtensionContext<V>,
  args: {
    info: AudioFileInfo;
    originalFileName: string;
    clipsDirectory: string;
    groups: ChannelGroup[];
    choice: DialogResult;
  },
): Promise<void> {
  const { info, originalFileName, clipsDirectory, groups, choice } = args;
  const baseName = path.parse(originalFileName).name;

  const outcome = await context.ui.withinProgressDialog(
    `Splitting ${originalFileName}…`,
    { progress: 0 },
    async (update, signal): Promise<{ ok: true; clips: number; tracks: number } | { ok: false; error?: Error }> => {
      let outputPaths: string[] = [];
      // Once clip creation starts, some clips may already reference these
      // files. Deleting them then would leave "media offline" clips behind,
      // which is worse than leaving a few unused files in the folder.
      let placementStarted = false;

      try {
        outputPaths = groups.map((group) =>
          uniquePath(clipsDirectory, outputFileNameFor(baseName, group)),
        );

        await update(`Splitting ${groups.length} channels…`, 0);
        await deinterleave({
          info,
          groups,
          outputPaths,
          signal,
          // Reserve the last 10% of the bar for creating tracks and clips.
          onProgress: (fraction) =>
            update(`Splitting ${groups.length} channels…`, Math.round(fraction * 90)),
        });

        if (signal.aborted) throw new AbortedError();

        const placements: ClipPlacement[] = groups.map((group, index) => ({
          filePath: outputPaths[index]!,
          clipName: `${baseName} ${group.label}`,
          trackName: sanitizeFileName(group.label),
          targetIndex: choice.assignments[index] ?? null,
        }));

        placementStarted = true;
        const result = await placeClips(context, {
          placements,
          startTime: choice.startTime,
          warp: choice.warp,
          renameTargetTracks: choice.renameTargetTracks,
          color: choice.color,
          onProgress: (message) => update(message, 95),
        });

        await update("Done", 100);
        return { ok: true, clips: result.clipsCreated, tracks: result.tracksCreated };
      } catch (error) {
        // Split files are only useful attached to clips, so clean them up —
        // but only while we are sure nothing references them yet.
        if (!placementStarted) {
          await Promise.all(outputPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})));
        }
        if (error instanceof AbortedError) return { ok: false };
        return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  );

  const result = outcome as { ok: boolean; error?: Error; clips?: number; tracks?: number };
  if (result.error) throw result.error;
  if (!result.ok) return;

  console.log(
    `MultichannelLive: placed ${result.clips} clip(s), created ${result.tracks} track(s) ` +
      `from ${originalFileName} in ${CLIPS_FOLDER_NAME}/`,
  );
}

function sizeArgs(groupCount: number): [number, number] {
  const { width, height } = dialogSize(groupCount);
  return [width, height];
}

/** Runs an async command body, reporting failures in a dialog. */
async function guard<V extends ApiVersion>(
  context: ExtensionContext<V>,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (error instanceof AbortedError) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error("MultichannelLive:", error);
    await showMessage(context, {
      kind: "error",
      title: "Could not load the file",
      body: message,
    }).catch(() => {});
  }
}

interface MessageOptions {
  kind: "info" | "warning" | "error";
  title: string;
  body: string;
  /** Shown verbatim in a monospace block, for paths and the like. */
  path?: string;
  confirmLabel?: string;
  /** Providing this turns the notice into a confirmation with two buttons. */
  cancelLabel?: string;
}

/**
 * Shows a notice, or a confirmation when `cancelLabel` is set. Resolves with
 * `"ok"` or `"cancel"`; anything unexpected is treated as `"cancel"`, so a
 * dialog that fails to answer never counts as consent.
 */
async function showMessage<V extends ApiVersion>(
  context: ExtensionContext<V>,
  options: MessageOptions,
): Promise<"ok" | "cancel"> {
  const payload = JSON.stringify(options).replace(/</g, "\\u003c");
  const html = messageTemplate.replace("__MCL_MESSAGE__", payload);
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  const lines =
    Math.ceil(options.body.length / 62) + options.body.split("\n").length + (options.path ? 2 : 0);
  const answer = await context.ui.showModalDialog(url, 460, Math.min(420, 140 + lines * 19));

  return answer === "ok" ? "ok" : "cancel";
}

function resolveHandle<V extends ApiVersion, T extends DataModelObject<V>>(
  context: ExtensionContext<V>,
  handle: unknown,
  type: abstract new (...args: never) => T,
): T | null {
  if (!handle || typeof handle !== "object" || !("id" in handle)) return null;
  try {
    return context.getObjectFromHandle(handle as Handle, type);
  } catch {
    return null;
  }
}

/** Walks up an object's parents to the track that owns it. */
function trackIndexOf<V extends ApiVersion>(
  context: ExtensionContext<V>,
  object: DataModelObject<V>,
): number | null {
  let current: DataModelObject<V> | null = object;

  while (current) {
    if (current instanceof Track) {
      const tracks = context.application.song.tracks;
      for (let index = 0; index < tracks.length; index++) {
        if (tracks[index]!.handle.id === current.handle.id) return index;
      }
      return null;
    }
    current = current.parent;
  }

  return null;
}

function compact<T>(values: (T | null | undefined)[]): T[] {
  return values.filter((value): value is T => value !== null && value !== undefined);
}
