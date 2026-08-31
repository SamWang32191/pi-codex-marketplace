import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, type CliIO, RELOAD_NOTICE } from "../../src/cli/index.js";
import { readMinimalBridgeState } from "../../src/bridge/state.js";

function createMockIo(): { io: CliIO; stdout: string[]; stderr: string[]; exitCodes: number[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];

  const io: CliIO = {
    stdout: {
      write(chunk: string) {
        stdout.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderr.push(chunk);
      },
    },
    exit(code: number) {
      exitCodes.push(code);
    },
  };

  return { io, stdout, stderr, exitCodes };
}

function makeSyntheticMarketplace(root: string, name: string, plugins: { name: string; path: string; skills?: string[] }[]) {
  mkdirSync(join(root, ".agents", "plugins"), { recursive: true });
  writeFileSync(
    join(root, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({
      name,
      plugins: plugins.map((p) => ({ name: p.name, source: { source: "local", path: p.path } })),
    }),
  );
  for (const p of plugins) {
    const abs = join(root, p.path.replace(/^\.\//, ""));
    mkdirSync(abs, { recursive: true });
    mkdirSync(join(abs, ".codex-plugin"), { recursive: true });
    writeFileSync(join(abs, ".codex-plugin", "plugin.json"), JSON.stringify({ name: p.name }));
    writeFileSync(join(abs, "plugin.json"), JSON.stringify({ name: p.name }));
    if (p.skills) {
      for (const skill of p.skills) {
        const sdir = join(abs, "skills", skill);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(join(sdir, "SKILL.md"), `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`);
      }
    }
  }
}

describe("Bridge CLI adapter seam (#132, #133)", () => {
  let cwd: string;
  let agentDir: string;
  let statePath: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "cli-adapter-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "cli-adapter-agent-"));
    statePath = join(agentDir, "codex-marketplace", "state.json");
    mkdirSync(join(agentDir, "codex-marketplace"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it("prints overview to stdout and exits 0 on no arguments", async () => {
    const mock = createMockIo();
    const code = await runCli([], mock.io, { cwd, agentDir });

    expect(code).toBe(0);
    expect(mock.exitCodes).toEqual([0]);
    expect(mock.stderr).toHaveLength(0);
    expect(mock.stdout.length).toBeGreaterThan(0);
    const combinedStdout = mock.stdout.join("");
    expect(combinedStdout).toContain("Marketplaces");
    expect(combinedStdout).toContain("Installed");
    expect(combinedStdout).toContain("用法：/codex-marketplace");
  });

  it("prints help to stdout and exits 0 on help argument", async () => {
    const mock = createMockIo();
    const code = await runCli(["help"], mock.io, { cwd, agentDir });

    expect(code).toBe(0);
    expect(mock.exitCodes).toEqual([0]);
    expect(mock.stderr).toHaveLength(0);
    const combinedStdout = mock.stdout.join("");
    expect(combinedStdout).toContain("add");
    expect(combinedStdout).toContain("list");
    expect(combinedStdout).toContain("install");
    expect(combinedStdout).toContain("update");
    expect(combinedStdout).toContain("disable");
    expect(combinedStdout).toContain("enable");
    expect(combinedStdout).toContain("remove");
    expect(combinedStdout).toContain("forget");
    expect(combinedStdout).toContain("help");
  });

  it("prints version to stdout and exits 0 on --version / -v", async () => {
    const mockVersion = createMockIo();
    const codeVersion = await runCli(["--version"], mockVersion.io, { cwd, agentDir });
    expect(codeVersion).toBe(0);
    expect(mockVersion.exitCodes).toEqual([0]);
    expect(mockVersion.stderr).toHaveLength(0);
    expect(mockVersion.stdout.join("").trim()).toMatch(/^\d+\.\d+\.\d+/);

    const mockShort = createMockIo();
    const codeShort = await runCli(["-v"], mockShort.io, { cwd, agentDir });
    expect(codeShort).toBe(0);
    expect(mockShort.exitCodes).toEqual([0]);
    expect(mockShort.stderr).toHaveLength(0);
    expect(mockShort.stdout.join("").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints error to stderr and exits non-zero on unknown subcommand without prompt", async () => {
    const mock = createMockIo();
    const code = await runCli(["unknown-subcommand"], mock.io, { cwd, agentDir });

    expect(code).toBe(1);
    expect(mock.exitCodes).toEqual([1]);
    expect(mock.stdout).toHaveLength(0);
    expect(mock.stderr.length).toBeGreaterThan(0);
    const combinedStderr = mock.stderr.join("");
    expect(combinedStderr).toContain("未知子命令 \"unknown-subcommand\"");
    expect(combinedStderr).toContain("用法：/codex-marketplace");
  });

  it("prints error to stderr and exits non-zero on missing or invalid subcommand arguments", async () => {
    // 1. add with no args
    const mockAdd = createMockIo();
    const codeAdd = await runCli(["add"], mockAdd.io, { cwd, agentDir });
    expect(codeAdd).toBe(1);
    expect(mockAdd.stdout).toHaveLength(0);
    expect(mockAdd.stderr.join("")).toContain("用法：/codex-marketplace add");

    // 2. install with no args
    const mockInstall = createMockIo();
    const codeInstall = await runCli(["install"], mockInstall.io, { cwd, agentDir });
    expect(codeInstall).toBe(1);
    expect(mockInstall.stdout).toHaveLength(0);
    expect(mockInstall.stderr.join("")).toContain("用法：/codex-marketplace install");

    // 3. disable with no args
    const mockDisable = createMockIo();
    const codeDisable = await runCli(["disable"], mockDisable.io, { cwd, agentDir });
    expect(codeDisable).toBe(1);
    expect(mockDisable.stdout).toHaveLength(0);
    expect(mockDisable.stderr.join("")).toContain("用法：/codex-marketplace disable");

    // 4. enable with no args
    const mockEnable = createMockIo();
    const codeEnable = await runCli(["enable"], mockEnable.io, { cwd, agentDir });
    expect(codeEnable).toBe(1);
    expect(mockEnable.stdout).toHaveLength(0);
    expect(mockEnable.stderr.join("")).toContain("用法：/codex-marketplace enable");

    // 5. remove with no args
    const mockRemove = createMockIo();
    const codeRemove = await runCli(["remove"], mockRemove.io, { cwd, agentDir });
    expect(codeRemove).toBe(1);
    expect(mockRemove.stdout).toHaveLength(0);
    expect(mockRemove.stderr.join("")).toContain("用法：/codex-marketplace remove");

    // 6. forget with no args
    const mockForget = createMockIo();
    const codeForget = await runCli(["forget"], mockForget.io, { cwd, agentDir });
    expect(codeForget).toBe(1);
    expect(mockForget.stdout).toHaveLength(0);
    expect(mockForget.stderr.join("")).toContain("用法：/codex-marketplace forget");
  });

  it("handles corrupted state file gracefully with warning notice and overview", async () => {
    writeFileSync(statePath, "MALFORMED STATE JSON", "utf-8");

    const mock = createMockIo();
    const code = await runCli([], mock.io, { cwd, agentDir });

    expect(code).toBe(0);
    expect(mock.stderr).toHaveLength(0);
    const combinedStdout = mock.stdout.join("");
    expect(combinedStdout).toMatch(/損壞|重置/);
    expect(combinedStdout).toContain("Marketplaces");
  });

  it("replaces reload notice with CLI-specific notice on state-affecting operations", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-mkt-"));
    makeSyntheticMarketplace(mktRoot, "test-mkt", [
      { name: "test-plugin", path: "./plugins/test-plugin", skills: ["test-skill"] },
    ]);

    try {
      // 1. add
      const mockAdd = createMockIo();
      const codeAdd = await runCli(["add", mktRoot], mockAdd.io, { cwd, agentDir });
      expect(codeAdd).toBe(0);
      expect(mockAdd.stdout.join("")).toContain("已註冊 \"test-mkt\"");

      // 2. install (state-affecting reload)
      const mockInstall = createMockIo();
      const codeInstall = await runCli(["install", "1"], mockInstall.io, { cwd, agentDir });
      expect(codeInstall).toBe(0);
      const installOut = mockInstall.stdout.join("");
      expect(installOut).toContain("安裝 \"test-plugin\"");
      expect(installOut).toContain(RELOAD_NOTICE);
      expect(installOut).not.toContain("已重新載入生效");

      // 3. disable
      const mockDisable = createMockIo();
      const codeDisable = await runCli(["disable", "test-plugin"], mockDisable.io, { cwd, agentDir });
      expect(codeDisable).toBe(0);
      expect(mockDisable.stdout.join("")).toContain("已停用 \"test-plugin\"");

      // 4. enable (state-affecting reload)
      const mockEnable = createMockIo();
      const codeEnable = await runCli(["enable", "test-plugin"], mockEnable.io, { cwd, agentDir });
      expect(codeEnable).toBe(0);
      const enableOut = mockEnable.stdout.join("");
      expect(enableOut).toContain("已啟用 \"test-plugin\"");
      expect(enableOut).toContain(RELOAD_NOTICE);
      expect(enableOut).not.toContain("已重新載入生效");

      // 5. state inspection to confirm persistence in isolated agentDir
      const state = readMinimalBridgeState({ agentDir });
      expect(state.state.registrations).toHaveLength(1);
      expect(state.state.installations).toHaveLength(1);
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("honors environment overrides and isolates state completely in temp agentDir", async () => {
    const mock = createMockIo();
    await runCli([], mock.io);

    const state = readMinimalBridgeState({ agentDir });
    expect(state.state.registrations).toHaveLength(0);
    expect(state.state.installations).toHaveLength(0);
  });

  it("runs the actual bin/pi-codex-marketplace.js binary via Node child process", () => {
    const binPath = join(process.cwd(), "bin", "pi-codex-marketplace.js");
    const output = execFileSync(process.execPath, [binPath, "--version"], {
      encoding: "utf-8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir },
    });
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const helpOutput = execFileSync(process.execPath, [binPath, "help"], {
      encoding: "utf-8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir },
    });
    expect(helpOutput).toContain("用法：/codex-marketplace");
  });
});
