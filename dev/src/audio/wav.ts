import type { FileHandle } from "node:fs/promises";
import type { AudioFileInfo, SampleFormat } from "./types.js";

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/** Order matters: bit 0 is the first name, bit 1 the second, and so on. */
const CHANNEL_MASK_NAMES = [
  "L", "R", "C", "LFE", "Ls", "Rs", "Lc", "Rc", "Cs", "Lss", "Rss",
  "Tc", "Tfl", "Tfc", "Tfr", "Tbl", "Tbc", "Tbr",
];

/** First-order-and-up ambisonic component names in ACN order. */
const AMBISONIC_NAMES = [
  "W", "Y", "Z", "X", "V", "T", "R", "S", "U",
  "Q", "O", "M", "K", "L", "N", "P",
];

interface Chunk {
  id: string;
  /** Offset of the chunk's payload, i.e. just past the 8-byte header. */
  offset: number;
  size: number;
}

/**
 * Walks the top-level chunks of a RIFF/RF64 file. Chunk bodies are padded to
 * an even number of bytes, but the padding byte is not counted in `size`.
 */
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
    const size = header.readUInt32LE(4);
    yield { id, offset: position + 8, size };

    position += 8 + size + (size % 2);
  }
}

async function readChunk(handle: FileHandle, chunk: Chunk): Promise<Buffer> {
  const buffer = Buffer.alloc(chunk.size);
  await handle.read(buffer, 0, chunk.size, chunk.offset);
  return buffer;
}

/**
 * Derives per-channel labels. A WAVE_FORMAT_EXTENSIBLE channel mask is
 * authoritative; failing that, channel counts that match an ambisonic order
 * get ACN names, and everything else falls back to plain numbering.
 */
export function channelNamesFor(channelCount: number, channelMask: number): string[] {
  if (channelMask !== 0) {
    const named: string[] = [];
    for (let bit = 0; bit < CHANNEL_MASK_NAMES.length; bit++) {
      if (channelMask & (1 << bit)) named.push(CHANNEL_MASK_NAMES[bit]!);
    }
    // A mask that names too few channels leaves the remainder unlabelled, so
    // only trust it when it accounts for every channel.
    if (named.length === channelCount) return named;
  }

  const ambisonicOrder = Math.sqrt(channelCount);
  if (Number.isInteger(ambisonicOrder) && channelCount > 1 && channelCount <= 16) {
    return AMBISONIC_NAMES.slice(0, channelCount);
  }

  if (channelCount === 1) return ["Mono"];
  if (channelCount === 2) return ["L", "R"];

  return Array.from({ length: channelCount }, (_, i) => String(i + 1).padStart(2, "0"));
}

/**
 * Reads a WAV/RF64 header. Returns `null` if the file is not RIFF/WAVE, so
 * callers can try another container.
 */
