/**
 * Host-side disk guard for per-group provider state directories.
 *
 * Some providers keep their own state under `<DATA_DIR>/v2-sessions/<group-id>/`
 * — mounted read-write into every container for that group, persisted across
 * restarts and image changes. Nothing in that tree is written by us, so nothing
 * bounds it.
 *
 * The failure this exists for: codex writes a tracing DB at
 * `.codex-shared/logs_2.sqlite` and opens it *before* answering the JSON-RPC
 * `initialize` handshake. One busy group reached 31 GB, at which point every
 * spawn hit `Error: Timeout waiting for initialize response (30000ms)` and the
 * child exited cleanly — no stderr, no clue. Restarting the container and
 * repinning the image both "worked" and both changed nothing, because the state
 * directory outlives them.
 *
 * The real fixes belong in the provider (log verbosity, continuation rotation).
 * This is the belt-and-braces layer underneath them: the host notices the file
 * has grown past a cap and renames it aside on a sweep tick, so the next spawn
 * opens a fresh empty one. Deliberately narrow:
 *
 *   - Renames, never deletes. `mv` within a filesystem is an instant, reversible
 *     rename; the operator reclaims the space by deleting the backup once the
 *     group is confirmed healthy. `VACUUM` is never an option here — it needs
 *     roughly 2× the file size in free space, which is exactly what a disk in
 *     this state does not have.
 *   - Renames only files named in `GUARDED_STATE_FILES`. Everything else in the
 *     state dir stays put — notably codex's `sessions/**` rollouts, which are
 *     load-bearing for `thread/resume` and whose rotation is the provider's job
 *     (`AgentProvider.maybeRotateContinuation`).
 *   - Safe against a running container: a rename leaves the open descriptor
 *     writing to the same inode, so nothing in flight breaks. Space comes back
 *     when the backup is deleted.
 */
import fs from 'fs';
import path from 'path';

import { PROVIDER_STATE_MAX_BYTES_OVERRIDE } from './config.js';
import { log } from './log.js';

/**
 * 2 GB — Fred was already 15× past this by the time it stopped answering, and
 * even a quiet codex group takes ~2 months to get here. Override per install
 * with `NANOCLAW_PROVIDER_STATE_MAX_BYTES` in `.env`.
 */
export const DEFAULT_STATE_FILE_MAX_BYTES = 2 * 1024 ** 3;

/** codex's own tracing log, relative to the group's session root. */
export const CODEX_LOG_REL_PATH = path.join('.codex-shared', 'logs_2.sqlite');

export interface GuardedStateFile {
  /** Provider that owns the file — for logs only; the check is path-based. */
  provider: string;
  /** Path relative to `<DATA_DIR>/v2-sessions/<group-id>/`. */
  relPath: string;
  /**
   * Suffixes moved along with the main file. SQLite resolves its sidecars by
   * appending these to the database path, so carrying them across keeps the
   * backup openable read-only — and stops a stale `-wal` sitting next to the
   * fresh database the provider creates on its next spawn.
   */
  sidecarSuffixes: string[];
}

/**
 * Provider state files the host bounds. Path-keyed rather than looked up
 * through the provider registry on purpose: the guard has to work on a group
 * whose provider payload is missing, broken, or not yet installed — which is
 * precisely when its state directory is least likely to be maintained.
 */
export const GUARDED_STATE_FILES: GuardedStateFile[] = [
  { provider: 'codex', relPath: CODEX_LOG_REL_PATH, sidecarSuffixes: ['-wal', '-shm'] },
];

export type StateFileDecision = { action: 'ok' } | { action: 'rotate'; reason: string };

function humanBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** Pure size decision — the filesystem work happens in the caller. */
export function decideStateFileRotation(args: { sizeBytes: number; maxBytes: number }): StateFileDecision {
  const { sizeBytes, maxBytes } = args;
  if (sizeBytes <= maxBytes) return { action: 'ok' };
  return { action: 'rotate', reason: `${humanBytes(sizeBytes)} > ${humanBytes(maxBytes)} cap` };
}

export interface RotatedStateFile {
  agentGroupId: string;
  provider: string;
  path: string;
  rotatedTo: string;
  sizeBytes: number;
  reason: string;
}

/** `…/logs_2.sqlite` → `…/logs_2.sqlite.oversized-20260902T144233Z`. */
function backupPath(filePath: string, now: number): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${filePath}.oversized-${stamp}`;
}

function sizeOf(filePath: string): number | null {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function countExistingBackups(filePath: string): number {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.oversized-`;
  try {
    return fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}

function listGroupDirs(sessionsRoot: string): string[] {
  try {
    return fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // Root absent on a fresh install, or unreadable — nothing to guard.
    return [];
  }
}

/**
 * One sweep tick over every group's provider state directory.
 *
 * Returns what it rotated (empty on a healthy install — the normal case).
 * Never throws: a guard failure must not take down the sweep that also wakes
 * containers and retries stuck messages.
 */
export function sweepProviderStateFiles(
  sessionsRoot: string,
  opts: { maxBytes?: number; now?: number } = {},
): RotatedStateFile[] {
  const maxBytes = opts.maxBytes ?? PROVIDER_STATE_MAX_BYTES_OVERRIDE ?? DEFAULT_STATE_FILE_MAX_BYTES;
  const now = opts.now ?? Date.now();
  const rotated: RotatedStateFile[] = [];

  for (const agentGroupId of listGroupDirs(sessionsRoot)) {
    for (const guarded of GUARDED_STATE_FILES) {
      const filePath = path.join(sessionsRoot, agentGroupId, guarded.relPath);
      const sizeBytes = sizeOf(filePath);
      if (sizeBytes === null) continue;

      const decision = decideStateFileRotation({ sizeBytes, maxBytes });
      if (decision.action === 'ok') continue;

      const target = backupPath(filePath, now);
      const priorBackups = countExistingBackups(filePath);
      try {
        fs.renameSync(filePath, target);
      } catch (err) {
        log.error('Oversized provider state file could not be rotated', {
          agentGroupId,
          provider: guarded.provider,
          path: filePath,
          sizeBytes,
          err,
        });
        continue;
      }

      for (const suffix of guarded.sidecarSuffixes) {
        if (!fs.existsSync(`${filePath}${suffix}`)) continue;
        try {
          fs.renameSync(`${filePath}${suffix}`, `${target}${suffix}`);
        } catch (err) {
          log.warn('Provider state sidecar could not be rotated', {
            agentGroupId,
            path: `${filePath}${suffix}`,
            err,
          });
        }
      }

      // Loud on purpose: this is a group that was days away from silently
      // failing to start, and the backup is now the operator's to delete.
      log.error('Rotated oversized provider state file — delete the backup once the group is healthy', {
        agentGroupId,
        provider: guarded.provider,
        path: filePath,
        rotatedTo: target,
        sizeBytes,
        reason: decision.reason,
        priorBackups,
      });

      rotated.push({
        agentGroupId,
        provider: guarded.provider,
        path: filePath,
        rotatedTo: target,
        sizeBytes,
        reason: decision.reason,
      });
    }
  }

  return rotated;
}
