import * as fs from "node:fs/promises";
import * as path from "node:path";

const SETTINGS_FILE = "settings.json";

export interface Settings {
  /**
   * Where de-interleaved clips are written. `null` means the default:
   * `<Project>/multichannel_clips` for whichever Set is open.
   */
  outputDirectory: string | null;
}

const DEFAULTS: Settings = { outputDirectory: null };

/**
 * Reads the stored settings.
 *
 * Never throws: a missing, unreadable or corrupt file just means defaults, so
 * a bad settings file can never stop the extension from working.
 */
export async function readSettings(storageDirectory: string | undefined): Promise<Settings> {
  if (!storageDirectory) return { ...DEFAULTS };

  try {
    const raw = await fs.readFile(path.join(storageDirectory, SETTINGS_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };

    const value = parsed as Record<string, unknown>;
    return {
      outputDirectory:
        typeof value.outputDirectory === "string" && value.outputDirectory.length > 0
          ? value.outputDirectory
          : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Persists the settings. Failures are reported to the console rather than
 * thrown — losing a preference should not abort an import that otherwise works.
 */
export async function writeSettings(
  storageDirectory: string | undefined,
  settings: Settings,
): Promise<void> {
  if (!storageDirectory) return;

  try {
    await fs.mkdir(storageDirectory, { recursive: true });
    await fs.writeFile(
      path.join(storageDirectory, SETTINGS_FILE),
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("MultichannelLive: could not save settings:", error);
  }
}
