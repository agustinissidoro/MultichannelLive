import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AudioFileInfo } from "./types.js";
import { AbortedError, formatBytes } from "./split.js";
import { buildMultichannelWavHeader, buildWavHeader } from "./wav.js";

/** Read buffer target per input. Rounded down to whole frames at runtime. */
const CHUNK_BYTES = 2 * 1024 * 1024;

/** Where one output channel's samples come from. */
export interface ChannelSource {
  info: AudioFileInfo;
  /** Which channel of that file to take. */
  channel: number;
  /**
   * Linear multiplier applied on the way through, for track volume and pan.
   * Exactly 1 (the default) keeps the fast byte-copy path, so an untouched
   * channel is still bit-for-bit identical to its source.
   */
  gain?: number;
}

export interface InterleaveResult {
  channelCount: number;
  frameCount: number;
  sampleRate: number;
  bitsPerSample: number;
  byteLength: number;
}

/**
 * Interleaves several files into one multichannel WAV.
 *
 * `channelMap` is positional: entry *n* becomes output channel *n*, and a
 * `null` entry writes silence, so a routing can leave gaps. Inputs of
 * different lengths are padded with silence to the longest.
 *
 * Like the splitter this is a byte copy, not a decode — every input must
 * already agree on sample rate, bit depth and encoding, which they do when
 * they all come from Live's renderer.
 */
export async function interleave(args: {
  channelMap: (ChannelSource | null)[];
  outputPath: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => Promise<void>;
}): Promise<InterleaveResult> {
  const { channelMap, outputPath, signal, onProgress } = args;

  const sources = channelMap.filter((entry): entry is ChannelSource => entry !== null);
  if (sources.length === 0) throw new Error("Nothing to bounce: no channels are assigned.");

  const reference = sources[0]!.info;
  for (const source of sources) {
    if (
      source.info.sampleRate !== reference.sampleRate ||
      source.info.bitsPerSample !== reference.bitsPerSample ||
      source.info.sampleFormat !== reference.sampleFormat
    ) {
      throw new Error(
        "The rendered tracks do not share one audio format, so they cannot be " +
          "interleaved. This usually means Live rendered them at different settings.",
      );
    }
    if (source.channel < 0 || source.channel >= source.info.channelCount) {
      throw new Error(
        `Channel ${source.channel + 1} is out of range for ` +
          `"${path.basename(source.info.filePath)}".`,
      );
    }
  }

  const sampleBytes = reference.bitsPerSample / 8;
  const channelCount = channelMap.length;
  const outBlockAlign = channelCount * sampleBytes;
  const frameCount = Math.max(...sources.map((source) => source.info.frameCount));
  const dataLength = frameCount * outBlockAlign;

  // Open each distinct file once, however many channels it contributes.
  const inputPaths = [...new Set(sources.map((source) => source.info.filePath))];
  const inputIndex = new Map(inputPaths.map((filePath, index) => [filePath, index]));
  const inputInfos = inputPaths.map(
    (filePath) => sources.find((source) => source.info.filePath === filePath)!.info,
  );

  const framesPerChunk = Math.max(
    1,
    Math.floor(CHUNK_BYTES / Math.max(outBlockAlign, ...inputInfos.map((i) => i.blockAlign))),
  );

  // Resolve each output channel to (which open file, byte offset within a frame).
  const plan = channelMap.map((entry) =>
    entry === null
      ? null
      : {
          input: inputIndex.get(entry.info.filePath)!,
          byteOffset: entry.channel * sampleBytes,
          swapBytes: entry.info.bigEndian,
          gain: entry.gain ?? 1,
        },
  );

  const inputBuffers = inputInfos.map(() => Buffer.alloc(0));
  for (let i = 0; i < inputInfos.length; i++) {
    inputBuffers[i] = Buffer.alloc(framesPerChunk * inputInfos[i]!.blockAlign);
  }
  // Zeroed, so unassigned channels and short inputs read as silence.
  const outputBuffer = Buffer.alloc(framesPerChunk * outBlockAlign);

  const handles: fs.FileHandle[] = [];
  let sink: fs.FileHandle | null = null;

  try {
    for (const filePath of inputPaths) handles.push(await fs.open(filePath, "r"));

    sink = await fs.open(outputPath, "w");
    await sink.write(
      channelCount <= 2
        ? buildWavHeader({
            channelCount,
            sampleRate: reference.sampleRate,
            bitsPerSample: reference.bitsPerSample,
            sampleFormat: reference.sampleFormat,
            dataLength,
          })
        : buildMultichannelWavHeader({
            channelCount,
            sampleRate: reference.sampleRate,
            bitsPerSample: reference.bitsPerSample,
            sampleFormat: reference.sampleFormat,
            dataLength,
          }),
    );

    let framesDone = 0;
    let lastReportedPercent = -1;

    while (framesDone < frameCount) {
      if (signal?.aborted) throw new AbortedError();

      const framesWanted = Math.min(framesPerChunk, frameCount - framesDone);

      // Fill each input's buffer, zeroing whatever lies past its end.
      const framesAvailable: number[] = [];
      for (let i = 0; i < handles.length; i++) {
        const info = inputInfos[i]!;
        const buffer = inputBuffers[i]!;
        const framesLeft = Math.max(0, Math.min(framesWanted, info.frameCount - framesDone));

        if (framesLeft > 0) {
          await handles[i]!.read(
            buffer,
            0,
            framesLeft * info.blockAlign,
            info.dataOffset + framesDone * info.blockAlign,
          );
        }
        buffer.fill(0, framesLeft * info.blockAlign, framesWanted * info.blockAlign);
        framesAvailable.push(framesLeft);
      }

      outputBuffer.fill(0, 0, framesWanted * outBlockAlign);

      for (let channel = 0; channel < channelCount; channel++) {
        const entry = plan[channel];
        if (!entry) continue; // Leave this channel silent.

        const info = inputInfos[entry.input]!;
        const buffer = inputBuffers[entry.input]!;

        for (let frame = 0; frame < framesWanted; frame++) {
          const readAt = frame * info.blockAlign + entry.byteOffset;
          const writeAt = frame * outBlockAlign + channel * sampleBytes;

          if (entry.gain !== 1) {
            writeSample(
              outputBuffer,
              writeAt,
              readSample(buffer, readAt, reference, entry.swapBytes) * entry.gain,
              reference,
            );
          } else if (entry.swapBytes) {
            for (let b = 0; b < sampleBytes; b++) {
              outputBuffer[writeAt + b] = buffer[readAt + sampleBytes - 1 - b]!;
            }
          } else {
            for (let b = 0; b < sampleBytes; b++) {
              outputBuffer[writeAt + b] = buffer[readAt + b]!;
            }
          }
        }
      }

      await sink.write(outputBuffer, 0, framesWanted * outBlockAlign);
      framesDone += framesWanted;

      const percent = Math.floor((framesDone / frameCount) * 100);
      if (onProgress && percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        await onProgress(framesDone / frameCount);
      }
    }
  } catch (error) {
    if (sink) await sink.close().catch(() => {});
    sink = null;
    await fs.rm(outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => {})));
    if (sink) await sink.close().catch(() => {});
  }

  return {
    channelCount,
    frameCount,
    sampleRate: reference.sampleRate,
    bitsPerSample: reference.bitsPerSample,
    byteLength: dataLength,
  };
}

