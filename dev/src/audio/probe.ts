import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AudioFileInfo } from "./types.js";
import { readAiffInfo } from "./aiff.js";
import { readWavInfo } from "./wav.js";

const execFileAsync = promisify(execFile);

/**
 * Homebrew and MacPorts locations, because the Extension Host does not
 * inherit a login shell's PATH.
 */
const FFMPEG_FALLBACK_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
];

let cachedFfmpegPath: string | null | undefined;

/** Locates an ffmpeg binary, or returns `null` if there is none. */
export async function findFfmpeg(): Promise<string | null> {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  for (const candidate of FFMPEG_FALLBACK_PATHS) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      cachedFfmpegPath = candidate;
      return candidate;
    } catch {
      // Try the next one.
    }
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["ffmpeg"]);
    const resolved = stdout.trim();
    if (resolved) {
      cachedFfmpegPath = resolved;
      return resolved;
    }
  } catch {
    // Not on PATH either.
  }

  // A negative result is deliberately not cached: the user may install
  // ffmpeg and retry without restarting Live.
  return null;
}

/**
 * Decodes an unsupported container to a temporary 32-bit float WAV that the
 * native readers can handle. Float keeps headroom for sources that peak above
 * 0 dBFS, and is lossless for every integer depth up to 24-bit.
 */
async function decodeToWav(filePath: string, tempDir: string): Promise<string> {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new Error(
      `Cannot read "${path.basename(filePath)}". Only WAV, RF64 and AIFF are ` +
        `supported out of the box — install ffmpeg to open other formats.`,
    );
  }

  const outputPath = path.join(tempDir, `decoded-${Date.now()}-${path.parse(filePath).name}.wav`);
  try {
    await execFileAsync(ffmpeg, [
      "-v", "error",
      "-y",
      "-i", filePath,
      "-c:a", "pcm_f32le",
      // Lets the intermediate exceed 4 GB when the source is long.
      "-rf64", "auto",
      outputPath,
    ]);
  } catch (error) {
    throw new Error(`ffmpeg could not decode "${path.basename(filePath)}": ${describe(error)}`);
  }

  return outputPath;
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr.split("\n").slice(-2).join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a file's header directly. Returns `null` when the container is not one
 * we can de-interleave in place, which means it needs the ffmpeg fallback.
 *
 * Detection is by magic bytes rather than extension, so a mislabelled file
 * still takes the fast path when its contents are RIFF or FORM.
 */
export async function probeNative(filePath: string): Promise<AudioFileInfo | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    return (
      (await readWavInfo(handle, filePath, size)) ?? (await readAiffInfo(handle, filePath, size))
    );
  } finally {
    await handle.close();
  }
}

/**
 * Decodes a file ffmpeg understands into an intermediate WAV and reads that.
 *
 * This can take a while on a long recording, so callers should run it behind a
 * progress dialog rather than blocking Live silently.
 */
export async function probeViaFfmpeg(filePath: string, tempDir: string): Promise<AudioFileInfo> {
  const decodedPath = await decodeToWav(filePath, tempDir);
  const decoded = await probeNative(decodedPath);
  if (!decoded) {
    await fs.rm(decodedPath, { force: true });
    throw new Error(`ffmpeg produced a file we could not read for "${path.basename(filePath)}".`);
  }

  return { ...decoded, decodedFrom: filePath };
}

/** Reads a file's header, falling back to an ffmpeg decode when needed. */
export async function probeAudioFile(filePath: string, tempDir: string): Promise<AudioFileInfo> {
  return (await probeNative(filePath)) ?? (await probeViaFfmpeg(filePath, tempDir));
}