export async function readWavInfo(
  handle: FileHandle,
  filePath: string,
  fileSize: number,
): Promise<AudioFileInfo | null> {
  const riff = Buffer.alloc(12);
  const { bytesRead } = await handle.read(riff, 0, 12, 0);
  if (bytesRead < 12) return null;

  const magic = riff.toString("latin1", 0, 4);
  if (magic !== "RIFF" && magic !== "RF64") return null;
  if (riff.toString("latin1", 8, 12) !== "WAVE") return null;

  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let channelMask = 0;
  let dataOffset = -1;
  let dataLength = 0;
  // RF64 parks the real 64-bit sizes in a ds64 chunk and leaves 0xFFFFFFFF
  // in the 32-bit fields.
  let ds64DataSize: number | null = null;

  for await (const chunk of walkChunks(handle, 12, fileSize)) {
    if (chunk.id === "ds64") {
      const body = await readChunk(handle, chunk);
      if (body.length >= 16) ds64DataSize = Number(body.readBigUInt64LE(8));
    } else if (chunk.id === "fmt ") {
      const body = await readChunk(handle, chunk);
      if (body.length < 16) throw new Error("Malformed WAV: fmt chunk is too short.");
      format = body.readUInt16LE(0);
      channelCount = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      blockAlign = body.readUInt16LE(12);
      bitsPerSample = body.readUInt16LE(14);

      if (format === WAVE_FORMAT_EXTENSIBLE && body.length >= 40) {
        channelMask = body.readUInt32LE(20);
        // The real format code is the first two bytes of the SubFormat GUID.
        format = body.readUInt16LE(24);
      }
    } else if (chunk.id === "data") {
      dataOffset = chunk.offset;
      dataLength = ds64DataSize ?? chunk.size;
      // A 0xFFFFFFFF or over-long size means the writer streamed the file and
      // never patched the header; trust the file length instead.
      if (dataOffset + dataLength > fileSize) dataLength = fileSize - dataOffset;
      break;
    }
  }

  if (dataOffset < 0) throw new Error("Malformed WAV: no data chunk found.");
  if (channelCount < 1) throw new Error("Malformed WAV: no fmt chunk found.");
  if (bitsPerSample % 8 !== 0) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}-bit.`);
  }

  let sampleFormat: SampleFormat;
  if (format === WAVE_FORMAT_PCM) sampleFormat = "pcm";
  else if (format === WAVE_FORMAT_FLOAT) sampleFormat = "float";
  else throw new Error(`Unsupported WAV encoding (format code 0x${format.toString(16)}).`);

  // Some writers leave blockAlign at 0; derive it when it looks wrong.
  const derivedBlockAlign = channelCount * (bitsPerSample / 8);
  if (blockAlign !== derivedBlockAlign) blockAlign = derivedBlockAlign;

  const frameCount = Math.floor(dataLength / blockAlign);

  return {
    filePath,
    container: "wav",
    channelCount,
    sampleRate,
    bitsPerSample,
    sampleFormat,
    blockAlign,
    dataOffset,
    dataLength: frameCount * blockAlign,
    frameCount,
    durationSeconds: sampleRate > 0 ? frameCount / sampleRate : 0,
    bigEndian: false,
    channelNames: channelNamesFor(channelCount, channelMask),
  };
}

/** Largest `data` payload a plain 32-bit RIFF header can describe. */
export const MAX_WAV_DATA_BYTES = 0xffffffff - 36;

/** Trailing 14 bytes of the PCM/float SubFormat GUIDs, which are shared. */
const SUBFORMAT_GUID_TAIL = Buffer.from("000000001000800000aa00389b71", "hex");

/**
 * Builds a `WAVE_FORMAT_EXTENSIBLE` header, which is what a file with more
 * than two channels needs to be read correctly.
 *
 * `channelMask` is left at 0, meaning the channels are discrete rather than
 * mapped to named speakers. That is the honest description of a bounce whose
 * channel assignment the user chose themselves, and readers treat it as
 * "unknown layout" rather than guessing a surround format.
 *
 * Emits RF64 when the payload will not fit a 32-bit RIFF header, so long
 * multichannel bounces are not capped at 4 GB.
 */
export function buildMultichannelWavHeader(args: {
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
  sampleFormat: SampleFormat;
  dataLength: number;
  channelMask?: number;
}): Buffer {
  const { channelCount, sampleRate, bitsPerSample, sampleFormat, dataLength } = args;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const needsRf64 = dataLength > MAX_WAV_DATA_BYTES;

  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(WAVE_FORMAT_EXTENSIBLE, 0);
  fmt.writeUInt16LE(channelCount, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);
  fmt.writeUInt16LE(22, 16); // cbSize
  fmt.writeUInt16LE(bitsPerSample, 18); // validBitsPerSample
  fmt.writeUInt32LE(args.channelMask ?? 0, 20);
  fmt.writeUInt16LE(sampleFormat === "float" ? WAVE_FORMAT_FLOAT : WAVE_FORMAT_PCM, 24);
  SUBFORMAT_GUID_TAIL.copy(fmt, 26);

  const chunks: Buffer[] = [];

  const riff = Buffer.alloc(12);
  riff.write(needsRf64 ? "RF64" : "RIFF", 0, "latin1");
  riff.write("WAVE", 8, "latin1");
  chunks.push(riff);

  if (needsRf64) {
    // RF64 leaves the 32-bit sizes saturated and puts the real ones in ds64.
    riff.writeUInt32LE(0xffffffff, 4);

    const ds64 = Buffer.alloc(36);
    ds64.write("ds64", 0, "latin1");
    ds64.writeUInt32LE(28, 4);
    // riffSize is the whole file minus the leading 8 bytes.
    ds64.writeBigUInt64LE(BigInt(104 - 8 + dataLength), 8);
    ds64.writeBigUInt64LE(BigInt(dataLength), 16);
    ds64.writeBigUInt64LE(BigInt(Math.floor(dataLength / blockAlign)), 24);
    ds64.writeUInt32LE(0, 32); // tableLength
    chunks.push(ds64);
  } else {
    riff.writeUInt32LE(4 + 8 + fmt.length + 8 + dataLength, 4);
  }

  const fmtHeader = Buffer.alloc(8);
  fmtHeader.write("fmt ", 0, "latin1");
  fmtHeader.writeUInt32LE(fmt.length, 4);
  chunks.push(fmtHeader, fmt);

  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0, "latin1");
  dataHeader.writeUInt32LE(needsRf64 ? 0xffffffff : dataLength, 4);
  chunks.push(dataHeader);

  return Buffer.concat(chunks);
}

/**
 * Builds a canonical 44-byte little-endian WAV header. Outputs are always mono
 * or stereo, so the plain (non-extensible) fmt chunk is always sufficient.
 */
export function buildWavHeader(args: {
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
  sampleFormat: SampleFormat;
  dataLength: number;
}): Buffer {
  const { channelCount, sampleRate, bitsPerSample, sampleFormat, dataLength } = args;
  const blockAlign = channelCount * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "latin1");

  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(sampleFormat === "float" ? WAVE_FORMAT_FLOAT : WAVE_FORMAT_PCM, 20);
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36, "latin1");
  header.writeUInt32LE(dataLength, 40);

  return header;
}