/**
 * Reads one sample as a number. Integer formats come back in their own range
 * rather than normalised, so {@link writeSample} can put them straight back.
 */
function readSample(
  buffer: Buffer,
  offset: number,
  format: AudioFileInfo,
  swapBytes: boolean,
): number {
  if (format.sampleFormat === "float") {
    if (format.bitsPerSample === 64) {
      return swapBytes ? buffer.readDoubleBE(offset) : buffer.readDoubleLE(offset);
    }
    return swapBytes ? buffer.readFloatBE(offset) : buffer.readFloatLE(offset);
  }

  const bytes = format.bitsPerSample / 8;
  return swapBytes ? buffer.readIntBE(offset, bytes) : buffer.readIntLE(offset, bytes);
}

/**
 * Writes one sample back, little-endian.
 *
 * Integer formats are rounded and clamped to their range, so a gain above
 * unity clips rather than wrapping around into loud noise. Float formats are
 * left alone: values above 0 dBFS are legal there and clamping them would
 * throw away headroom the user may want.
 */
function writeSample(buffer: Buffer, offset: number, value: number, format: AudioFileInfo): void {
  if (format.sampleFormat === "float") {
    if (format.bitsPerSample === 64) buffer.writeDoubleLE(value, offset);
    else buffer.writeFloatLE(value, offset);
    return;
  }

  const bytes = format.bitsPerSample / 8;
  const limit = Math.pow(2, format.bitsPerSample - 1);
  const clamped = Math.min(limit - 1, Math.max(-limit, Math.round(value)));
  buffer.writeIntLE(clamped, offset, bytes);
}

/** Human-readable size of the file a bounce will produce. */
export function estimateBounceSize(
  channelCount: number,
  frameCount: number,
  bitsPerSample: number,
): string {
  return formatBytes(channelCount * frameCount * (bitsPerSample / 8));
}
