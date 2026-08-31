import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli, type CliIO, RELOAD_NOTICE } from "../../src/cli/index.js";
import { readMinimalBridgeState, writeMinimalBridgeState } from "../../src/bridge/state.js";
import { discoverProjectedSkillPaths } from "../../src/projection/exposure.js";
import type { GitExecutor } from "../../src/registration/git-acquisition.js";
import { CREDENTIAL_HELPERS_ENV, type CredentialHelperDetector } from "../../src/registration/credential-helpers.js";

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

function execCli(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(process.execPath, [binPath, ...args], { encoding: "utf-8", env }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(Object.assign(error, { stdout, stderr }));
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

function makeSyntheticMarketplace(
  root: string,
  name: string,
  plugins: { name: string; path: string; skills?: string[] }[],
) {
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
        writeFileSync(
          join(sdir, "SKILL.md"),
          `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`,
        );
      }
    }
  }
}

function makeClaudeMarketplace(
  root: string,
  name: string,
  plugins: { name: string; source?: string | Record<string, unknown>; skills?: string[]; unavailable?: boolean }[],
) {
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
      name,
      owner: { name: "Acme Team", email: "team@example.test" },
      metadata: { description: "synthetic claude marketplace" },
      plugins: plugins.map((p) => {
        if (p.unavailable) {
          return { name: p.name, source: { source: "github", repo: "acme/unsupported" } };
        }
        return { name: p.name, source: p.source ?? `./plugins/${p.name}` };
      }),
    }),
  );
  for (const p of plugins) {
    if (p.unavailable) continue;
    const rel = typeof p.source === "string" ? p.source.replace(/^\.\//, "") : `plugins/${p.name}`;
    const abs = join(root, rel);
    mkdirSync(abs, { recursive: true });
    mkdirSync(join(abs, ".claude-plugin"), { recursive: true });
    writeFileSync(join(abs, ".claude-plugin", "plugin.json"), JSON.stringify({ name: p.name }));
    if (p.skills) {
      for (const skill of p.skills) {
        const sdir = join(abs, "skills", skill);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(
          join(sdir, "SKILL.md"),
          `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`,
        );
      }
    }
  }
}

