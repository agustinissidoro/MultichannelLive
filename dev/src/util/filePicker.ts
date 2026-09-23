import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Extensions offered in the picker. Anything beyond WAV/AIFF needs ffmpeg. */
const AUDIO_EXTENSIONS = [
  "wav", "wave", "rf64", "bwf", "w64",
  "aif", "aiff", "aifc",
  "caf", "flac", "ogg", "opus",
  "mp3", "m4a", "mp4", "mov", "mxf",
];

const MACOS_SCRIPT = `
set audioTypes to {${AUDIO_EXTENSIONS.map((e) => `"${e}"`).join(", ")}}
set chosen to choose file with prompt "Select a multichannel audio file" of type audioTypes with multiple selections allowed
set output to ""
repeat with theFile in chosen
  set output to output & POSIX path of theFile & linefeed
end repeat
return output
`;

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select a multichannel audio file'
$dialog.Filter = 'Audio files|${AUDIO_EXTENSIONS.map((e) => `*.${e}`).join(";")}|All files|*.*'
$dialog.Multiselect = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  $dialog.FileNames | ForEach-Object { Write-Output $_ }
}
`;

const MACOS_FOLDER_SCRIPT = `
set chosen to choose folder with prompt "Choose where to save de-interleaved clips"
return POSIX path of chosen
`;

const WINDOWS_FOLDER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose where to save de-interleaved clips'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

/**
 * Opens the OS folder chooser. Returns `null` when the user cancels.
 */
export async function pickFolder(): Promise<string | null> {
  const [folder] = await runPicker(MACOS_FOLDER_SCRIPT, WINDOWS_FOLDER_SCRIPT);
  return folder ?? null;
}

/**
 * Opens the OS file chooser.
 *
 * The Extensions SDK has no file-picker API and a WebView dialog cannot see
 * real file system paths, so this shells out to the platform's native dialog.
 * Returns an empty array when the user cancels.
 */
export async function pickAudioFiles(): Promise<string[]> {
  return runPicker(MACOS_SCRIPT, WINDOWS_SCRIPT);
}

/** Runs a platform-native chooser script and returns the lines it printed. */
async function runPicker(macosScript: string, windowsScript: string): Promise<string[]> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error(`Native file dialogs are not supported on ${process.platform}.`);
  }

  const command =
    process.platform === "win32"
      ? { file: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", windowsScript] }
      : { file: "/usr/bin/osascript", args: ["-e", macosScript] };

  try {
    const { stdout } = await execFileAsync(command.file, command.args, {
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    // osascript exits non-zero on cancel; treat that as "no selection".
    if (isUserCancellation(error)) return [];
    throw new Error(`Could not open the file chooser: ${messageOf(error)}`);
  }
}

function isUserCancellation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const stderr = "stderr" in error ? String((error as { stderr: unknown }).stderr) : "";
  return stderr.includes("-128") || /user canceled/i.test(stderr);
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
