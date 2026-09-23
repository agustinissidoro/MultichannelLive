import type { FileHandle } from "node:fs/promises";
import type { AudioFileInfo, SampleFormat } from "./types.js";
import { channelNamesFor } from "./wav.js";

interface Chunk {
  id: string;
  offset: number;
  size: number;
}

/** Same layout as RIFF, but every size field is big-endian. */
async function* walkChunks(
  handle: FileHandle,
  start: number,
  end: number,
): AsyncGenerator<Chunk> {
  const header = Buffer.alloc(8);
  let position = start;

  while (position + 8 <= end) {
    const { bytesRead } = await handle.read(header, 0, 8, position);
    if (bytesRead < 8) return;

    const id = header.toString("latin1", 0, 4);
    const size = header.readUInt32BE(4);
    yield { id, offset: position + 8, size };

    position += 8 + size + (size % 2);
  }
}

/**
 * Decodes an 80-bit IEEE 754 extended float, which is how AIFF stores its
 * sample rate. Only the positive, in-range case matters here.
 */
function readExtendedFloat80(buffer: Buffer, offset: number): number {
  const exponentField = buffer.readUInt16BE(offset);
  const sign = exponentField & 0x8000 ? -1 : 1;
  const exponent = exponentField & 0x7fff;
  const mantissa = buffer.readBigUInt64BE(offset + 2);

  if (exponent === 0 && mantissa === 0n) return 0;
  // The extended format stores the leading mantissa bit explicitly, so the
  // bias is 16383 + 63 rather than plain 16383.
  return sign * Number(mantissa) * Math.pow(2, exponent - 16383 - 63);
}

/**
 * Reads an AIFF or AIFC header. Returns `null` if the file is not FORM/AIFF,
 * so callers can try another container.
 */
export async function readAiffInfo(
  handle: FileHandle,
  filePath: string,
  fileSize: number,
): Promise<AudioFileInfo | null> {
  const form = Buffer.alloc(12);
  const { bytesRead } = await handle.read(form, 0, 12, 0);
  if (bytesRead < 12) return null;

  if (form.toString("latin1", 0, 4) !== "FORM") return null;
  const formType = form.toString("latin1", 8, 12);
  if (formType !== "AIFF" && formType !== "AIFC") return null;

  let channelCount = 0;
  let frameCount = 0;
  let bitsPerSample = 0;
  let sampleRate = 0;
  let compression = "NONE";
  let dataOffset = -1;
  let dataLength = 0;

  for await (const chunk of walkChunks(handle, 12, fileSize)) {
    if (chunk.id === "COMM") {
      const body = Buffer.alloc(chunk.size);
      await handle.read(body, 0, chunk.size, chunk.offset);
      if (body.length < 18) throw new Error("Malformed AIFF: COMM chunk is too short.");
      channelCount = body.readUInt16BE(0);
      frameCount = body.readUInt32BE(2);
      bitsPerSample = body.readUInt16BE(6);
      sampleRate = Math.round(readExtendedFloat80(body, 8));
      if (formType === "AIFC" && body.length >= 22) {
        compression = body.toString("latin1", 18, 22);
      }
    } else if (chunk.id === "SSND") {
      // SSND begins with an 8-byte offset/blockSize pair before the frames.
      const ssnd = Buffer.alloc(8);
      await handle.read(ssnd, 0, 8, chunk.offset);
      dataOffset = chunk.offset + 8 + ssnd.readUInt32BE(0);
      dataLength = chunk.size - 8 - ssnd.readUInt32BE(0);
      break;
    }
  }

  if (channelCount < 1) throw new Error("Malformed AIFF: no COMM chunk found.");
  if (dataOffset < 0) throw new Error("Malformed AIFF: no SSND chunk found.");
  if (bitsPerSample % 8 !== 0) {
    throw new Error(`Unsupported AIFF bit depth: ${bitsPerSample}-bit.`);
  }

  let sampleFormat: SampleFormat = "pcm";
  let bigEndian = true;
  switch (compression) {
    case "NONE":
    case "twos":
      break;
    case "sowt":
      bigEndian = false;
      break;
    case "fl32":
    case "FL32":
      sampleFormat = "float";
      bitsPerSample = 32;
      break;
    case "fl64":
    case "FL64":
      sampleFormat = "float";
      bitsPerSample = 64;
      break;
    default:
      throw new Error(`Unsupported AIFC compression type "${compression}".`);
  }

  const blockAlign = channelCount * (bitsPerSample / 8);
  if (dataOffset + dataLength > fileSize) dataLength = fileSize - dataOffset;

  const usableFrames = Math.min(frameCount, Math.floor(dataLength / blockAlign));

  return {
    filePath,
    container: "aiff",
    channelCount,
    sampleRate,
    bitsPerSample,
    sampleFormat,
    blockAlign,
    dataOffset,
    dataLength: usableFrames * blockAlign,
    frameCount: usableFrames,
    durationSeconds: sampleRate > 0 ? usableFrames / sampleRate : 0,
    bigEndian,
    // AIFF has no channel mask, so labelling is down to the channel count.
    channelNames: channelNamesFor(channelCount, 0),
  };
}
