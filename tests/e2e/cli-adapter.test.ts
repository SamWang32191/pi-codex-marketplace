import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli, type CliIO, RELOAD_NOTICE } from "../../src/cli/index.js";
import { readMinimalBridgeState, writeMinimalBridgeState } from "../../src/bridge/state.js";
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

  it("demonstrates end-to-end demo flow via bin/pi-codex-marketplace.js child process: add fixture -> list entries", () => {
    const binPath = join(process.cwd(), "bin", "pi-codex-marketplace.js");
    const demoFixture = mkdtempSync(join(tmpdir(), "cli-demo-fixture-"));
    makeSyntheticMarketplace(demoFixture, "demo-market", [
      { name: "demo-logger", path: "./plugins/demo-logger", skills: ["log-helper"] },
      { name: "demo-parser", path: "./plugins/demo-parser", skills: ["parse-helper"] },
    ]);

    try {
      // Step 1: add local fixture marketplace
      const addOutput = execFileSync(process.execPath, [binPath, "add", demoFixture], {
        encoding: "utf-8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir },
      });
      expect(addOutput).toContain("偵測：codex marketplace · 2 plugins");
      expect(addOutput).toContain("已註冊 \"demo-market\"");

      // Step 2: list shows its entries
      const listOutput = execFileSync(process.execPath, [binPath, "list"], {
        encoding: "utf-8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir },
      });
      expect(listOutput).toContain("Marketplaces");
      expect(listOutput).toContain("Plugins（編號／所屬 marketplace／狀態）");
      expect(listOutput).toContain("demo-logger");
      expect(listOutput).toContain("demo-parser");
      expect(listOutput).toContain("可安裝");

      // Step 3: list [名稱] shows filtered marketplace entries
      const listFilteredOutput = execFileSync(process.execPath, [binPath, "list", "demo-market"], {
        encoding: "utf-8",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir },
      });
      expect(listFilteredOutput).toContain("demo-market");
      expect(listFilteredOutput).toContain("demo-logger");

      // Step 4: Duplicate add fails with non-zero exit code
      let failed = false;
      try {
        execFileSync(process.execPath, [binPath, "add", demoFixture], {
          encoding: "utf-8",
          env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DIR: agentDir },
        });
      } catch (err: any) {
        failed = true;
        expect(err.status).toBe(1);
        expect(err.stderr.toString()).toContain("已註冊過相同來源");
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(demoFixture, { recursive: true, force: true });
    }
  });
});
