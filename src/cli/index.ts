/**
 * CLI Adapter — Pure headless command-line entry seam for pi-codex-marketplace (#132, #133)
 *
 * Provides:
 * - runCli(argv, io, opts): Pure adapter driving runCommand with stdout/stderr/exit code contract
 * - formatCliOutput(result): Formats CommandResult for CLI output, replacing in-process reload notices
 * - getPackageVersion(): Retrieves package version from package.json
 */

import { runCommand, getPackageVersion, type CommandOptions, type CommandResult } from "../bridge/command.js";

export { getPackageVersion };

export interface CliIO {
  stdout?: { write: (chunk: string) => unknown; isTTY?: boolean } | ((chunk: string) => unknown);
  stderr?: { write: (chunk: string) => unknown; isTTY?: boolean; columns?: number } | ((chunk: string) => unknown);
  exit?: (code: number) => unknown;
}

export const RELOAD_NOTICE = "已寫入 Bridge State · 下次 pi session／/reload 生效";
export const RELOAD_PLACEHOLDER = "已重新載入生效";

export function formatCliOutput(result: CommandResult): string {
  let text = result.output;
  if (result.reload) {
    if (text.includes(RELOAD_PLACEHOLDER)) {
      text = text.replaceAll(RELOAD_PLACEHOLDER, RELOAD_NOTICE);
    } else {
      text = text.length > 0 ? `${text}\n\n${RELOAD_NOTICE}` : RELOAD_NOTICE;
    }
  }
  return text;
}

function writeStream(
  target: { write: (chunk: string) => unknown } | ((chunk: string) => unknown) | undefined,
  message: string,
): void {
  if (!target) return;
  const chunk = message.endsWith("\n") ? message : `${message}\n`;
  if (typeof target === "function") {
    target(chunk);
  } else if (typeof target.write === "function") {
    target.write(chunk);
  }
}

export async function runCli(
  argv: string[],
  io: CliIO = process,
  opts: CommandOptions = {},
): Promise<number> {
  const exitWith = (code: number): number => {
    if (typeof io.exit === "function") {
      io.exit(code);
    }
    return code;
  };

  try {
    if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version")) {
      writeStream(io.stdout, getPackageVersion());
      return exitWith(0);
    }

    const interactive = typeof io.stdout === 'object' && io.stdout.isTTY;
    const terminal = interactive && typeof io.stderr === 'object' && io.stderr.isTTY ? io.stderr : undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let frame = 0;
    let activityVisible = false;
    let updating = false;
    const clearActivity = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (activityVisible) {
        activityVisible = false;
        try { terminal?.write('\r\x1b[2K'); } catch { /* Progress is best-effort. */ }
      }
    };
    let result: CommandResult;
    try {
      result = await runCommand(argv, {
        ...opts,
        onProgress(message, kind) {
          updating = true; // Only update emits progress; other command formatting stays unchanged.
          if (kind !== 'result' && terminal) {
            clearActivity();
            const render = (): void => {
              // Reserve the last column to prevent wrapping into permanent history.
              const width = Math.max(0, (terminal.columns ?? 80) - 1);
              const text = `${['|', '/', '-', '\\'][frame++ % 4]} ${message}`;
              let line = '';
              let used = 0;
              for (const char of text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')) {
                const cells = char.codePointAt(0)! < 128 ? 1 : 2;
                if (used + cells > width) break;
                line += char;
                used += cells;
              }
              try {
                activityVisible = true;
                terminal.write(`\r\x1b[2K${line}`);
              } catch { clearActivity(); }
            };
            render();
            if (activityVisible) {
              timer = setInterval(render, 100);
              timer.unref();
            }
          }
          opts.onProgress?.(message, kind);
        },
      });
    } finally {
      clearActivity();
    }
    const formatted = formatCliOutput(result);
    const output = updating
      ? formatted.split('\n').filter((line) => line.length > 0)
        .map((line) => line.replace(/^(.+?  )重新抓取… /, '$1')).join('\n')
      : formatted;

    if (result.ok) {
      if (output) {
        writeStream(io.stdout, output);
      }
      return exitWith(0);
    } else {
      if (output) {
        writeStream(io.stderr, output);
      }
      return exitWith(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeStream(io.stderr, `錯誤：${msg}`);
    return exitWith(1);
  }
}
