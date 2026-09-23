import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AudioFileInfo, ChannelGroup } from "./types.js";
import { MAX_WAV_DATA_BYTES, buildWavHeader } from "./wav.js";

/** Read buffer target. Rounded down to a whole number of frames at runtime. */
const CHUNK_BYTES = 4 * 1024 * 1024;

export class AbortedError extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "AbortedError";
  }
}

interface PlannedOutput {
  group: ChannelGroup;
  outputPath: string;
  bytesPerFrame: number;
  /**
   * Set when the group's channels are consecutive and ascending and no byte
   * swap is needed, which lets us copy a whole frame slice at once.
   */
  contiguousFrom: number | null;
}

/**
 * De-interleaves `info` into one WAV per group.
 *
 * Sample words are copied verbatim — bit depth, sample rate and encoding are
 * preserved exactly — except for AIFF sources, whose big-endian words are
 * byte-reversed on the way out so the result is a valid little-endian WAV.
 */
export async function deinterleave(args: {
  info: AudioFileInfo;
  groups: ChannelGroup[];
  outputPaths: string[];
  signal?: AbortSignal;
  onProgress?: (fraction: number) => Promise<void>;
}): Promise<void> {
  const { info, groups, outputPaths, signal, onProgress } = args;
  const sampleBytes = info.bitsPerSample / 8;
  const swapBytes = info.bigEndian;

  const plan: PlannedOutput[] = groups.map((group, index) => {
    for (const channel of group.channels) {
      if (channel < 0 || channel >= info.channelCount) {
        throw new Error(
          `Channel ${channel + 1} is out of range for a ${info.channelCount}-channel file.`,
        );
      }
    }

    const isContiguous = group.channels.every((c, i) => c === group.channels[0]! + i);
    const bytesPerFrame = group.channels.length * sampleBytes;
    const dataLength = info.frameCount * bytesPerFrame;

    if (dataLength > MAX_WAV_DATA_BYTES) {
      throw new Error(
        `"${path.basename(outputPaths[index]!)}" would exceed the 4 GB WAV limit. ` +
          `Split a shorter range of the file instead.`,
      );
    }

    return {
      group,
      outputPath: outputPaths[index]!,
      bytesPerFrame,
      contiguousFrom: isContiguous && !swapBytes ? group.channels[0]! * sampleBytes : null,
    };
  });

  await ensureDiskSpace(path.dirname(outputPaths[0] ?? "."), info.dataLength);

  const framesPerChunk = Math.max(1, Math.floor(CHUNK_BYTES / info.blockAlign));
  const inputBuffer = Buffer.allocUnsafe(framesPerChunk * info.blockAlign);
  const outputBuffers = plan.map((p) => Buffer.allocUnsafe(framesPerChunk * p.bytesPerFrame));

  const source = await fs.open(info.filePath, "r");
  const sinks: fs.FileHandle[] = [];

  try {
    for (const planned of plan) {
      const sink = await fs.open(planned.outputPath, "w");
      sinks.push(sink);
      await sink.write(
        buildWavHeader({
          channelCount: planned.group.channels.length,
          sampleRate: info.sampleRate,
          bitsPerSample: info.bitsPerSample,
          sampleFormat: info.sampleFormat,
          dataLength: info.frameCount * planned.bytesPerFrame,
        }),
      );
    }

    let framesDone = 0;
    let lastReportedPercent = -1;

    while (framesDone < info.frameCount) {
      if (signal?.aborted) throw new AbortedError();

      const framesWanted = Math.min(framesPerChunk, info.frameCount - framesDone);
      const { bytesRead } = await source.read(
        inputBuffer,
        0,
        framesWanted * info.blockAlign,
        info.dataOffset + framesDone * info.blockAlign,
      );

      const framesRead = Math.floor(bytesRead / info.blockAlign);
      if (framesRead === 0) break;

      for (let i = 0; i < plan.length; i++) {
        const planned = plan[i]!;
        const outputBuffer = outputBuffers[i]!;

        if (planned.contiguousFrom !== null) {
          for (let frame = 0; frame < framesRead; frame++) {
            const readAt = frame * info.blockAlign + planned.contiguousFrom;
            inputBuffer.copy(
              outputBuffer,
              frame * planned.bytesPerFrame,
              readAt,
              readAt + planned.bytesPerFrame,
            );
          }
        } else {
          for (let frame = 0; frame < framesRead; frame++) {
            const frameStart = frame * info.blockAlign;
            let writeAt = frame * planned.bytesPerFrame;

            for (const channel of planned.group.channels) {
              const readAt = frameStart + channel * sampleBytes;
              if (swapBytes) {
                for (let b = 0; b < sampleBytes; b++) {
                  outputBuffer[writeAt + b] = inputBuffer[readAt + sampleBytes - 1 - b]!;
                }
              } else {
                for (let b = 0; b < sampleBytes; b++) {
                  outputBuffer[writeAt + b] = inputBuffer[readAt + b]!;
                }
              }
              writeAt += sampleBytes;
            }
          }
        }

        await sinks[i]!.write(outputBuffer, 0, framesRead * planned.bytesPerFrame);
      }

      framesDone += framesRead;

      // Reporting crosses a process boundary, so only do it when the
      // user-visible percentage actually moves.
      const percent = Math.floor((framesDone / info.frameCount) * 100);
      if (onProgress && percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        await onProgress(framesDone / info.frameCount);
      }
    }
  } catch (error) {
    // Never leave half-written files behind for Live to import.
    await Promise.all(sinks.map((sink) => sink.close().catch(() => {})));
    sinks.length = 0;
    await Promise.all(outputPaths.map((p) => fs.rm(p, { force: true }).catch(() => {})));
    throw error;
  } finally {
    await source.close().catch(() => {});
    await Promise.all(sinks.map((sink) => sink.close().catch(() => {})));
  }
}

/** Best-effort guard so a full disk fails with a useful message up front. */
async function ensureDiskSpace(directory: string, requiredBytes: number): Promise<void> {
  try {
    const stats = await fs.statfs(directory);
    const available = stats.bavail * stats.bsize;
    if (available < requiredBytes) {
      throw new Error(
        `Not enough disk space: the split needs about ${formatBytes(requiredBytes)} but ` +
          `only ${formatBytes(available)} is free.`,
      );
    }
  } catch (error) {
    // statfs is unavailable on some volumes; only rethrow our own message.
    if (error instanceof Error && error.message.startsWith("Not enough disk space")) throw error;
  }
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
