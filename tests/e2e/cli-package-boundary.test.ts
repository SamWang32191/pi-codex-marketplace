import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// The parent npm invocation (npx/npm run) exports npm_config_* for its own project; a consumer
// install must not inherit them, or npm treats it as a project-scoped install of this repository.
function cleanNpmEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("npm_")));
}

describe("npm-packed Bridge CLI package boundary", () => {
  let sandbox: string;
  let tarballPath: string;
  let packageDir: string;
  let binPath: string;
  let agentDir: string;
  let consumerSandbox: string | undefined;

  beforeAll(async () => {
    sandbox = mkdtempSync(join(resolve("node_modules"), ".cli-package-boundary-"));
    const packed = await run("npm", ["pack", "--silent", "--pack-destination", sandbox], { cwd: process.cwd() });
    expect(packed.exitCode, packed.stderr).toBe(0);

    const tarballName = packed.stdout.trim().split(/\r?\n/).at(-1);
    expect(tarballName).toBeTruthy();

    tarballPath = join(sandbox, tarballName!);
    packageDir = join(sandbox, "node_modules", "pi-codex-marketplace");
    mkdirSync(packageDir, { recursive: true });
    const extracted = await run("tar", ["-xzf", tarballPath, "-C", packageDir, "--strip-components=1"]);
    expect(extracted.exitCode, extracted.stderr).toBe(0);

    binPath = join(packageDir, "bin", "pi-codex-marketplace.js");
    agentDir = join(sandbox, "agent");
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
    if (consumerSandbox) rmSync(consumerSandbox, { recursive: true, force: true });
  });

  it("declares the Pi host packages as wildcard peers in the published manifest", () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

    expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(manifest.peerDependencies["@earendil-works/pi-ai"]).toBe("*");
    expect(manifest.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
  });

  it("installs beside an unpinned Pi host without touching it", async () => {
    const sentinelVersion = "9.9.9";
    const consumer = mkdtempSync(join(tmpdir(), "cli-peer-consumer-"));
    consumerSandbox = consumer;
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", private: true }));

    for (const name of ["pi-coding-agent", "pi-tui", "pi-ai"]) {
      const hostDir = join(consumer, "node_modules", "@earendil-works", name);
      mkdirSync(hostDir, { recursive: true });
      writeFileSync(
        join(hostDir, "package.json"),
        JSON.stringify({ name: `@earendil-works/${name}`, version: sentinelVersion, type: "module", main: "index.js" }),
      );
      writeFileSync(join(hostDir, "index.js"), "export const stub = true;\n");
    }

    const installed = await run("npm", ["install", tarballPath, "--offline", "--no-audit", "--no-fund"], { cwd: consumer, env: cleanNpmEnv() });

    expect(installed.exitCode, installed.stderr).toBe(0);
    const installedManifest = JSON.parse(readFileSync(join(consumer, "node_modules", "pi-codex-marketplace", "package.json"), "utf8"));
    expect(installedManifest.name).toBe("pi-codex-marketplace");

    const hostManifest = JSON.parse(readFileSync(join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"));
    expect(hostManifest.version).toBe(sentinelVersion);
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
