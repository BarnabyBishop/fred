/**
 * Host-side disk guard for per-group provider state directories.
 *
 * Regression cover for the 31 GB `logs_2.sqlite` that took a codex group down:
 * codex opens its own tracing DB before answering the JSON-RPC `initialize`
 * handshake, so past a size threshold every spawn times out at 30 s. Nothing
 * in the tree bounded that file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CODEX_LOG_REL_PATH,
  DEFAULT_STATE_FILE_MAX_BYTES,
  decideStateFileRotation,
  sweepProviderStateFiles,
} from './provider-state-guard.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-state-guard-'));
  roots.push(root);
  return root;
}

/** Sparse file — `stat.size` reports `bytes` without consuming the disk. */
function writeSized(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, 'w');
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function codexLog(root: string, groupId: string): string {
  return path.join(root, groupId, CODEX_LOG_REL_PATH);
}

function rotatedSiblings(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => n.includes('.oversized-'));
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('decideStateFileRotation', () => {
  it('leaves a file under the cap alone', () => {
    expect(decideStateFileRotation({ sizeBytes: 4 * 1024 * 1024, maxBytes: 2 * 1024 ** 3 })).toEqual({ action: 'ok' });
  });

  it('leaves a file exactly at the cap alone', () => {
    expect(decideStateFileRotation({ sizeBytes: 2 * 1024 ** 3, maxBytes: 2 * 1024 ** 3 })).toEqual({ action: 'ok' });
  });

  it('rotates past the cap, with both sizes in the reason', () => {
    const res = decideStateFileRotation({ sizeBytes: 31 * 1024 ** 3, maxBytes: 2 * 1024 ** 3 });
    expect(res.action).toBe('rotate');
    if (res.action !== 'rotate') return;
    expect(res.reason).toContain('31.0GB');
    expect(res.reason).toContain('2.0GB');
  });

  it('defaults the cap to 2GB', () => {
    expect(DEFAULT_STATE_FILE_MAX_BYTES).toBe(2 * 1024 ** 3);
  });
});

describe('sweepProviderStateFiles', () => {
  it('leaves a healthy state file untouched', () => {
    const root = makeRoot();
    const log = codexLog(root, 'ag-healthy');
    writeSized(log, 4 * 1024 * 1024);

    expect(sweepProviderStateFiles(root)).toEqual([]);
    expect(fs.existsSync(log)).toBe(true);
    expect(rotatedSiblings(path.dirname(log))).toEqual([]);
  });

  it('renames an oversized state file aside, with its sqlite sidecars', () => {
    const root = makeRoot();
    const log = codexLog(root, 'ag-fred');
    writeSized(log, 31 * 1024 ** 3);
    writeSized(`${log}-wal`, 8 * 1024 * 1024);
    writeSized(`${log}-shm`, 32 * 1024);

    const rotated = sweepProviderStateFiles(root);

    expect(rotated).toHaveLength(1);
    expect(rotated[0]).toMatchObject({
      agentGroupId: 'ag-fred',
      provider: 'codex',
      sizeBytes: 31 * 1024 ** 3,
    });

    // The resume path must be clear for the next spawn.
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(`${log}-wal`)).toBe(false);
    expect(fs.existsSync(`${log}-shm`)).toBe(false);

    // The backup keeps sqlite's own sidecar naming, so it stays openable.
    const backup = rotated[0].rotatedTo;
    expect(backup.startsWith(`${log}.oversized-`)).toBe(true);
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(`${backup}-wal`)).toBe(true);
    expect(fs.existsSync(`${backup}-shm`)).toBe(true);
  });

  it('rotates without sidecars present', () => {
    const root = makeRoot();
    const log = codexLog(root, 'ag-nowal');
    writeSized(log, 3 * 1024 ** 3);

    expect(sweepProviderStateFiles(root)).toHaveLength(1);
    expect(fs.existsSync(log)).toBe(false);
  });

  it('is idempotent — a second tick after rotation does nothing', () => {
    const root = makeRoot();
    const log = codexLog(root, 'ag-fred');
    writeSized(log, 31 * 1024 ** 3);

    expect(sweepProviderStateFiles(root)).toHaveLength(1);
    expect(sweepProviderStateFiles(root)).toEqual([]);
    expect(rotatedSiblings(path.dirname(log))).toHaveLength(1);
  });

  it('never touches anything but the guarded file — rollouts and configs stay put', () => {
    const root = makeRoot();
    const log = codexLog(root, 'ag-fred');
    writeSized(log, 31 * 1024 ** 3);
    const stateDir = path.dirname(log);
    // A big rollout is item 1's business (provider-side rotation): renaming it
    // here would break `thread/resume` behind the agent's back.
    const rollout = path.join(stateDir, 'sessions', '2026', '09', '02', 'rollout-abc.jsonl');
    writeSized(rollout, 21 * 1024 * 1024);
    const config = path.join(stateDir, 'config.toml');
    fs.writeFileSync(config, 'model = "gpt-5"\n');

    sweepProviderStateFiles(root);

    expect(fs.existsSync(rollout)).toBe(true);
    expect(fs.existsSync(config)).toBe(true);
  });

  it('honours a caller-supplied cap, and reports sub-GB sizes readably', () => {
    const root = makeRoot();
    writeSized(codexLog(root, 'ag-small'), 8 * 1024 * 1024);

    const rotated = sweepProviderStateFiles(root, { maxBytes: 4 * 1024 * 1024 });

    expect(rotated).toHaveLength(1);
    expect(rotated[0].reason).toBe('8.0MB > 4.0MB cap');
  });

  it('ignores groups with no provider state dir, stray files, and a missing root', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'ag-claude-only', 'sess-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'not-a-group.txt'), 'x');

    expect(sweepProviderStateFiles(root)).toEqual([]);
    expect(sweepProviderStateFiles(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('sweeps every group on one tick', () => {
    const root = makeRoot();
    writeSized(codexLog(root, 'ag-a'), 31 * 1024 ** 3);
    writeSized(codexLog(root, 'ag-b'), 4 * 1024 * 1024);
    writeSized(codexLog(root, 'ag-c'), 9 * 1024 ** 3);

    const rotated = sweepProviderStateFiles(root);

    expect(rotated.map((r) => r.agentGroupId).sort()).toEqual(['ag-a', 'ag-c']);
  });
});
