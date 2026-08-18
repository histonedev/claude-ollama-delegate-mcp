import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Resolve the Claude Code CLI to a concrete file.
 *
 * On POSIX, spawn() searches PATH itself, so a bare name is handed straight
 * back. On Windows the distinction matters: a native install gives claude.exe
 * (directly executable), while an npm install gives claude.cmd (a batch file
 * that CreateProcess cannot run without cmd.exe). Executables are preferred so
 * the cmd.exe fallback is used only when nothing better exists.
 */
export function resolveClaudeBin(bin: string): string {
  if (!IS_WINDOWS) return bin;
  if (path.isAbsolute(bin) || bin.includes(path.sep)) return bin;

  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // .exe/.com first: directly executable, no shell involved.
  const ranked = [...exts].sort((a, b) => {
    const score = (e: string) => (/\.(exe|com)$/i.test(e) ? 0 : 1);
    return score(a) - score(b);
  });

  for (const ext of ranked) {
    for (const dir of dirs) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return bin;
}

/** True when the target can only be run through cmd.exe. */
function isBatchFile(bin: string): boolean {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(bin);
}

/**
 * Quote one argument according to the MSVCRT argv parsing rules, so the child
 * receives it as a single argument regardless of spaces or quotes.
 */
export function argvQuote(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/**
 * Escape cmd.exe's own metacharacters. cmd expands these before the child's
 * argv parser ever sees them, so they need a caret escape on top of the argv
 * quoting -- this is the layer whose absence causes command injection through
 * .cmd shims.
 */
export function cmdEscape(s: string): string {
  return s.replace(/[()%!^"<>&|]/g, (c) => "^" + c);
}

/** Newlines cannot survive a cmd.exe command line at all. */
export function assertCmdSafe(args: string[], bin: string): void {
  const bad = args.find((a) => /[\r\n]/.test(a));
  if (bad !== undefined) {
    throw new Error(
      `Cannot pass a multi-line argument through the batch shim at ${bin}. ` +
        `Install the native claude.exe, or set OLLAMA_MCP_CLAUDE_BIN to it, and retry. ` +
        `(Prompts are unaffected -- they travel over stdin, not the command line.)`,
    );
  }
}

/**
 * Spawn the Claude CLI portably.
 *
 * POSIX: direct spawn, detached so the child leads its own process group and
 * cancellation can take down any tools it started.
 * Windows: direct spawn for .exe; for a .cmd/.bat shim, route through cmd.exe
 * with both layers of escaping applied and verbatim arguments, so cmd hands the
 * child exactly the argv we intended.
 */
export function spawnClaude(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (isBatchFile(bin)) {
    assertCmdSafe([bin, ...args], bin);
    const line = [bin, ...args].map((a) => cmdEscape(argvQuote(a))).join(" ");
    const comspec = process.env.COMSPEC || "cmd.exe";
    return spawn(comspec, ["/d", "/s", "/c", line], {
      ...opts,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }

  return spawn(bin, args, {
    ...opts,
    windowsHide: true,
    // A process group leader on POSIX; Windows has no equivalent and detaching
    // there would pop a console window.
    detached: !IS_WINDOWS,
  });
}

/**
 * Terminate a child and anything it started. Killing only the direct child
 * leaves orphans behind whenever the delegate was running a tool.
 */
export function killTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = proc.pid;
  if (pid === undefined) return;

  if (IS_WINDOWS) {
    // No process groups: ask Windows to walk the tree for us.
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      proc.kill();
    }
    return;
  }

  try {
    // Negative pid targets the whole group created by detached: true.
    process.kill(-pid, signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
