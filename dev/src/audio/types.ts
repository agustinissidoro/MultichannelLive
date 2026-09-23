/** How the raw sample words in a file should be interpreted. */
export type SampleFormat = "pcm" | "float";

/**
 * Everything needed to de-interleave a file without decoding it: where the
 * sample data starts, how wide a frame is, and how to interpret the words.
 */
export interface AudioFileInfo {
  /** The file we actually read frames from (see {@link decodedFrom}). */
  filePath: string;
  container: "wav" | "aiff";
  channelCount: number;
  sampleRate: number;
  bitsPerSample: number;
  sampleFormat: SampleFormat;
  /** Bytes per interleaved frame, i.e. `channelCount * bitsPerSample / 8`. */
  blockAlign: number;
  /** Byte offset of the first sample frame. */
  dataOffset: number;
  /** Length of the sample data in bytes. */
  dataLength: number;
  frameCount: number;
  durationSeconds: number;
  /** AIFF stores samples big-endian; WAV little-endian. */
  bigEndian: boolean;
  /** Best-effort speaker labels, one per channel. */
  channelNames: string[];
  /**
   * Set when the original file was not WAV/AIFF and had to be decoded to an
   * intermediate WAV first. Holds the path of the user's original file, and
   * means {@link filePath} is a temporary we own and should clean up.
   */
  decodedFrom?: string;
}

/** One output file: the source channels it draws from, and what to call it. */
export interface ChannelGroup {
  /** Zero-based source channel indices, in output order. */
  channels: number[];
  /** Human label, e.g. `"L/R"` or `"LFE"`. */
  label: string;
}

export function bytesPerSample(info: AudioFileInfo): number {
  return info.bitsPerSample / 8;
}
