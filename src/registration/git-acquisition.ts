/**
 * Git Source Acquisition — non-executing retrieval of a Git Marketplace Source at a Resolved Revision.
 * See CONTEXT.md: Source Acquisition, Acquisition Trust Base.
 *
 * Guarantees:
 * - Never runs repository-controlled hooks, filters, submodules, dependencies, or Plugin components.
 * - Only trusts selected Git/SSH, system CA, existing known-hosts, approved credential helper/agent.
 * - Rejects unknown/changed SSH host keys and canonical-locator-changing redirects (Blocking Findings).
 * - Rejects extends trust to repository content or repo-controlled git config.
 *
 * Implementation uses `git clone --no-checkout` with hardened config and environment, plus
 * `git ls-remote` for Resolved Revision binding before checkout.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CODE, RULE, blocking, type ValidationFinding } from './findings.js';
import type { CanonicalGitLocator } from './git-locator.js';
import type { NormalizedGitSelector } from './git-selector.js';

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
  /** Path to known_hosts file for SSH host key verification; defaults to ~/.ssh/known_hosts */
  knownHostsFile?: string;
  /** Allowed credential helpers (empty means none approved). If undefined, we disable all. */
  allowedCredentialHelpers?: string[];
  /** Selected git binary path (for provenance) */
  gitPath?: string;
  /** Selected ssh command (for provenance) */
  sshCommand?: string;
  /** Allow redirect that preserves canonical locator host? false = reject host-changing redirects */
  allowRedirects?: boolean;
}

export interface AcquireOptions {
  /** For isolated test dirs */
  cwd?: string;
  agentDir?: string;
  locator: CanonicalGitLocator;
  selector: NormalizedGitSelector;
  trust?: AcquisitionTrustOptions;
  /** Injected git executor for tests */
  executor?: GitExecutor;
  /** Destination directory (if not provided, a temp dir is created) */
  destDir?: string;
  /** Timeout for git operations (ms) */
  timeoutMs?: number;
}

