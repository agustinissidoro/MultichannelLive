import { execFile } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/*
 * Live runs installed extensions under Node's permission model: this process
 * may only read and write the extension's own storage and temp directories.
 * The Set's Project folder, the user's source files and any output folder they
 * pick are all off limits, and touching them throws ERR_ACCESS_DENIED.
 *
 * Child processes are allowed and are not sandboxed, so everything outside the
 * sandbox goes through small system tools instead. Inside it, and when running
 * unsandboxed via `extensions-cli run`, plain `fs` is used as before.
 */

export function canRead(target: string): boolean {
  return process.permission?.has("fs.read", target) ?? true;
}

export function canWrite(target: string): boolean {
  return process.permission?.has("fs.write", target) ?? true;
}

export async function pathExists(target: string): Promise<boolean> {
  if (canRead(target)) return existsSync(target);
  return succeeds(
    isWindows()
      ? powershell(`if (Test-Path -LiteralPath ${quote(target)}) { exit 0 } else { exit 1 }`)
      : ["/bin/test", ["-e", target]],
  );
}

export async function isExecutableFile(target: string): Promise<boolean> {
  if (canRead(target)) {
    try {
      await fs.access(target, fsConstants.X_OK);
      return (await fs.stat(target)).isFile();
    } catch {
      return false;
    }
  }
  return succeeds(
    isWindows()
      ? powershell(`if (Test-Path -LiteralPath ${quote(target)} -PathType Leaf) { exit 0 } else { exit 1 }`)
      : ["/bin/test", ["-f", target, "-a", "-x", target]],
  );
}

/** Creates `directory` (and parents) if needed, and checks we can write to it. */
export async function ensureWritableDirectory(directory: string): Promise<void> {
  if (canWrite(directory)) {
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fsConstants.W_OK);
    return;
  }
  if (isWindows()) {
    await run(
      powershell(
        `New-Item -ItemType Directory -Force -Path ${quote(directory)} | Out-Null; ` +
          `$probe = Join-Path ${quote(directory)} ('.mcl-' + [guid]::NewGuid()); ` +
          `New-Item -ItemType File -Path $probe | Out-Null; Remove-Item -LiteralPath $probe`,
      ),
    );
    return;
  }
  await run(["/bin/mkdir", ["-p", directory]]);
  await run(["/bin/test", ["-d", directory, "-a", "-w", directory]]);
}

export async function removeFile(target: string): Promise<void> {
  try {
    if (canWrite(target)) {
      await fs.rm(target, { force: true });
    } else if (isWindows()) {
      await run(powershell(`Remove-Item -LiteralPath ${quote(target)} -Force -ErrorAction SilentlyContinue`));
    } else {
      await run(["/bin/rm", ["-f", target]]);
    }
  } catch {
    // Best effort, like `fs.rm(..., { force: true })` with a swallowed error.
  }
}

/**
 * Returns a path to `source` this process can read, copying it into
 * `tempDirectory` when it lies outside the sandbox. The second value says
 * whether a copy was made, in which case the caller owns and must delete it.
 *
 * On macOS the copy is an APFS clone when source and temp share a volume, so
 * it is instant and takes no extra space.
 */
export async function readableCopy(
  source: string,
  tempDirectory: string,
): Promise<{ path: string; isCopy: boolean }> {
  if (canRead(source)) return { path: source, isCopy: false };

  await fs.mkdir(tempDirectory, { recursive: true });
  const target = path.join(tempDirectory, `source-${Date.now()}-${path.basename(source)}`);
  try {
    if (isWindows()) {
      await run(powershell(`Copy-Item -LiteralPath ${quote(source)} -Destination ${quote(target)}`));
    } else if (!(await succeeds(["/bin/cp", ["-c", source, target]]))) {
      // `-c` fails across volumes or on non-APFS disks; fall back to a real copy.
      await run(["/bin/cp", [source, target]]);
    }
  } catch (error) {
    await fs.rm(target, { force: true }).catch(() => {});
    throw new Error(`Could not read "${path.basename(source)}": ${describe(error)}`);
  }
  return { path: target, isCopy: true };
}

/**
 * Runs `write` against paths this process may write to, then moves the results
 * to `finalPaths`. When every final path is already writable (unsandboxed, or
 * the destination is inside the sandbox) the files are written in place.
 *
 * If `write` fails, nothing is left behind. If a move fails, the files already
 * moved are removed again so the destination never holds a partial set.
 */
export async function writeThroughSandbox(
  finalPaths: string[],
  tempDirectory: string,
  write: (paths: string[]) => Promise<void>,
): Promise<void> {
  if (finalPaths.every((p) => canWrite(p))) {
    await write(finalPaths);
    return;
  }

  const staging = path.join(tempDirectory, `out-${process.pid}-${Date.now()}`);
  await fs.mkdir(staging, { recursive: true });
  const stagedPaths = finalPaths.map((p, index) => path.join(staging, `${index}-${path.basename(p)}`));

  try {
    await write(stagedPaths);

    const moved: string[] = [];
    try {
      for (const [index, staged] of stagedPaths.entries()) {
        await moveFile(staged, finalPaths[index]!);
        moved.push(finalPaths[index]!);
      }
    } catch (error) {
      await Promise.all(moved.map(removeFile));
      throw new Error(`Could not write to the output folder: ${describe(error)}`);
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function moveFile(source: string, target: string): Promise<void> {
  if (isWindows()) {
    await run(powershell(`Move-Item -LiteralPath ${quote(source)} -Destination ${quote(target)}`));
  } else {
    // `-n` never clobbers: names are chosen to be free, so an existing file
    // means something raced us, and failing beats overwriting it.
    // `mv -n` exits 0 even when it skips, so check that the source is gone.
    await run(["/bin/mv", ["-n", source, target]]);
    if (existsSync(source)) throw new Error(`"${path.basename(target)}" already exists.`);
  }
}

type Command = [file: string, args: string[]];

function isWindows(): boolean {
  return process.platform === "win32";
}

function powershell(script: string): Command {
  return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]];
}

/** Single-quoted PowerShell literal. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function run([file, args]: Command): Promise<void> {
  await execFileAsync(file, args, { maxBuffer: 1024 * 1024 });
}

async function succeeds(command: Command): Promise<boolean> {
  try {
    await run(command);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    const stderr = String((error as { stderr: unknown }).stderr).trim();
    if (stderr) return stderr;
  }
  return error instanceof Error ? error.message : String(error);
}
