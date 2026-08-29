/**
 * Git Source Acquisition — marketplace-level HEAD retrieval at its Resolved Revision.
 * See CONTEXT.md: Source Acquisition, Acquisition Trust Base.
 *
 * Minimal: always resolves HEAD via `git ls-remote HEAD` → `clone --no-checkout` →
 * checkout. No per-entry pins / branch / tag / commit selectors (git-selector retired).
 *
 * Guarantees: never runs hooks/filters/submodules, trusts only selected Git/SSH + system CA.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';
import type { CanonicalGitLocator } from './git-locator.js';
import { CREDENTIAL_HELPERS_ENV } from './credential-helpers.js';

export interface GitExecutor {
  (args: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/** Default executor that spawns `git` */
export function defaultGitExecutor(): GitExecutor {
  return (args, opts) =>
    new Promise((resolve) => {
      const env = { ...process.env, ...opts?.env } as Record<string, string>;
      const child = spawn('git', args, {
        cwd: opts?.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.on('error', (err) => resolve({ exitCode: 1, stdout: '', stderr: String(err) }));
    });
}

export interface AcquisitionTrustOptions {
  knownHostsFile?: string;
  allowedCredentialHelpers?: string[];
  gitPath?: string;
  sshCommand?: string;
  allowRedirects?: boolean;
}

export interface AcquireOptions {
  cwd?: string;
  agentDir?: string;
  locator: CanonicalGitLocator;
  trust?: AcquisitionTrustOptions;
  executor?: GitExecutor;
  destDir?: string;
  timeoutMs?: number;
}

export interface AcquireResult {
  ok: boolean;
  acquiredPath?: string;
  resolvedRevision?: string;
  findings: ValidationFinding[];
  stderr?: string;
  createdTemp?: boolean;
}

function trustFinding(code: string, rule: string, outcome: string): ValidationFinding {
  return blocking({
    code,
    phase: 'validation',
    target: 'source',
    pointer: '',
    rule,
    outcome,
  });
}

function acquireFinding(outcome: string): ValidationFinding {
  return trustFinding(CODE.GIT_ACQUISITION_FAILED, RULE.GIT_ACQUISITION_FAILED, outcome);
}

function hardenedEnv(trust: AcquisitionTrustOptions | undefined, locator: CanonicalGitLocator): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  if (locator.transport === 'ssh') {
    const knownHosts = trust?.knownHostsFile ?? join(process.env.HOME ?? tmpdir(), '.ssh', 'known_hosts');
    let sshCmd = trust?.sshCommand ?? 'ssh';
    sshCmd += ` -o StrictHostKeyChecking=yes -o BatchMode=yes -o UserKnownHostsFile="${knownHosts.replace(/"/g, '\\"')}"`;
    sshCmd += ' -o CheckHostIP=yes';
    env.GIT_SSH_COMMAND = sshCmd;
  }
  return env;
}

function hardenedConfigArgs(trust?: AcquisitionTrustOptions): string[] {
  const args: string[] = [];
  args.push('-c', 'core.hooksPath=/dev/null');
  if (!trust?.allowedCredentialHelpers || trust.allowedCredentialHelpers.length === 0) {
    args.push('-c', 'credential.helper=');
  } else {
    args.push('-c', 'credential.helper=');
    for (const h of trust.allowedCredentialHelpers) {
      args.push('-c', `credential.helper=${h}`);
    }
  }
  if (trust?.allowRedirects !== true) {
    args.push('-c', 'http.followRedirects=false');
  }
  args.push('-c', 'http.sslVerify=true');
  args.push('-c', 'filter.lfs.process=');
  args.push('-c', 'filter.lfs.required=false');
  return args;
}

function isFullHex(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

function authFailureFinding(approvedHelpers: boolean, stderr: string): ValidationFinding {
  const why = approvedHelpers
    ? `approved credential helper was rejected by the remote — check your credentials`
    : `credential helper/agent not approved — set ${CREDENTIAL_HELPERS_ENV} to approve one, or use SSH`;
  return trustFinding(
    CODE.GIT_ACQUISITION_FAILED,
    RULE.GIT_TRUST_CREDENTIAL_HELPER,
    `Acquisition Trust Base violation: ${why} — ${stderr.trim()}`,
  );
}

function isAuthFailure(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('could not read username') || lower.includes('authentication failed') || lower.includes('credential');
}

async function resolveHead(
  locator: CanonicalGitLocator,
  executor: GitExecutor,
  env: Record<string, string>,
  configArgs: string[],
  approvedHelpers: boolean,
): Promise<{ ok: true; sha: string } | { ok: false; findings: ValidationFinding[]; stderr?: string }> {
  const lsArgs = [...configArgs, 'ls-remote', locator.canonicalUrl, 'HEAD'];
  const res = await executor(lsArgs, { env });
  if (res.exitCode !== 0) {
    const stderr = (res.stderr || '').toLowerCase();
    if (stderr.includes('host key verification failed') || stderr.includes('unknown host key') || stderr.includes('offending')) {
      const isChanged = stderr.includes('changed') || stderr.includes('offending') || stderr.includes('key changed');
      const code = isChanged ? CODE.GIT_TRUST_HOST_KEY_CHANGED : CODE.GIT_TRUST_HOST_KEY_UNKNOWN;
      return {
        ok: false,
        findings: [
          trustFinding(
            code,
            RULE.GIT_TRUST_HOST_KEY,
            `Acquisition Trust Base violation: SSH host key ${isChanged ? 'changed' : 'unknown'} for ${locator.host} — ${res.stderr.trim()} (only pre-established known-host keys are trusted)`,
          ),
        ],
        stderr: res.stderr,
      };
    }
    if (stderr.includes('redirect') || stderr.includes('moved') || stderr.includes('followredirects')) {
      return {
        ok: false,
        findings: [
          trustFinding(CODE.GIT_TRUST_REDIRECT, RULE.GIT_TRUST_REDIRECT, `Acquisition Trust Base violation: redirect that would change canonical locator (followRedirects disabled) — ${res.stderr.trim()}`),
        ],
        stderr: res.stderr,
      };
    }
    if (isAuthFailure(stderr)) {
      return {
        ok: false,
        findings: [authFailureFinding(approvedHelpers, res.stderr)],
        stderr: res.stderr,
      };
    }
    return {
      ok: false,
      findings: [acquireFinding(`failed to resolve HEAD via ls-remote: ${res.stderr.trim() || `exit ${res.exitCode}`}`)],
      stderr: res.stderr,
    };
  }

  const out = res.stdout.trim();
  if (!out) {
    return {
      ok: false,
      findings: [acquireFinding(`ls-remote returned no match for HEAD at ${locator.canonicalUrl}`)],
      stderr: res.stderr,
    };
  }

  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const peeledLine = lines.find((l) => l.includes('^{}'));
  const targetLine = peeledLine ?? lines[0];
  const tabIdx = targetLine.indexOf('\t');
  const sha = tabIdx >= 0 ? targetLine.slice(0, tabIdx).trim() : targetLine.split(/\s+/)[0].trim();
  if (!isFullHex(sha.toLowerCase())) {
    return {
      ok: false,
      findings: [trustFinding(CODE.GIT_RESOLVED_REVISION_INVALID, RULE.GIT_RESOLVED_REVISION_INVALID, `resolved revision is not full hex: '${sha}'`)],
      stderr: res.stderr,
    };
  }
  return { ok: true, sha: sha.toLowerCase() };
}

/** Resolve HEAD to a full commit SHA via non-executing ls-remote. */
export async function resolveGitRevision(
  locator: CanonicalGitLocator,
  opts: { executor?: GitExecutor; trust?: AcquisitionTrustOptions } = {},
): Promise<{ ok: true; sha: string } | { ok: false; findings: ValidationFinding[]; stderr?: string }> {
  const env = hardenedEnv(opts.trust, locator);
  const configArgs = hardenedConfigArgs(opts.trust);
  const approvedHelpers = (opts.trust?.allowedCredentialHelpers?.length ?? 0) > 0;
  return resolveHead(locator, opts.executor ?? defaultGitExecutor(), env, configArgs, approvedHelpers);
}

/**
 * Acquire a Git marketplace source at HEAD's Resolved Revision.
 */
export async function acquireGitSource(opts: AcquireOptions): Promise<AcquireResult> {
  const locator = opts.locator;
  const executor = opts.executor ?? defaultGitExecutor();
  const trust = opts.trust;
  const env = hardenedEnv(trust, locator);
  const configArgs = hardenedConfigArgs(trust);

  const resolved = await resolveHead(locator, executor, env, configArgs, (trust?.allowedCredentialHelpers?.length ?? 0) > 0);
  if (!resolved.ok) {
    return { ok: false, findings: (resolved as { findings: ValidationFinding[] }).findings, stderr: (resolved as { stderr?: string }).stderr };
  }
  const sha = (resolved as { sha: string }).sha;

  let dest: string;
  let createdTemp = false;
  if (opts.destDir) {
    dest = opts.destDir;
  } else {
    dest = mkdtempSync(join(tmpdir(), 'git-acq-'));
    createdTemp = true;
  }

  const cloneArgs = [...configArgs, 'clone', '--no-checkout', '--filter=blob:none', locator.canonicalUrl, dest];
  const cloneRes = await executor(cloneArgs, { env });
  if (cloneRes.exitCode !== 0) {
    const stderr = cloneRes.stderr || '';
    const lower = stderr.toLowerCase();
    if (lower.includes('host key verification failed') || lower.includes('unknown host key') || lower.includes('offending')) {
      const isChanged = lower.includes('changed') || lower.includes('offending');
      const code = isChanged ? CODE.GIT_TRUST_HOST_KEY_CHANGED : CODE.GIT_TRUST_HOST_KEY_UNKNOWN;
      if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return {
        ok: false,
        findings: [
          trustFinding(
            code,
            RULE.GIT_TRUST_HOST_KEY,
            `Acquisition Trust Base violation: SSH host key ${isChanged ? 'changed' : 'unknown'} — ${stderr.trim()}`,
          ),
        ],
        stderr,
      };
    }
    if (lower.includes('redirect') || lower.includes('moved permanently') || lower.includes('followredirects')) {
      if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return {
        ok: false,
        findings: [
          trustFinding(CODE.GIT_TRUST_REDIRECT, RULE.GIT_TRUST_REDIRECT, `Acquisition Trust Base violation: redirect changing canonical locator — ${stderr.trim()}`),
        ],
        stderr,
      };
    }
    if (isAuthFailure(stderr)) {
      if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return {
        ok: false,
        findings: [authFailureFinding((trust?.allowedCredentialHelpers?.length ?? 0) > 0, stderr)],
        stderr,
      };
    }
    if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
    return {
      ok: false,
      findings: [acquireFinding(`git clone failed: ${stderr.trim() || `exit ${cloneRes.exitCode}`}`)],
      stderr,
    };
  }

  if (trust?.allowRedirects !== true) {
    const remoteRes = await executor([...configArgs, '-C', dest, 'remote', 'get-url', 'origin'], { env });
    if (remoteRes.exitCode === 0) {
      const originUrl = remoteRes.stdout.trim();
      try {
        const orig = locator.canonicalUrl;
        if (originUrl !== orig) {
          const parseHost = (u: string): string | null => {
            try {
              if (u.includes('://')) return new URL(u).hostname.toLowerCase();
              const m = u.match(/@([^:]+):/);
              return m ? m[1].toLowerCase() : null;
            } catch { return null; }
          };
          const oh = parseHost(originUrl);
          const ch = locator.host;
          if (oh && oh !== ch) {
            if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
            return {
              ok: false,
              findings: [
                trustFinding(
                  CODE.GIT_TRUST_REDIRECT,
                  RULE.GIT_TRUST_REDIRECT,
                  `Acquisition Trust Base violation: canonical-locator-changing redirect — origin '${originUrl}' host '${oh}' differs from requested '${ch}'`,
                ),
              ],
            };
          }
        }
      } catch {}
    }
  }

  // Ensure resolved HEAD commit is fetchable
  const catRes = await executor([...configArgs, '-C', dest, 'cat-file', '-e', `${sha}^{commit}`], { env });
  if (catRes.exitCode !== 0) {
    const fetchRes = await executor([...configArgs, '-C', dest, 'fetch', 'origin', sha], { env });
    if (fetchRes.exitCode !== 0) {
      if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return {
        ok: false,
        findings: [acquireFinding(`resolved revision ${sha} not fetchable: ${fetchRes.stderr.trim()}`)],
        stderr: fetchRes.stderr,
      };
    }
  }

  const checkoutRes = await executor([...configArgs, '-C', dest, 'checkout', '--force', sha, '--'], { env });
  if (checkoutRes.exitCode !== 0) {
    const checkout2 = await executor([...configArgs, '-C', dest, 'checkout', '-f', sha], { env });
    if (checkout2.exitCode !== 0) {
      if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return {
        ok: false,
        findings: [acquireFinding(`failed to checkout resolved revision ${sha}: ${checkoutRes.stderr.trim() || checkout2.stderr.trim()}`)],
        stderr: checkoutRes.stderr,
      };
    }
  }

  return { ok: true, acquiredPath: dest, resolvedRevision: sha, findings: [], createdTemp };
}

/** Cleanup helper for acquired path when caller is done */
export function cleanupAcquisition(path: string): void {
  try {
    if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {}
}