export interface AcquireResult {
  ok: boolean;
  /** Directory containing the acquired repo (checkout of resolved revision) */
  acquiredPath?: string;
  /** Full 40/64 hex Resolved Revision bound before confirmation */
  resolvedRevision?: string;
  findings: ValidationFinding[];
  /** Raw executor stderr for diagnostics */
  stderr?: string;
  /** Whether the destDir should be cleaned up by caller (true when we created it) */
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

/** Build hardened git env and config for non-executing acquisition */
function hardenedEnv(trust: AcquisitionTrustOptions | undefined, locator: CanonicalGitLocator): Record<string, string> {
  const env: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: 'echo',
    // Disable LFS smudge by default to avoid executing filters
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  // SSH trust: StrictHostKeyChecking=yes, known_hostsFile must exist; BatchMode=yes prevents interactive.
  // If locator is ssh, we set GIT_SSH_COMMAND appropriately.
  if (locator.transport === 'ssh') {
    const knownHosts = trust?.knownHostsFile ?? join(process.env.HOME ?? tmpdir(), '.ssh', 'known_hosts');
    // Only trust pre-established known_hosts; we do not create it.
    let sshCmd = trust?.sshCommand ?? 'ssh';
    sshCmd += ` -o StrictHostKeyChecking=yes -o BatchMode=yes -o UserKnownHostsFile="${knownHosts.replace(/"/g, '\\"')}"`;
    // Also disable adding keys automatically
    sshCmd += ' -o CheckHostIP=yes';
    env.GIT_SSH_COMMAND = sshCmd;
  }
  // Credential helpers: by default disable all (empty credential.helper). Approved helpers could be allowed via config,
  // but per spec we only permit necessary trust + approved helper/agent. For scaffold we disable unless explicitly allowed.
  // This is handled via -c credential.helper= config, not env.
  return env;
}

function hardenedConfigArgs(trust?: AcquisitionTrustOptions): string[] {
  const args: string[] = [];
  // Disable hooks: point hooksPath to /dev/null
  args.push('-c', 'core.hooksPath=/dev/null');
  // Disable credential helpers unless approved
  if (!trust?.allowedCredentialHelpers || trust.allowedCredentialHelpers.length === 0) {
    args.push('-c', 'credential.helper=');
  } else {
    // allow only specified helpers; first clear then add allowed
    args.push('-c', 'credential.helper=');
    for (const h of trust.allowedCredentialHelpers) {
      args.push('-c', `credential.helper=${h}`);
    }
  }
  // Never follow redirects that would change canonical locator host — disable http redirects by default
  // If allowRedirects is explicitly true, we skip this and allow git default (follow). Otherwise block.
  if (trust?.allowRedirects !== true) {
    args.push('-c', 'http.followRedirects=false');
  }
  // Ensure SSL verification uses system CA (default)
  args.push('-c', 'http.sslVerify=true');
  // Disable filter process execution
  args.push('-c', 'filter.lfs.process=');
  args.push('-c', 'filter.lfs.required=false');
  return args;
}

function isFullHex(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

/** Resolve a selector to a full commit SHA via `git ls-remote` (except commit selector which is already resolved) */
async function resolveRevision(
  locator: CanonicalGitLocator,
  selector: NormalizedGitSelector,
  executor: GitExecutor,
  env: Record<string, string>,
  configArgs: string[],
): Promise<{ ok: true; sha: string } | { ok: false; findings: ValidationFinding[]; stderr?: string }> {
  // commit selector: already full hex, canonical is the sha (lowercased)
  if (selector.kind === 'commit') {
    const sha = selector.canonical;
    if (!isFullHex(sha)) {
      return {
        ok: false,
        findings: [
          trustFinding(CODE.GIT_RESOLVED_REVISION_INVALID, RULE.GIT_RESOLVED_REVISION_INVALID, `commit selector resolved revision is not full hex: '${sha}'`),
        ],
      };
    }
    // Verify that the commit is reachable (try ls-remote for that sha — many servers support, but if not,
    // we will verify after clone via cat-file). For now, assume reachable if format is valid; clone step will verify.
    return { ok: true, sha };
  }

  // default => HEAD ; branch => refs/heads/* ; tag => refs/tags/*
  let remoteRef: string;
  if (selector.kind === 'default') {
    remoteRef = 'HEAD';
  } else {
    remoteRef = selector.canonical; // already refs/heads/... or refs/tags/...
  }

  const lsArgs = [...configArgs, 'ls-remote', locator.canonicalUrl, remoteRef];
  const res = await executor(lsArgs, { env });
  if (res.exitCode !== 0) {
    // Distinguish trust failures from generic acquisition failures via stderr
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
    if (stderr.includes('could not read username') || stderr.includes('authentication failed') || stderr.includes('credential')) {
      return {
        ok: false,
        findings: [
          trustFinding(
            CODE.GIT_ACQUISITION_FAILED,
            RULE.GIT_TRUST_CREDENTIAL_HELPER,
            `Acquisition Trust Base: credential helper/agent not approved — ${res.stderr.trim()}`,
          ),
        ],
        stderr: res.stderr,
      };
    }
    return {
      ok: false,
      findings: [acquireFinding(`failed to resolve ${remoteRef} via ls-remote: ${res.stderr.trim() || `exit ${res.exitCode}`}`)],
      stderr: res.stderr,
    };
  }

  const out = res.stdout.trim();
  if (!out) {
    return {
      ok: false,
      findings: [acquireFinding(`ls-remote returned no match for ${remoteRef} at ${locator.canonicalUrl}`)],
      stderr: res.stderr,
    };
  }

  // ls-remote output: "<sha>\t<ref>" per line. For HEAD, may also include symref info when using --symref, but we used plain.
  // For default HEAD, we want the sha of HEAD. For branch/tag, we get sha of that ref. For annotated tags, server may return both refs/tags/v1 and refs/tags/v1^{}.
  // Prefer the peeled commit line (suffix ^{}) when present, otherwise fall back to the first line, ensuring Resolved Revision is always the commit.
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

/** Resolve a selector to a full commit SHA via non-executing ls-remote (#22 cache seam). */
export async function resolveGitRevision(
  locator: CanonicalGitLocator,
  selector: NormalizedGitSelector,
  opts: { executor?: GitExecutor; trust?: AcquisitionTrustOptions } = {},
): Promise<{ ok: true; sha: string } | { ok: false; findings: ValidationFinding[]; stderr?: string }> {
  const env = hardenedEnv(opts.trust, locator);
  const configArgs = hardenedConfigArgs(opts.trust);
  return resolveRevision(locator, selector, opts.executor ?? defaultGitExecutor(), env, configArgs);
}

/**
 * Acquire a Git source non-executingly at its Resolved Revision.
 * Uses `clone --no-checkout` with hardened config/env, then checks out the resolved revision.
 * Caller is responsible for cleaning the acquiredPath when done (if createdTemp is true) after validation.
 */
export async function acquireGitSource(opts: AcquireOptions): Promise<AcquireResult> {
  const locator = opts.locator;
  const selector = opts.selector;
  const executor = opts.executor ?? defaultGitExecutor();
  const trust = opts.trust;
  const env = hardenedEnv(trust, locator);
  const configArgs = hardenedConfigArgs(trust);

  // Resolve revision first (before clone) — binds full commit
  const resolved = await resolveRevision(locator, selector, executor, env, configArgs);
  if (!resolved.ok) {
    return { ok: false, findings: (resolved as { findings: ValidationFinding[] }).findings, stderr: (resolved as { stderr?: string }).stderr };
  }
  const sha = (resolved as { sha: string }).sha;

  // Prepare destination
  let dest: string;
  let createdTemp = false;
  if (opts.destDir) {
    dest = opts.destDir;
  } else {
    dest = mkdtempSync(join(tmpdir(), 'git-acq-'));
    createdTemp = true;
  }

  // Clone --no-checkout (non-executing: hooks/filters disabled via config)
  // Note: order is git [configArgs] clone --no-checkout --filter=blob:none <url> <dest>
  // We use --filter=blob:none to reduce bytes but not essential; we include it as non-executing hint.
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
    if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
    return {
      ok: false,
      findings: [acquireFinding(`git clone failed: ${stderr.trim() || `exit ${cloneRes.exitCode}`}`)],
      stderr,
    };
  }

  // Verify trust: redirect that changes host — check remote origin URL after clone
  // If http.followRedirects was disabled, clone would have failed above. If redirects were allowed but changed host, we detect.
  // We fetch the stored origin URL and compare host.
  if (trust?.allowRedirects !== true) {
    const remoteRes = await executor([...configArgs, '-C', dest, 'remote', 'get-url', 'origin'], { env });
    if (remoteRes.exitCode === 0) {
      const originUrl = remoteRes.stdout.trim();
      // Compare host of originUrl vs canonicalUrl (we parse both)
      try {
        // originUrl may be canonical as stored; but if clone followed redirect, originUrl might still be original.
        // To detect redirect, we could ask git for http effective URL via trace, but for now we compare if origin differs
        // by host/path — if origin host != canonical host => trust violation
        const orig = locator.canonicalUrl;
        if (originUrl !== orig) {
          // Parse both to compare hosts (simple string compare host extraction)
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

  // For commit selector, verify that the commit exists in the cloned repo (fetch if needed)
  // For branch/tag/default we already resolved via ls-remote, but we still need to fetch the object.
  // After clone --no-checkout, the remote refs are available, but for commit we may need to fetch directly.
  if (selector.kind === 'commit') {
    // Try to verify commit exists; if not, fetch it
    const catRes = await executor([...configArgs, '-C', dest, 'cat-file', '-e', `${sha}^{commit}`], { env });
    if (catRes.exitCode !== 0) {
      // Attempt fetch of that specific sha (server may allow)
      const fetchRes = await executor([...configArgs, '-C', dest, 'fetch', 'origin', sha], { env });
      if (fetchRes.exitCode !== 0) {
        if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
        return {
          ok: false,
          findings: [acquireFinding(`commit ${sha} not found at ${locator.canonicalUrl}: ${fetchRes.stderr.trim() || catRes.stderr.trim()}`)],
          stderr: fetchRes.stderr,
        };
      }
      const cat2 = await executor([...configArgs, '-C', dest, 'cat-file', '-e', `${sha}^{commit}`], { env });
      if (cat2.exitCode !== 0) {
        if (createdTemp) try { rmSync(dest, { recursive: true, force: true }); } catch {}
        return {
          ok: false,
          findings: [acquireFinding(`commit ${sha} still not resolvable after fetch: ${cat2.stderr.trim()}`)],
          stderr: cat2.stderr,
        };
      }
    }
  } else {
    // For branch/tag/default, ensure the resolved sha is fetchable: try to fetch that ref specifically if not already present
    // After clone, we can try to fetch the sha directly as well to ensure we have the object
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
  }

  // Materialize the tree at the resolved revision without running hooks/filters/submodules
  // Use checkout with hardened config: core.hooksPath already disabled, lfs filters disabled
  // We do: git -C <dest> checkout --force <sha> -- (or git checkout <sha> --)
  // Since we used --no-checkout, HEAD is not yet at sha; we checkout.
  // To avoid checking out with smudge, we already disabled filters via config.
  const checkoutRes = await executor([...configArgs, '-C', dest, 'checkout', '--force', sha, '--'], { env });
  if (checkoutRes.exitCode !== 0) {
    // Fallback: try `git -C dest checkout -f sha`
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

  // Ensure we did not accidentally recurse submodules (we never passed --recurse-submodules, so safe)
  // Also ensure .git/hooks not executed — we used core.hooksPath=/dev/null

  return { ok: true, acquiredPath: dest, resolvedRevision: sha, findings: [], createdTemp };
}

/** Cleanup helper for acquired path when caller is done */
export function cleanupAcquisition(path: string): void {
  try {
    if (path && existsSync(path)) rmSync(path, { recursive: true, force: true });
  } catch {}
}
