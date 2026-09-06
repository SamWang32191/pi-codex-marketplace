import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function run(executable: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    execFile(executable, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
      resolvePromise({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

describe("npm-packed Bridge CLI package boundary", () => {
  let sandbox: string;
  let binPath: string;
  let agentDir: string;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(resolve("node_modules"), ".cli-package-boundary-"));
    const packed = await run("npm", ["pack", "--silent", "--pack-destination", sandbox], { cwd: process.cwd() });
    expect(packed.exitCode, packed.stderr).toBe(0);

    const tarballName = packed.stdout.trim().split(/\r?\n/).at(-1);
    expect(tarballName).toBeTruthy();

    const packageDir = join(sandbox, "node_modules", "pi-codex-marketplace");
    mkdirSync(packageDir, { recursive: true });
    const extracted = await run("tar", ["-xzf", join(sandbox, tarballName!), "-C", packageDir, "--strip-components=1"]);
    expect(extracted.exitCode, extracted.stderr).toBe(0);

    binPath = join(packageDir, "bin", "pi-codex-marketplace.js");
    agentDir = join(sandbox, "agent");
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("runs the published CLI bin from node_modules", async () => {
    const result = await run(process.execPath, [binPath, "--version"], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.stderr).toBe("");
  });

  it("dispatches update from the published package without touching user state", async () => {
    const result = await run(process.execPath, [binPath, "update"], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      },
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("尚無已註冊的 marketplace。");
    expect(result.stderr).toBe("");
  });
});
