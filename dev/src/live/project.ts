import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ApiVersion, ExtensionContext } from "@ableton-extensions/sdk";
import { buildWavHeader } from "../audio/wav.js";
import { ensureWritableDirectory, pathExists, removeFile } from "../util/sandbox.js";

/** The folder Live places inside every Project folder. */
const PROJECT_MARKER = "Ableton Project Info";

/** Sub-folder of the Project that split clips are written to. */
export const CLIPS_FOLDER_NAME = "multichannel_clips";

/** How far up from an imported sample we look for the Project root. */
const MAX_WALK_UP = 8;

/** Where this run will write its de-interleaved clips. */
export interface Destination {
  /** The folder the files go in, created if it did not exist. */
  directory: string;
  /** True when the user pointed us at a folder of their own. */
  isCustom: boolean;
  /**
   * True when `directory` sits inside a real saved Live Project. Always true
   * for a custom folder, because then we are not relying on the Set at all.
   */
  isSavedProject: boolean;
}

/**
 * Makes sure a user-chosen output folder exists and is writable.
 *
 * Returns `null` rather than throwing when it cannot be used — an unplugged
 * drive or a deleted folder should offer a way forward, not a dead end.
 */
export async function tryCustomDirectory(directory: string): Promise<Destination | null> {
  try {
    await ensureWritableDirectory(directory);
    return { directory, isCustom: true, isSavedProject: true };
  } catch {
    return null;
  }
}

export interface ClipsDirectory {
  /** `<Project>/multichannel_clips`, created if it did not exist. */
  directory: string;
  /** The folder we took to be the Project root. */
  projectRoot: string;
  /**
   * True when `projectRoot` carries the `Ableton Project Info` marker, i.e.
   * it really is a saved Live Project. When false the Set has most likely
   * never been saved and Live handed us a temporary location instead, so the
   * caller should warn before writing anything there.
   */
  isSavedProject: boolean;
}

/**
 * Finds the current Live Set's Project folder and makes sure
 * `<Project>/multichannel_clips` exists.
 *
 * Why this is not just a path lookup: in Max for Live you would read
 * `live_set.file_path` and treat an empty string as "never saved". The
 * Extensions SDK is a different API surface and has no equivalent — the whole
 * `Song` model is tracks, scenes, cue points, tempo, grid and scale, with no
 * file path and no save state, and an extension cannot reach the LOM. The only
 * call in the entire API that touches the Project folder is
 * `resources.importIntoProject()`.
 *
 * So we import a one-frame throwaway WAV, read the Project root off the path
 * Live hands back, and delete the copy again. Nothing in the Set ever
 * references it.
 *
 * Deriving the root from an existing clip's `filePath` would avoid the import,
 * but it is not safe: a clip may reference a sample sitting in a *different*
 * project's folder, and we would then write into that project. Live's own
 * answer to "where does media for this Set go" is the only authoritative one.
 */
export async function resolveClipsDirectory<V extends ApiVersion>(
  context: ExtensionContext<V>,
  tempDirectory: string,
): Promise<ClipsDirectory> {
  const { projectRoot, isSavedProject } = await discoverProjectRoot(context, tempDirectory);
  const directory = path.join(projectRoot, CLIPS_FOLDER_NAME);
  await ensureWritableDirectory(directory);
  return { directory, projectRoot, isSavedProject };
}

async function discoverProjectRoot<V extends ApiVersion>(
  context: ExtensionContext<V>,
  tempDirectory: string,
): Promise<{ projectRoot: string; isSavedProject: boolean }> {
  const probePath = path.join(tempDirectory, `multichannel-probe-${process.pid}.wav`);
  await fs.writeFile(
    probePath,
    buildWavHeader({
      channelCount: 1,
      sampleRate: 48000,
      bitsPerSample: 16,
      sampleFormat: "pcm",
      dataLength: 2,
    }),
  );
  await fs.appendFile(probePath, Buffer.alloc(2));

  let importedPath: string;
  try {
    importedPath = await context.resources.importIntoProject(probePath);
  } catch (error) {
    throw new Error(
      "Could not locate this Set's Project folder. Save the Live Set first, then " +
        `try again. (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => {});
  }

  await removeFile(importedPath);

  return projectRootFor(importedPath);
}

/** Whether a folder is a real, saved Live Project. */
export function isLiveProjectFolder(directory: string): Promise<boolean> {
  return pathExists(path.join(directory, PROJECT_MARKER));
}

/**
 * Walks up from an imported sample to the Project folder.
 *
 * `isSavedProject` reports whether the `Ableton Project Info` marker was
 * actually found. Without it we are guessing, and the guess is very likely a
 * temporary folder belonging to a Set that has never been saved.
 */
export async function projectRootFor(importedPath: string): Promise<{
  projectRoot: string;
  isSavedProject: boolean;
}> {
  let directory = path.dirname(importedPath);

  for (let level = 0; level < MAX_WALK_UP; level++) {
    if (await isLiveProjectFolder(directory)) return { projectRoot: directory, isSavedProject: true };

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // No marker found. Live imports into `<Project>/Samples/Imported`, so cut at
  // `Samples` if that shape is there, and otherwise stay beside the import.
  const segments = importedPath.split(path.sep);
  const samplesIndex = segments.lastIndexOf("Samples");
  if (samplesIndex > 0) {
    return { projectRoot: segments.slice(0, samplesIndex).join(path.sep), isSavedProject: false };
  }

  return { projectRoot: path.dirname(importedPath), isSavedProject: false };
}