function makeMockGitExecutor(fixtureRoot: string, sha = "a".repeat(40)): GitExecutor {
  return async (args) => {
    if (args.includes("ls-remote")) {
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: "" };
    }
    if (args.includes("clone")) {
      const dest = args[args.length - 1];
      cpSync(fixtureRoot, dest, { recursive: true });
      mkdirSync(join(dest, ".git"), { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

function makeAuthGatedGitExecutor(fixtureRoot: string, sha: string, approvedHelpers: string[]): GitExecutor {
  const approved = (args: string[]): boolean => {
    const seen = args.filter((a) => a.startsWith("credential.helper="));
    return approvedHelpers.every((h) => seen.includes(`credential.helper=${h}`));
  };
  return async (args) => {
    if (!approved(args)) {
      return {
        exitCode: 128,
        stdout: "",
        stderr: "fatal: Authentication failed for 'https://github.com/acme/private-mkt/'",
      };
    }
    if (args.includes("ls-remote")) {
      const ref = args[args.length - 1];
      return { exitCode: 0, stdout: `${sha}\t${ref}\n`, stderr: "" };
    }
    if (args.includes("clone")) {
      const dest = args[args.length - 1];
      cpSync(fixtureRoot, dest, { recursive: true });
      mkdirSync(join(dest, ".git"), { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
}

const noneDetector: CredentialHelperDetector = { ghLoggedIn: () => false, hasGitHelper: () => false };

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

  it("runs the actual bin/pi-codex-marketplace.js binary via Node child process", async () => {
    const binPath = join(process.cwd(), "bin", "pi-codex-marketplace.js");
    const { stdout: output } = await execCli(binPath, ["--version"], {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_AGENT_DIR: agentDir,
    });
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const { stdout: helpOutput } = await execCli(binPath, ["help"], {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_AGENT_DIR: agentDir,
    });
    expect(helpOutput).toContain("用法：/codex-marketplace");
  }, 30000);
});

describe("Registration 表面：add／list (#132, #134)", () => {
  let cwd: string;
  let agentDir: string;
  let statePath: string;

  beforeEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    cwd = mkdtempSync(join(tmpdir(), "cli-reg-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "cli-reg-agent-"));
    statePath = join(agentDir, "codex-marketplace", "state.json");
    mkdirSync(join(agentDir, "codex-marketplace"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it("add registers local codex and claude marketplaces with format auto-detection disclosed (exit 0)", async () => {
    const codexRoot = mkdtempSync(join(tmpdir(), "cli-codex-"));
    const claudeRoot = mkdtempSync(join(tmpdir(), "cli-claude-"));
    makeSyntheticMarketplace(codexRoot, "codex-sample", [
      { name: "tool-a", path: "./plugins/tool-a", skills: ["skill-a"] },
      { name: "tool-b", path: "./plugins/tool-b", skills: ["skill-b"] },
    ]);
    makeClaudeMarketplace(claudeRoot, "claude-sample", [
      { name: "claude-tool", skills: ["c-skill"] },
    ]);

    try {
      // 1. Add Codex marketplace
      const mockCodex = createMockIo();
      const codeCodex = await runCli(["add", codexRoot], mockCodex.io, { cwd, agentDir });
      expect(codeCodex).toBe(0);
      expect(mockCodex.stderr).toHaveLength(0);
      const outCodex = mockCodex.stdout.join("");
      expect(outCodex).toContain("偵測：codex marketplace · 2 plugins");
      expect(outCodex).toContain("已註冊 \"codex-sample\"");

      // 2. Add Claude marketplace
      const mockClaude = createMockIo();
      const codeClaude = await runCli(["add", claudeRoot], mockClaude.io, { cwd, agentDir });
      expect(codeClaude).toBe(0);
      expect(mockClaude.stderr).toHaveLength(0);
      const outClaude = mockClaude.stdout.join("");
      expect(outClaude).toContain("偵測：claude marketplace · 1 plugins");
      expect(outClaude).toContain("已註冊 \"claude-sample\"");

      // 3. Inspect Bridge State
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.registrations).toHaveLength(2);
      expect(st.state.registrations[0].marketplaceName).toBe("codex-sample");
      expect(st.state.registrations[0].format).toBe("codex");
      expect(st.state.registrations[0].sourceKind).toBe("local");
      expect(st.state.registrations[1].marketplaceName).toBe("claude-sample");
      expect(st.state.registrations[1].format).toBe("claude");
      expect(st.state.registrations[1].sourceKind).toBe("local");
    } finally {
      rmSync(codexRoot, { recursive: true, force: true });
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });

  it("add rejects duplicate Source Key (direct & symlink) with TUI-identical message and exits 1 to stderr", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-dup-"));
    makeSyntheticMarketplace(mktRoot, "dup-mkt", [{ name: "p1", path: "./plugins/p1" }]);

    try {
      // 1. First registration succeeds
      const mock1 = createMockIo();
      const code1 = await runCli(["add", mktRoot], mock1.io, { cwd, agentDir });
      expect(code1).toBe(0);
      expect(mock1.stdout.join("")).toContain("已註冊 \"dup-mkt\"");

      const canonicalPath = realpathSync(mktRoot);

      // 2. Repeated add with same realpath rejected
      const mock2 = createMockIo();
      const code2 = await runCli(["add", mktRoot], mock2.io, { cwd, agentDir });
      expect(code2).toBe(1);
      expect(mock2.stdout).toHaveLength(0);
      const err2 = mock2.stderr.join("");
      expect(err2).toContain(`已註冊過相同來源 "${canonicalPath}"`);
      expect(err2).toContain("想更新？`update`；想換？先 `remove` 再 `add`");

      // 3. Repeated add via symlink to same realpath rejected identically
      const linkPath = join(tmpdir(), `cli-link-${Date.now()}`);
      symlinkSync(mktRoot, linkPath);
      try {
        const mockLink = createMockIo();
        const codeLink = await runCli(["add", linkPath], mockLink.io, { cwd, agentDir });
        expect(codeLink).toBe(1);
        expect(mockLink.stdout).toHaveLength(0);
        const errLink = mockLink.stderr.join("");
        expect(errLink).toContain(`已註冊過相同來源 "${canonicalPath}"`);
        expect(errLink).toContain("想更新？`update`；想換？先 `remove` 再 `add`");
      } finally {
        rmSync(linkPath, { force: true });
      }

      // 4. Verify no duplicates persisted
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.registrations).toHaveLength(1);
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("add accepts HTTPS URL, owner/repo shorthand, and SSH locators with credential-free snapshot identity", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cli-git-fixture-"));
    makeSyntheticMarketplace(fixtureRoot, "git-mkt", [
      { name: "remote-p1", path: "./plugins/remote-p1", skills: ["s1"] },
    ]);
    const mockExecutor = makeMockGitExecutor(fixtureRoot, "f".repeat(40));

    try {
      // 1. owner/repo shorthand
      const mockShorthand = createMockIo();
      const codeShorthand = await runCli(["add", "SamWang32191/codex-plugins"], mockShorthand.io, {
        cwd,
        agentDir,
        gitExecutor: mockExecutor,
        credentialHelperDetector: noneDetector,
      });
      expect(codeShorthand).toBe(0);
      expect(mockShorthand.stdout.join("")).toContain("已註冊 \"git-mkt\"");

      // 2. SSH URL locator (scp-like)
      const mockSsh = createMockIo();
      const codeSsh = await runCli(["add", "git@github.com:acme/ssh-market.git"], mockSsh.io, {
        cwd,
        agentDir,
        gitExecutor: mockExecutor,
        credentialHelperDetector: noneDetector,
      });
      expect(codeSsh).toBe(0);
      expect(mockSsh.stdout.join("")).toContain("已註冊 \"git-mkt\"");

      // 3. Embedded credentials in locator are rejected
      const mockCred = createMockIo();
      const codeCred = await runCli(["add", "https://user:token@github.com/acme/private.git"], mockCred.io, {
        cwd,
        agentDir,
        gitExecutor: mockExecutor,
        credentialHelperDetector: noneDetector,
      });
      expect(codeCred).toBe(1);
      expect(mockCred.stdout).toHaveLength(0);
      expect(mockCred.stderr.join("")).toMatch(/Git 網址不合法|embedded credentials are not permitted/i);

      // 4. Verify state persistence and snapshot format
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.registrations).toHaveLength(2);
      expect(st.state.registrations[0].source).toBe("https://github.com/SamWang32191/codex-plugins");
      expect(st.state.registrations[0].snapshot).toMatch(/^[0-9a-f]{64}$/);
      expect(st.state.registrations[1].source).toBe("ssh://git@github.com/acme/ssh-market.git");
      expect(st.state.registrations[1].snapshot).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("add supports PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS approval for private repos per invocation", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cli-auth-mkt-"));
    makeSyntheticMarketplace(fixtureRoot, "private-mkt", [{ name: "secret-p", path: "./plugins/secret-p" }]);
    const executor = makeAuthGatedGitExecutor(fixtureRoot, "e".repeat(40), ["custom-token-helper"]);

    try {
      // 1. Unapproved private repo (no helper provided) -> 401 error, exit 1 to stderr
      const mockFail = createMockIo();
      const codeFail = await runCli(["add", "https://github.com/acme/private-mkt"], mockFail.io, {
        cwd,
        agentDir,
        gitExecutor: executor,
        credentialHelperDetector: noneDetector,
      });
      expect(codeFail).toBe(1);
      expect(mockFail.stdout).toHaveLength(0);
      expect(mockFail.stderr.join("")).toContain("git 取得失敗");
      expect(readMinimalBridgeState({ agentDir }).state.registrations).toHaveLength(0);

      // 2. Approved via PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS env var -> exit 0 to stdout
      process.env.PI_CODEX_MARKETPLACE_CREDENTIAL_HELPERS = "custom-token-helper";
      const mockOk = createMockIo();
      const codeOk = await runCli(["add", "https://github.com/acme/private-mkt"], mockOk.io, {
        cwd,
        agentDir,
        gitExecutor: executor,
        credentialHelperDetector: noneDetector,
      });
      expect(codeOk).toBe(0);
      expect(mockOk.stderr).toHaveLength(0);
      expect(mockOk.stdout.join("")).toContain("已註冊 \"private-mkt\"");

      // 3. Verify state does NOT contain credentials
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.registrations).toHaveLength(1);
      expect(st.state.registrations[0].source).toBe("https://github.com/acme/private-mkt");
      expect(JSON.stringify(st.state)).not.toContain("custom-token-helper");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("list enumerates plugins with number, marketplace, status, and discloses Unavailable Entries and catalog diagnostics", async () => {
    const codexRoot = mkdtempSync(join(tmpdir(), "cli-list-codex-"));
    const claudeRoot = mkdtempSync(join(tmpdir(), "cli-list-claude-"));
    makeSyntheticMarketplace(codexRoot, "codex-hub", [
      { name: "normal-plugin", path: "./plugins/normal-plugin", skills: ["s1"] },
      { name: "installed-plugin", path: "./plugins/installed-plugin", skills: ["s2"] },
      { name: "disabled-plugin", path: "./plugins/disabled-plugin", skills: ["s3"] },
    ]);
    makeClaudeMarketplace(claudeRoot, "claude-hub", [
      { name: "available-claude", skills: ["c1"] },
      { name: "unsupported-git-entry", unavailable: true },
    ]);

    try {
      // 1. Initial list on empty state
      const mockEmpty = createMockIo();
      const codeEmpty = await runCli(["list"], mockEmpty.io, { cwd, agentDir });
      expect(codeEmpty).toBe(0);
      expect(mockEmpty.stderr).toHaveLength(0);
      expect(mockEmpty.stdout.join("")).toContain("尚無可列出的 plugin 或 marketplace。");

      // 2. Register both marketplaces
      await runCli(["add", codexRoot], createMockIo().io, { cwd, agentDir });
      await runCli(["add", claudeRoot], createMockIo().io, { cwd, agentDir });

      // 3. Simulate installations (one enabled, one disabled)
      const st = readMinimalBridgeState({ agentDir });
      const regCodex = st.state.registrations.find((r) => r.marketplaceName === "codex-hub")!;
      st.state.installations.push(
        {
          id: "inst-1",
          pluginId: "installed-plugin",
          enabled: true,
          installationState: "enabled",
          registrationId: regCodex.id,
          manifestName: "installed-plugin",
          sourceKind: "local",
          source: codexRoot,
          skills: ["s2"],
        },
        {
          id: "inst-2",
          pluginId: "disabled-plugin",
          enabled: false,
          installationState: "disabled",
          registrationId: regCodex.id,
          manifestName: "disabled-plugin",
          sourceKind: "local",
          source: codexRoot,
          skills: ["s3"],
        },
      );
      writeMinimalBridgeState(st.state, { agentDir });

      // 4. Run list and verify table layout and status labels
      const mockList = createMockIo();
      const codeList = await runCli(["list"], mockList.io, { cwd, agentDir });
      expect(codeList).toBe(0);
      expect(mockList.stderr).toHaveLength(0);
      const outList = mockList.stdout.join("");

      expect(outList).toContain("Marketplaces");
      expect(outList).toContain("Installed");
      expect(outList).toContain("Plugins（編號／所屬 marketplace／狀態）");

      // Check status strings
      expect(outList).toContain("normal-plugin");
      expect(outList).toContain("可安裝");
      expect(outList).toContain("installed-plugin");
      expect(outList).toContain("已裝啟用");
      expect(outList).toContain("disabled-plugin");
      expect(outList).toContain("已裝停用");
      expect(outList).toContain("available-claude");
      expect(outList).toContain("unsupported-git-entry");
      expect(outList).toContain("unavailable（external git-family entry sources (github/url/git-subdir) are not supported yet）");

      // 5. Corrupt claude marketplace catalog file to verify diagnostic warning disclosure
      writeFileSync(join(claudeRoot, ".claude-plugin", "marketplace.json"), "{ broken json");
      const mockWarn = createMockIo();
      const codeWarn = await runCli(["list"], mockWarn.io, { cwd, agentDir });
      expect(codeWarn).toBe(0);
      const outWarn = mockWarn.stdout.join("");
      expect(outWarn).toMatch(/⚠ marketplace \[claude-hub\]/);
    } finally {
      rmSync(codexRoot, { recursive: true, force: true });
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });

  it("list [名稱] filters by marketplace name; exits 1 to stderr when marketplace not found", async () => {
    const mktA = mkdtempSync(join(tmpdir(), "cli-flt-a-"));
    const mktB = mkdtempSync(join(tmpdir(), "cli-flt-b-"));
    makeSyntheticMarketplace(mktA, "mkt-alpha", [{ name: "plugin-alpha", path: "./plugins/plugin-alpha" }]);
    makeSyntheticMarketplace(mktB, "mkt-beta", [{ name: "plugin-beta", path: "./plugins/plugin-beta" }]);

    try {
      await runCli(["add", mktA], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktB], createMockIo().io, { cwd, agentDir });

      // 1. Filter matching mkt-alpha
      const mockAlpha = createMockIo();
      const codeAlpha = await runCli(["list", "mkt-alpha"], mockAlpha.io, { cwd, agentDir });
      expect(codeAlpha).toBe(0);
      expect(mockAlpha.stderr).toHaveLength(0);
      const outAlpha = mockAlpha.stdout.join("");
      expect(outAlpha).toContain("mkt-alpha");
      expect(outAlpha).toContain("plugin-alpha");
      expect(outAlpha).not.toContain("plugin-beta");

      // 2. Filter with non-existent marketplace name
      const mockNotFound = createMockIo();
      const codeNotFound = await runCli(["list", "non-existent-market"], mockNotFound.io, { cwd, agentDir });
      expect(codeNotFound).toBe(1);
      expect(mockNotFound.stdout).toHaveLength(0);
      const errNotFound = mockNotFound.stderr.join("");
      expect(errNotFound).toContain("找不到 marketplace \"non-existent-market\"");
    } finally {
      rmSync(mktA, { recursive: true, force: true });
      rmSync(mktB, { recursive: true, force: true });
    }
  });

  it("demonstrates end-to-end demo flow via bin/pi-codex-marketplace.js child process: add fixture -> list entries", async () => {
    const binPath = join(process.cwd(), "bin", "pi-codex-marketplace.js");
    const demoFixture = mkdtempSync(join(tmpdir(), "cli-demo-fixture-"));
    makeSyntheticMarketplace(demoFixture, "demo-market", [
      { name: "demo-logger", path: "./plugins/demo-logger", skills: ["log-helper"] },
      { name: "demo-parser", path: "./plugins/demo-parser", skills: ["parse-helper"] },
    ]);

    try {
      // Step 1: add local fixture marketplace
      const { stdout: addOutput } = await execCli(binPath, ["add", demoFixture], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(addOutput).toContain("偵測：codex marketplace · 2 plugins");
      expect(addOutput).toContain("已註冊 \"demo-market\"");

      // Step 2: list shows its entries
      const { stdout: listOutput } = await execCli(binPath, ["list"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(listOutput).toContain("Marketplaces");
      expect(listOutput).toContain("Plugins（編號／所屬 marketplace／狀態）");
      expect(listOutput).toContain("demo-logger");
      expect(listOutput).toContain("demo-parser");
      expect(listOutput).toContain("可安裝");

      // Step 3: list [名稱] shows filtered marketplace entries
      const { stdout: listFilteredOutput } = await execCli(binPath, ["list", "demo-market"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(listFilteredOutput).toContain("demo-market");
      expect(listFilteredOutput).toContain("demo-logger");

      // Step 4: Duplicate add fails with non-zero exit code
      let failed = false;
      try {
        await execCli(binPath, ["add", demoFixture], {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_AGENT_DIR: agentDir,
        });
      } catch (err: any) {
        failed = true;
        expect(err.code || err.status).toBe(1);
        expect((err.stderr || "").toString()).toContain("已註冊過相同來源");
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(demoFixture, { recursive: true, force: true });
    }
  }, 60000);
});

function addSkillToSyntheticPlugin(pluginDir: string, skill: string): void {
  const sdir = join(pluginDir, "skills", skill);
  mkdirSync(sdir, { recursive: true });
  writeFileSync(
    join(sdir, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Desc for ${skill}\n---\n\nBody for ${skill}\n`,
  );
}

describe("Installation 表面：install／update (#132, #135)", () => {
  let cwd: string;
  let agentDir: string;
  let statePath: string;

  beforeEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    cwd = mkdtempSync(join(tmpdir(), "cli-inst-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "cli-inst-agent-"));
    statePath = join(agentDir, "codex-marketplace", "state.json");
    mkdirSync(join(agentDir, "codex-marketplace"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it("install resolves a plugin by enumeration number, reports installed skills, updates state, and exits 0 to stdout", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-inst-num-"));
    makeSyntheticMarketplace(mktRoot, "num-mkt", [
      { name: "plugin-alpha", path: "./plugins/plugin-alpha", skills: ["alpha-skill-1", "alpha-skill-2"] },
      { name: "plugin-beta", path: "./plugins/plugin-beta", skills: ["beta-skill"] },
    ]);

    try {
      await runCli(["add", mktRoot], createMockIo().io, { cwd, agentDir });

      const mockInstall = createMockIo();
      const codeInstall = await runCli(["install", "1"], mockInstall.io, { cwd, agentDir });

      expect(codeInstall).toBe(0);
      expect(mockInstall.exitCodes).toEqual([0]);
      expect(mockInstall.stderr).toHaveLength(0);
      const out = mockInstall.stdout.join("");
      expect(out).toContain("安裝 \"plugin-alpha\"（2 skills：alpha-skill-1, alpha-skill-2）");
      expect(out).toContain(RELOAD_NOTICE);
      expect(out).not.toContain("已重新載入生效");

      // Verify Bridge State and Projection
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.installations).toHaveLength(1);
      expect(st.state.installations[0].manifestName).toBe("plugin-alpha");
      expect(st.state.installations[0].enabled).toBe(true);
      expect(st.state.installations[0].skills).toEqual(["alpha-skill-1", "alpha-skill-2"]);

      const proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("alpha-skill-1"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("alpha-skill-2"))).toBe(true);
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("install resolves a plugin by unique name, succeeds without prompt, and exits 0 to stdout", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-inst-name-"));
    makeSyntheticMarketplace(mktRoot, "name-mkt", [
      { name: "plugin-one", path: "./plugins/plugin-one", skills: ["skill-1"] },
      { name: "plugin-two", path: "./plugins/plugin-two", skills: ["skill-2"] },
    ]);

    try {
      await runCli(["add", mktRoot], createMockIo().io, { cwd, agentDir });

      const mockInstall = createMockIo();
      const codeInstall = await runCli(["install", "plugin-two"], mockInstall.io, { cwd, agentDir });

      expect(codeInstall).toBe(0);
      expect(mockInstall.exitCodes).toEqual([0]);
      expect(mockInstall.stderr).toHaveLength(0);
      const out = mockInstall.stdout.join("");
      expect(out).toContain("安裝 \"plugin-two\"（1 skills：skill-2）");
      expect(out).toContain(RELOAD_NOTICE);

      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.installations).toHaveLength(1);
      expect(st.state.installations[0].manifestName).toBe("plugin-two");
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("install fails gracefully with non-zero exit code to stderr on ambiguous name, non-existent target, or out-of-range number", async () => {
    const mktA = mkdtempSync(join(tmpdir(), "cli-amb-a-"));
    const mktB = mkdtempSync(join(tmpdir(), "cli-amb-b-"));
    makeSyntheticMarketplace(mktA, "mkt-a", [
      { name: "shared-plugin", path: "./plugins/shared-plugin", skills: ["s-a"] },
    ]);
    makeSyntheticMarketplace(mktB, "mkt-b", [
      { name: "shared-plugin", path: "./plugins/shared-plugin", skills: ["s-b"] },
    ]);

    try {
      await runCli(["add", mktA], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktB], createMockIo().io, { cwd, agentDir });

      // 1. Ambiguous name across 2 marketplaces
      const mockAmb = createMockIo();
      const codeAmb = await runCli(["install", "shared-plugin"], mockAmb.io, { cwd, agentDir });
      expect(codeAmb).toBe(1);
      expect(mockAmb.stdout).toHaveLength(0);
      const errAmb = mockAmb.stderr.join("");
      expect(errAmb).toContain("錯誤：名稱 \"shared-plugin\" 對應多個 plugin");
      expect(errAmb).toContain("請改用編號安裝");

      // 2. Non-existent name
      const mockMissing = createMockIo();
      const codeMissing = await runCli(["install", "unknown-plugin"], mockMissing.io, { cwd, agentDir });
      expect(codeMissing).toBe(1);
      expect(mockMissing.stdout).toHaveLength(0);
      expect(mockMissing.stderr.join("")).toContain("錯誤：找不到名稱 \"unknown-plugin\" 對應的 plugin");

      // 3. Out-of-range number
      const mockOutOfRange = createMockIo();
      const codeOutOfRange = await runCli(["install", "99"], mockOutOfRange.io, { cwd, agentDir });
      expect(codeOutOfRange).toBe(1);
      expect(mockOutOfRange.stdout).toHaveLength(0);
      expect(mockOutOfRange.stderr.join("")).toContain("錯誤：找不到編號 99 對應的 plugin（可用編號 1–2）");
    } finally {
      rmSync(mktA, { recursive: true, force: true });
      rmSync(mktB, { recursive: true, force: true });
    }
  });

  it("install refuses unavailable entry and exits 1 to stderr", async () => {
    const claudeRoot = mkdtempSync(join(tmpdir(), "cli-unavail-claude-"));
    makeClaudeMarketplace(claudeRoot, "claude-unavail", [
      { name: "unsupported-ext", unavailable: true },
    ]);

    try {
      await runCli(["add", claudeRoot], createMockIo().io, { cwd, agentDir });

      const mockInstall = createMockIo();
      const codeInstall = await runCli(["install", "1"], mockInstall.io, { cwd, agentDir });
      expect(codeInstall).toBe(1);
      expect(mockInstall.stdout).toHaveLength(0);
      const err = mockInstall.stderr.join("");
      expect(err).toContain("錯誤：plugin \"unsupported-ext\" unavailable，無法安裝");
      expect(err).toContain("external git-family entry sources");
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });

  it("repeated install of the same plugin re-fetches latest and overwrites (重裝＝更新) with exit 0", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-reinstall-"));
    makeSyntheticMarketplace(mktRoot, "reinstall-mkt", [
      { name: "evolving-plugin", path: "./plugins/evolving-plugin", skills: ["v1-skill"] },
    ]);

    try {
      await runCli(["add", mktRoot], createMockIo().io, { cwd, agentDir });

      // First install
      const mock1 = createMockIo();
      const code1 = await runCli(["install", "evolving-plugin"], mock1.io, { cwd, agentDir });
      expect(code1).toBe(0);
      expect(mock1.stdout.join("")).toContain("1 skills：v1-skill");

      const stBefore = readMinimalBridgeState({ agentDir });
      expect(stBefore.state.installations).toHaveLength(1);
      expect(stBefore.state.installations[0].skills).toEqual(["v1-skill"]);

      // Material evolves on disk
      addSkillToSyntheticPlugin(join(mktRoot, "plugins", "evolving-plugin"), "v2-skill");

      // Repeated install (重裝＝更新)
      const mock2 = createMockIo();
      const code2 = await runCli(["install", "evolving-plugin"], mock2.io, { cwd, agentDir });
      expect(code2).toBe(0);
      expect(mock2.stderr).toHaveLength(0);
      const out2 = mock2.stdout.join("");
      expect(out2).toContain("2 skills：v1-skill, v2-skill");
      expect(out2).toContain(RELOAD_NOTICE);

      const stAfter = readMinimalBridgeState({ agentDir });
      expect(stAfter.state.installations).toHaveLength(1);
      expect(stAfter.state.installations[0].skills).toEqual(["v1-skill", "v2-skill"]);
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("install reports skill collision warning and preserves successful installation", async () => {
    const mktA = mkdtempSync(join(tmpdir(), "cli-col-a-"));
    const mktB = mkdtempSync(join(tmpdir(), "cli-col-b-"));
    makeSyntheticMarketplace(mktA, "mkt-alpha", [
      { name: "p-alpha", path: "./plugins/p-alpha", skills: ["shared-skill", "unique-a"] },
    ]);
    makeSyntheticMarketplace(mktB, "mkt-beta", [
      { name: "p-beta", path: "./plugins/p-beta", skills: ["shared-skill", "unique-b"] },
    ]);

    try {
      await runCli(["add", mktA], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktB], createMockIo().io, { cwd, agentDir });

      // Install p-alpha
      await runCli(["install", "1"], createMockIo().io, { cwd, agentDir });

      // Install p-beta (collides on shared-skill)
      const mockBeta = createMockIo();
      const codeBeta = await runCli(["install", "2"], mockBeta.io, { cwd, agentDir });
      expect(codeBeta).toBe(0);
      expect(mockBeta.stderr).toHaveLength(0);
      const outBeta = mockBeta.stdout.join("");
      expect(outBeta).toContain("安裝 \"p-beta\"");
      expect(outBeta).toContain("⚠ skill \"shared-skill\" 與既有同名，未投影（名稱衝突）");
      expect(outBeta).toContain(RELOAD_NOTICE);
    } finally {
      rmSync(mktA, { recursive: true, force: true });
      rmSync(mktB, { recursive: true, force: true });
    }
  });

  it("update re-fetches all registered marketplaces and reports change status per marketplace", async () => {
    // Empty state case
    const mockEmpty = createMockIo();
    const codeEmpty = await runCli(["update"], mockEmpty.io, { cwd, agentDir });
    expect(codeEmpty).toBe(0);
    expect(mockEmpty.stdout.join("")).toContain("尚無已註冊的 marketplace。");
    expect(mockEmpty.stdout.join("")).not.toContain(RELOAD_NOTICE);

    const mktA = mkdtempSync(join(tmpdir(), "cli-upd-a-"));
    const mktB = mkdtempSync(join(tmpdir(), "cli-upd-b-"));
    makeSyntheticMarketplace(mktA, "mkt-alpha", [
      { name: "plugin-a", path: "./plugins/plugin-a", skills: ["s-a"] },
    ]);
    makeSyntheticMarketplace(mktB, "mkt-beta", [
      { name: "plugin-b", path: "./plugins/plugin-b", skills: ["s-b"] },
    ]);

    try {
      await runCli(["add", mktA], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktB], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "1"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "2"], createMockIo().io, { cwd, agentDir });

      // 1. Initial update with no changes
      const mockNoChange = createMockIo();
      const codeNoChange = await runCli(["update"], mockNoChange.io, { cwd, agentDir });
      expect(codeNoChange).toBe(0);
      expect(mockNoChange.stderr).toHaveLength(0);
      const outNoChange = mockNoChange.stdout.join("");
      expect(outNoChange).toContain("mkt-alpha  重新抓取… 無變化");
      expect(outNoChange).toContain("mkt-beta  重新抓取… 無變化");
      expect(outNoChange).not.toContain(RELOAD_NOTICE);

      // 2. Modify mkt-beta material on disk
      addSkillToSyntheticPlugin(join(mktB, "plugins", "plugin-b"), "s-b-new");

      // 3. Update reflects changes per marketplace with single CLI reload notice
      const mockChanged = createMockIo();
      const codeChanged = await runCli(["update"], mockChanged.io, { cwd, agentDir });
      expect(codeChanged).toBe(0);
      expect(mockChanged.stderr).toHaveLength(0);
      const outChanged = mockChanged.stdout.join("");
      expect(outChanged).toContain("mkt-alpha  重新抓取… 無變化");
      expect(outChanged).toContain("mkt-beta  重新抓取… plugin-b 有新版本");
      expect(outChanged).toContain(RELOAD_NOTICE);
      expect(outChanged).not.toContain("已重新載入生效");

      const st = readMinimalBridgeState({ agentDir });
      const instB = st.state.installations.find((i) => i.manifestName === "plugin-b")!;
      expect(instB.skills).toEqual(["s-b", "s-b-new"]);
    } finally {
      rmSync(mktA, { recursive: true, force: true });
      rmSync(mktB, { recursive: true, force: true });
    }
  });

  it("update does not abort mid-catalog on a single failure and continues processing remaining marketplaces", async () => {
    const mktA = mkdtempSync(join(tmpdir(), "cli-tol-a-"));
    const mktB = mkdtempSync(join(tmpdir(), "cli-tol-b-"));
    const mktC = mkdtempSync(join(tmpdir(), "cli-tol-c-"));
    makeSyntheticMarketplace(mktA, "mkt-one", [{ name: "p1", path: "./plugins/p1", skills: ["s1"] }]);
    makeSyntheticMarketplace(mktB, "mkt-two", [{ name: "p2", path: "./plugins/p2", skills: ["s2"] }]);
    makeSyntheticMarketplace(mktC, "mkt-three", [{ name: "p3", path: "./plugins/p3", skills: ["s3"] }]);

    try {
      await runCli(["add", mktA], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktB], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktC], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "1"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "3"], createMockIo().io, { cwd, agentDir });

      // Corrupt mktB catalog
      writeFileSync(join(mktB, ".agents", "plugins", "marketplace.json"), "{ invalid json");

      const mockUpd = createMockIo();
      const codeUpd = await runCli(["update"], mockUpd.io, { cwd, agentDir });
      expect(codeUpd).toBe(0);
      const out = mockUpd.stdout.join("");
      expect(out).toContain("mkt-one  重新抓取… 無變化");
      expect(out).toMatch(/⚠ marketplace \[mkt-two\]/);
      expect(out).toContain("mkt-three  重新抓取… 無變化");
    } finally {
      rmSync(mktA, { recursive: true, force: true });
      rmSync(mktB, { recursive: true, force: true });
      rmSync(mktC, { recursive: true, force: true });
    }
  });

  it("demonstrates end-to-end demo flow via bin/pi-codex-marketplace.js child process: add -> install -> update (with evolution and reinstall)", async () => {
    const binPath = join(process.cwd(), "bin", "pi-codex-marketplace.js");
    const demoFixture = mkdtempSync(join(tmpdir(), "cli-demo-inst-fixture-"));
    makeSyntheticMarketplace(demoFixture, "demo-suite", [
      { name: "calc-plugin", path: "./plugins/calc-plugin", skills: ["add-skill", "sub-skill"] },
      { name: "format-plugin", path: "./plugins/format-plugin", skills: ["json-skill"] },
    ]);

    try {
      // Step 1: add marketplace
      const { stdout: addOut } = await execCli(binPath, ["add", demoFixture], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(addOut).toContain("已註冊 \"demo-suite\"");

      // Step 2: install by enumeration number (1)
      const { stdout: inst1Out } = await execCli(binPath, ["install", "1"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(inst1Out).toContain("安裝 \"calc-plugin\"（2 skills：add-skill, sub-skill）");
      expect(inst1Out).toContain(RELOAD_NOTICE);

      // Step 3: install by candidate name (format-plugin)
      const { stdout: inst2Out } = await execCli(binPath, ["install", "format-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(inst2Out).toContain("安裝 \"format-plugin\"（1 skills：json-skill）");
      expect(inst2Out).toContain(RELOAD_NOTICE);

      // Step 4: update initially shows "無變化"
      const { stdout: upd1Out } = await execCli(binPath, ["update"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(upd1Out).toContain("demo-suite  重新抓取… 無變化");
      expect(upd1Out).not.toContain(RELOAD_NOTICE);

      // Step 5: add a new skill to calc-plugin
      addSkillToSyntheticPlugin(join(demoFixture, "plugins", "calc-plugin"), "mul-skill");

      // Step 6: update detects "有新版本"
      const { stdout: upd2Out } = await execCli(binPath, ["update"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(upd2Out).toContain("demo-suite  重新抓取… calc-plugin, format-plugin 有新版本");
      expect(upd2Out).toContain(RELOAD_NOTICE);

      // Step 7: repeated install on format-plugin after adding xml-skill (重裝＝更新)
      addSkillToSyntheticPlugin(join(demoFixture, "plugins", "format-plugin"), "xml-skill");
      const { stdout: reinstallOut } = await execCli(binPath, ["install", "format-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(reinstallOut).toContain("安裝 \"format-plugin\"（2 skills：json-skill, xml-skill）");
      expect(reinstallOut).toContain(RELOAD_NOTICE);
    } finally {
      rmSync(demoFixture, { recursive: true, force: true });
    }
  }, 60000);
});

describe("Lifecycle 表面：disable／enable／remove／forget (#132, #136)", () => {
  let cwd: string;
  let agentDir: string;
  let statePath: string;

  beforeEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    cwd = mkdtempSync(join(tmpdir(), "cli-life-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "cli-life-agent-"));
    statePath = join(agentDir, "codex-marketplace", "state.json");
    mkdirSync(join(agentDir, "codex-marketplace"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    delete process.env[CREDENTIAL_HELPERS_ENV];
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_AGENT_DIR;
  });

  it("disable excludes installation from Effective State; enable re-projects it; both exit 0 to stdout with no prompt", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-life-dis-en-"));
    makeSyntheticMarketplace(mktRoot, "life-mkt", [
      { name: "plugin-a", path: "./plugins/plugin-a", skills: ["skill-a1", "skill-a2"] },
    ]);

    try {
      await runCli(["add", mktRoot], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "1"], createMockIo().io, { cwd, agentDir });

      // Initial state: installed and projected
      let proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("skill-a1"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("skill-a2"))).toBe(true);

      // 1. disable plugin-a
      const mockDisable = createMockIo();
      const codeDisable = await runCli(["disable", "plugin-a"], mockDisable.io, { cwd, agentDir });
      expect(codeDisable).toBe(0);
      expect(mockDisable.exitCodes).toEqual([0]);
      expect(mockDisable.stderr).toHaveLength(0);
      expect(mockDisable.stdout.join("")).toContain("已停用 \"plugin-a\"");

      const stDisabled = readMinimalBridgeState({ agentDir });
      expect(stDisabled.state.installations[0].enabled).toBe(false);
      expect(stDisabled.state.installations[0].installationState).toBe("disabled");

      // Effective State projection excludes disabled plugin
      proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("skill-a1"))).toBe(false);
      expect(proj.skillPaths.some((p) => p.includes("skill-a2"))).toBe(false);

      // 2. disable already-disabled plugin-a (idempotent, exit 0 to stdout)
      const mockDisAgain = createMockIo();
      const codeDisAgain = await runCli(["disable", "plugin-a"], mockDisAgain.io, { cwd, agentDir });
      expect(codeDisAgain).toBe(0);
      expect(mockDisAgain.stderr).toHaveLength(0);
      expect(mockDisAgain.stdout.join("")).toContain("\"plugin-a\" 已是停用狀態");

      // 3. enable plugin-a
      const mockEnable = createMockIo();
      const codeEnable = await runCli(["enable", "plugin-a"], mockEnable.io, { cwd, agentDir });
      expect(codeEnable).toBe(0);
      expect(mockEnable.exitCodes).toEqual([0]);
      expect(mockEnable.stderr).toHaveLength(0);
      const enableOut = mockEnable.stdout.join("");
      expect(enableOut).toContain("已啟用 \"plugin-a\"（2 skills：skill-a1, skill-a2）");
      expect(enableOut).toContain(RELOAD_NOTICE);
      expect(enableOut).not.toContain("已重新載入生效");

      const stEnabled = readMinimalBridgeState({ agentDir });
      expect(stEnabled.state.installations[0].enabled).toBe(true);
      expect(stEnabled.state.installations[0].installationState).toBe("enabled");

      // Effective State projection re-includes enabled plugin
      proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("skill-a1"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("skill-a2"))).toBe(true);

      // 4. enable already-enabled plugin-a (idempotent, exit 0 to stdout)
      const mockEnAgain = createMockIo();
      const codeEnAgain = await runCli(["enable", "plugin-a"], mockEnAgain.io, { cwd, agentDir });
      expect(codeEnAgain).toBe(0);
      expect(mockEnAgain.stderr).toHaveLength(0);
      expect(mockEnAgain.stdout.join("")).toContain("\"plugin-a\" 已是啟用狀態");
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("enable re-evaluates and reports skill collision warning while preserving successful enablement", async () => {
    const mktX = mkdtempSync(join(tmpdir(), "cli-life-col-x-"));
    const mktY = mkdtempSync(join(tmpdir(), "cli-life-col-y-"));
    makeSyntheticMarketplace(mktX, "mkt-x", [
      { name: "p-x", path: "./plugins/p-x", skills: ["shared-skill", "x-unique"] },
    ]);
    makeSyntheticMarketplace(mktY, "mkt-y", [
      { name: "p-y", path: "./plugins/p-y", skills: ["shared-skill", "y-unique"] },
    ]);

    try {
      await runCli(["add", mktX], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktY], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "1"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "2"], createMockIo().io, { cwd, agentDir });

      // Disable p-y -> shared-skill now projected from p-x
      await runCli(["disable", "p-y"], createMockIo().io, { cwd, agentDir });
      let proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("shared-skill"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("x-unique"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("y-unique"))).toBe(false);

      // Re-enable p-y -> collision re-emerges
      const mockEnable = createMockIo();
      const codeEnable = await runCli(["enable", "p-y"], mockEnable.io, { cwd, agentDir });
      expect(codeEnable).toBe(0);
      expect(mockEnable.stderr).toHaveLength(0);
      const enableOut = mockEnable.stdout.join("");
      expect(enableOut).toContain("已啟用 \"p-y\"");
      expect(enableOut).toContain("⚠ skill \"shared-skill\" 與既有同名，未投影（名稱衝突）");
      expect(enableOut).toContain(RELOAD_NOTICE);

      proj = discoverProjectedSkillPaths({ agentDir });
      // Both colliders denied shared-skill; distinct skills projected
      expect(proj.skillPaths.some((p) => p.includes("shared-skill"))).toBe(false);
      expect(proj.skillPaths.some((p) => p.includes("x-unique"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("y-unique"))).toBe(true);
    } finally {
      rmSync(mktX, { recursive: true, force: true });
      rmSync(mktY, { recursive: true, force: true });
    }
  });

  it("remove deletes the named installation only — marketplace registration and sibling installations remain", async () => {
    const mktRoot = mkdtempSync(join(tmpdir(), "cli-life-rem-"));
    makeSyntheticMarketplace(mktRoot, "sib-mkt", [
      { name: "p-one", path: "./plugins/p-one", skills: ["s-one"] },
      { name: "p-two", path: "./plugins/p-two", skills: ["s-two"] },
      { name: "p-three", path: "./plugins/p-three", skills: ["s-three"] },
    ]);

    try {
      await runCli(["add", mktRoot], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "p-one"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "p-two"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "p-three"], createMockIo().io, { cwd, agentDir });

      const beforeCatalog = readFileSync(join(mktRoot, ".agents", "plugins", "marketplace.json"), "utf8");
      const beforePluginTwo = readFileSync(join(mktRoot, "plugins", "p-two", "plugin.json"), "utf8");

      // 1. Remove p-two
      const mockRemove = createMockIo();
      const codeRemove = await runCli(["remove", "p-two"], mockRemove.io, { cwd, agentDir });
      expect(codeRemove).toBe(0);
      expect(mockRemove.exitCodes).toEqual([0]);
      expect(mockRemove.stderr).toHaveLength(0);
      expect(mockRemove.stdout.join("")).toContain("已移除 \"p-two\"");

      // 2. Verify state: p-two removed, siblings and registration retained
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.registrations).toHaveLength(1);
      expect(st.state.registrations[0].marketplaceName).toBe("sib-mkt");
      expect(st.state.installations).toHaveLength(2);
      const installedNames = st.state.installations.map((i) => i.manifestName);
      expect(installedNames).toContain("p-one");
      expect(installedNames).toContain("p-three");
      expect(installedNames).not.toContain("p-two");

      // 3. Source files on disk are completely untouched
      expect(readFileSync(join(mktRoot, ".agents", "plugins", "marketplace.json"), "utf8")).toBe(beforeCatalog);
      expect(readFileSync(join(mktRoot, "plugins", "p-two", "plugin.json"), "utf8")).toBe(beforePluginTwo);

      // 4. Projection reflects removal
      const proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("s-one"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("s-three"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("s-two"))).toBe(false);

      // 5. list shows p-two as "可安裝" and others as "已裝啟用"
      const mockList = createMockIo();
      await runCli(["list"], mockList.io, { cwd, agentDir });
      const listOut = mockList.stdout.join("");
      expect(listOut).toContain("p-one");
      expect(listOut).toContain("p-three");
      expect(listOut).toContain("p-two");
      expect(listOut).toContain("可安裝");

      // 6. Reinstalling p-two succeeds cleanly
      const mockReinstall = createMockIo();
      const codeReinstall = await runCli(["install", "p-two"], mockReinstall.io, { cwd, agentDir });
      expect(codeReinstall).toBe(0);
      expect(mockReinstall.stdout.join("")).toContain("安裝 \"p-two\"");
      expect(readMinimalBridgeState({ agentDir }).state.installations).toHaveLength(3);
    } finally {
      rmSync(mktRoot, { recursive: true, force: true });
    }
  });

  it("forget removes marketplace registration and all its installations as one disclosed atomic effect", async () => {
    const mktTarget = mkdtempSync(join(tmpdir(), "cli-life-tgt-"));
    const mktKeep = mkdtempSync(join(tmpdir(), "cli-life-keep-"));
    makeSyntheticMarketplace(mktTarget, "target-mkt", [
      { name: "t-one", path: "./plugins/t-one", skills: ["t-skill-1"] },
      { name: "t-two", path: "./plugins/t-two", skills: ["t-skill-2"] },
    ]);
    makeSyntheticMarketplace(mktKeep, "keep-mkt", [
      { name: "k-one", path: "./plugins/k-one", skills: ["k-skill-1"] },
    ]);

    try {
      await runCli(["add", mktTarget], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktKeep], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "t-one"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "t-two"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "k-one"], createMockIo().io, { cwd, agentDir });

      const beforeTargetCatalog = readFileSync(join(mktTarget, ".agents", "plugins", "marketplace.json"), "utf8");

      // 1. Forget target-mkt (has 2 installations)
      const mockForget = createMockIo();
      const codeForget = await runCli(["forget", "target-mkt"], mockForget.io, { cwd, agentDir });
      expect(codeForget).toBe(0);
      expect(mockForget.exitCodes).toEqual([0]);
      expect(mockForget.stderr).toHaveLength(0);
      expect(mockForget.stdout.join("")).toContain("已移除 marketplace \"target-mkt\"（含 2 個安裝）");

      // 2. Verify state: target-mkt and both its installations removed; keep-mkt untouched
      const st = readMinimalBridgeState({ agentDir });
      expect(st.state.registrations).toHaveLength(1);
      expect(st.state.registrations[0].marketplaceName).toBe("keep-mkt");
      expect(st.state.installations).toHaveLength(1);
      expect(st.state.installations[0].manifestName).toBe("k-one");

      // 3. Source files on disk are completely untouched
      expect(readFileSync(join(mktTarget, ".agents", "plugins", "marketplace.json"), "utf8")).toBe(beforeTargetCatalog);

      // 4. Projection reflects atomic removal
      const proj = discoverProjectedSkillPaths({ agentDir });
      expect(proj.skillPaths.some((p) => p.includes("k-skill-1"))).toBe(true);
      expect(proj.skillPaths.some((p) => p.includes("t-skill-1"))).toBe(false);
      expect(proj.skillPaths.some((p) => p.includes("t-skill-2"))).toBe(false);

      // 5. Forget marketplace with 0 installations
      const mktEmpty = mkdtempSync(join(tmpdir(), "cli-life-emp-"));
      makeSyntheticMarketplace(mktEmpty, "empty-mkt", [{ name: "e1", path: "./plugins/e1" }]);
      try {
        await runCli(["add", mktEmpty], createMockIo().io, { cwd, agentDir });
        const mockForgetEmpty = createMockIo();
        const codeForgetEmpty = await runCli(["forget", "empty-mkt"], mockForgetEmpty.io, { cwd, agentDir });
        expect(codeForgetEmpty).toBe(0);
        expect(mockForgetEmpty.stderr).toHaveLength(0);
        expect(mockForgetEmpty.stdout.join("")).toContain("已移除 marketplace \"empty-mkt\"");
        expect(mockForgetEmpty.stdout.join("")).not.toContain("含");
      } finally {
        rmSync(mktEmpty, { recursive: true, force: true });
      }
    } finally {
      rmSync(mktTarget, { recursive: true, force: true });
      rmSync(mktKeep, { recursive: true, force: true });
    }
  });

  it("disable/enable/remove/forget report clear error to stderr and exit 1 on unknown names or ambiguous names without prompting", async () => {
    // 1. Unknown names on empty state
    const mockDisUnknown = createMockIo();
    const codeDisUnknown = await runCli(["disable", "ghost-plugin"], mockDisUnknown.io, { cwd, agentDir });
    expect(codeDisUnknown).toBe(1);
    expect(mockDisUnknown.stdout).toHaveLength(0);
    expect(mockDisUnknown.stderr.join("")).toContain("錯誤：找不到已安裝的 plugin \"ghost-plugin\"");

    const mockEnUnknown = createMockIo();
    const codeEnUnknown = await runCli(["enable", "ghost-plugin"], mockEnUnknown.io, { cwd, agentDir });
    expect(codeEnUnknown).toBe(1);
    expect(mockEnUnknown.stdout).toHaveLength(0);
    expect(mockEnUnknown.stderr.join("")).toContain("錯誤：找不到已安裝的 plugin \"ghost-plugin\"");

    const mockRemUnknown = createMockIo();
    const codeRemUnknown = await runCli(["remove", "ghost-plugin"], mockRemUnknown.io, { cwd, agentDir });
    expect(codeRemUnknown).toBe(1);
    expect(mockRemUnknown.stdout).toHaveLength(0);
    expect(mockRemUnknown.stderr.join("")).toContain("錯誤：找不到已安裝的 plugin \"ghost-plugin\"");

    const mockForUnknown = createMockIo();
    const codeForUnknown = await runCli(["forget", "ghost-mkt"], mockForUnknown.io, { cwd, agentDir });
    expect(codeForUnknown).toBe(1);
    expect(mockForUnknown.stdout).toHaveLength(0);
    expect(mockForUnknown.stderr.join("")).toContain("錯誤：找不到 marketplace \"ghost-mkt\"");

    // 2. Ambiguous names across two registrations
    const mktA = mkdtempSync(join(tmpdir(), "cli-life-amb-a-"));
    const mktB = mkdtempSync(join(tmpdir(), "cli-life-amb-b-"));
    makeSyntheticMarketplace(mktA, "mkt-first", [{ name: "dup-plugin", path: "./plugins/dup-plugin" }]);
    makeSyntheticMarketplace(mktB, "mkt-second", [{ name: "dup-plugin", path: "./plugins/dup-plugin" }]);

    try {
      await runCli(["add", mktA], createMockIo().io, { cwd, agentDir });
      await runCli(["add", mktB], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "1"], createMockIo().io, { cwd, agentDir });
      await runCli(["install", "2"], createMockIo().io, { cwd, agentDir });

      // disable ambiguous
      const mockDisAmb = createMockIo();
      const codeDisAmb = await runCli(["disable", "dup-plugin"], mockDisAmb.io, { cwd, agentDir });
      expect(codeDisAmb).toBe(1);
      expect(mockDisAmb.stdout).toHaveLength(0);
      expect(mockDisAmb.stderr.join("")).toContain("錯誤：名稱 \"dup-plugin\" 對應多個已安裝 plugin");

      // enable ambiguous
      const mockEnAmb = createMockIo();
      const codeEnAmb = await runCli(["enable", "dup-plugin"], mockEnAmb.io, { cwd, agentDir });
      expect(codeEnAmb).toBe(1);
      expect(mockEnAmb.stdout).toHaveLength(0);
      expect(mockEnAmb.stderr.join("")).toContain("錯誤：名稱 \"dup-plugin\" 對應多個已安裝 plugin");

      // remove ambiguous
      const mockRemAmb = createMockIo();
      const codeRemAmb = await runCli(["remove", "dup-plugin"], mockRemAmb.io, { cwd, agentDir });
      expect(codeRemAmb).toBe(1);
      expect(mockRemAmb.stdout).toHaveLength(0);
      expect(mockRemAmb.stderr.join("")).toContain("錯誤：名稱 \"dup-plugin\" 對應多個已安裝 plugin");
    } finally {
      rmSync(mktA, { recursive: true, force: true });
      rmSync(mktB, { recursive: true, force: true });
    }
  });

  it("demonstrates end-to-end demo flow via bin/pi-codex-marketplace.js child process: disable -> enable -> remove -> forget", async () => {
    const binPath = join(process.cwd(), "bin", "pi-codex-marketplace.js");
    const demoFixture = mkdtempSync(join(tmpdir(), "cli-demo-life-fixture-"));
    makeSyntheticMarketplace(demoFixture, "demo-lifecycle-mkt", [
      { name: "calc-plugin", path: "./plugins/calc-plugin", skills: ["calc-add", "calc-sub"] },
      { name: "format-plugin", path: "./plugins/format-plugin", skills: ["fmt-json"] },
    ]);

    try {
      // Step 1: add marketplace
      const { stdout: addOut } = await execCli(binPath, ["add", demoFixture], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(addOut).toContain("已註冊 \"demo-lifecycle-mkt\"");

      // Step 2: install both plugins
      const { stdout: inst1Out } = await execCli(binPath, ["install", "calc-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(inst1Out).toContain("安裝 \"calc-plugin\"");

      const { stdout: inst2Out } = await execCli(binPath, ["install", "format-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(inst2Out).toContain("安裝 \"format-plugin\"");

      // Step 3: disable calc-plugin
      const { stdout: disOut } = await execCli(binPath, ["disable", "calc-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(disOut).toContain("已停用 \"calc-plugin\"");

      // Overview check: calc-plugin shows 停用, format-plugin shows 啟用
      const { stdout: overviewOut } = await execCli(binPath, [], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(overviewOut).toContain("calc-plugin");
      expect(overviewOut).toContain("停用");
      expect(overviewOut).toContain("format-plugin");
      expect(overviewOut).toContain("啟用");

      // Step 4: enable calc-plugin
      const { stdout: enOut } = await execCli(binPath, ["enable", "calc-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(enOut).toContain("已啟用 \"calc-plugin\"");
      expect(enOut).toContain(RELOAD_NOTICE);

      // Step 5: remove calc-plugin
      const { stdout: remOut } = await execCli(binPath, ["remove", "calc-plugin"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(remOut).toContain("已移除 \"calc-plugin\"");

      // List check: calc-plugin is 可安裝, format-plugin is 已裝啟用
      const { stdout: listOut } = await execCli(binPath, ["list"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(listOut).toContain("calc-plugin");
      expect(listOut).toContain("可安裝");
      expect(listOut).toContain("format-plugin");
      expect(listOut).toContain("已裝啟用");

      // Step 6: forget marketplace (removes registration and remaining format-plugin installation)
      const { stdout: forgetOut } = await execCli(binPath, ["forget", "demo-lifecycle-mkt"], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(forgetOut).toContain("已移除 marketplace \"demo-lifecycle-mkt\"（含 1 個安裝）");

      // Step 7: overview confirms completely empty state
      const { stdout: finalOverview } = await execCli(binPath, [], {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_AGENT_DIR: agentDir,
      });
      expect(finalOverview).toContain("尚未註冊任何 marketplace");
      expect(finalOverview).toContain("尚未安裝任何 plugin");
    } finally {
      rmSync(demoFixture, { recursive: true, force: true });
    }
  }, 60000);
});


