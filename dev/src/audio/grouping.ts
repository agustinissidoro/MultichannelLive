import { pathExists } from "../util/sandbox.js";
import * as path from "node:path";
import type { AudioFileInfo, ChannelGroup } from "./types.js";

export type SplitMode = "mono" | "stereo";

/**
 * Decides which source channels end up in which output file.
 *
 * In stereo mode channels are paired in file order (1+2, 3+4, …), matching how
 * interleaved multichannel masters are conventionally laid out. A trailing odd
 * channel becomes a mono file rather than being dropped.
 */
export function planGroups(info: AudioFileInfo, mode: SplitMode): ChannelGroup[] {
  const names = info.channelNames;
  const groups: ChannelGroup[] = [];

  if (mode === "mono") {
    for (let channel = 0; channel < info.channelCount; channel++) {
      groups.push({ channels: [channel], label: names[channel] ?? String(channel + 1) });
    }
    return groups;
  }

  for (let channel = 0; channel < info.channelCount; channel += 2) {
    if (channel + 1 < info.channelCount) {
      groups.push({
        channels: [channel, channel + 1],
        label: `${names[channel] ?? channel + 1}/${names[channel + 1] ?? channel + 2}`,
      });
    } else {
      groups.push({ channels: [channel], label: names[channel] ?? String(channel + 1) });
    }
  }

  return groups;
}

/** Strips characters that are awkward in file names on macOS or Windows. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120) || "audio";
}

/**
 * Builds a descriptive, collision-free file name for one group, e.g.
 * `Scene 12_03-04_Ls-Rs.wav`.
 */
export function outputFileNameFor(baseName: string, group: ChannelGroup): string {
  const numbers = group.channels.map((c) => String(c + 1).padStart(2, "0")).join("-");
  const label = sanitizeFileName(group.label.replace(/\//g, "-"));

  // Skip the label when it is just the channel number again.
  const suffix = label === numbers ? numbers : `${numbers}_${label}`;
  return `${sanitizeFileName(baseName)}_${suffix}.wav`;
}

/**
 * Appends ` 2`, ` 3`, … until the path is free, so re-running the command on
 * the same file never overwrites clips already placed in the Set.
 */
export async function uniquePath(directory: string, fileName: string): Promise<string> {
  const { name, ext } = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let counter = 2;

  while (await pathExists(candidate)) {
    candidate = path.join(directory, `${name} ${counter}${ext}`);
    counter++;
  }

  return candidate;
}
