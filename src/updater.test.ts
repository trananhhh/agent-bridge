import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeStore } from './store.ts';
import { createUpdater, isNewer } from './updater.ts';

describe('isNewer', () => {
  it('compares dotted versions numerically', () => {
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('0.8.0', '0.8.0')).toBe(false);
    expect(isNewer('0.7.1', '0.8.0')).toBe(false);
    expect(isNewer('1.0', '0.99.99')).toBe(true);
  });
});

describe('updater', () => {
  let dir: string;
  let store: BridgeStore;
  let said: string[];
  let installs: number;
  let restarts: number;
  let latest: string | Error;
  let installed: string[];
  let installError: Error | undefined;
  let peerVersions: Record<string, string | undefined>;

  const updater = (over: { current?: string; manual?: string } = {}) =>
    createUpdater({
      name: 'anh',
      current: over.current ?? '0.8.0',
      manualBecause: over.manual,
      store,
      fetchLatest: async () => {
        if (latest instanceof Error) throw latest;
        return { version: latest, ref: `sha-${latest}` };
      },
      install: async (ref) => {
        installs++;
        installed.push(ref);
        if (installError) throw installError;
      },
      restart: async () => void restarts++,
      peers: () => Object.keys(peerVersions).map((name) => ({ name, url: `http://${name}.test` })),
      peerVersion: async (url) => peerVersions[new URL(url).hostname.replace(/\.test$/, '')],
      announce: async (text) => void said.push(text),
      log: () => {},
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-updater-'));
    store = new BridgeStore(join(dir, 'bridge.db'));
    said = [];
    installs = 0;
    restarts = 0;
    latest = '0.8.0';
    installError = undefined;
    installed = [];
    peerVersions = {};
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('installs exactly the release it checked and restarts, then says so once running it', async () => {
    latest = '0.8.1';
    await updater().check();
    expect([installs, restarts]).toEqual([1, 1]);
    expect(installed).toEqual(['sha-0.8.1']);
    expect(said).toEqual([]);
    await updater({ current: '0.8.1' }).announceRestart();
    await updater({ current: '0.8.1' }).announceRestart();
    expect(said).toEqual(['⬆️ anh updated agent-bridge 0.8.0 → 0.8.1']);
  });

  it('never restarts in a loop when installing does not change the running version', async () => {
    latest = '0.8.1';
    await updater().check();
    await updater().check();
    await updater().check();
    expect([installs, restarts]).toEqual([2, 2]);
    expect(said).toEqual([expect.stringMatching(/^⚠️ anh could not update agent-bridge to 0\.8\.1: it still runs 0\.8\.0 after installing/)]);
    installError = new Error('EACCES');
    await updater().check();
    expect(said).toHaveLength(1);
  });

  it('does nothing when already up to date, or when the release cannot be read', async () => {
    await updater().check();
    latest = new Error('offline');
    await updater().check();
    expect([installs, restarts, said]).toEqual([0, 0, []]);
  });

  it('reports a failed install once per release and keeps running', async () => {
    latest = '0.8.1';
    installError = new Error('EACCES');
    const u = updater();
    await u.check();
    await u.check();
    expect([installs, restarts]).toEqual([2, 0]);
    expect(said).toEqual(['⚠️ anh could not update agent-bridge to 0.8.1: EACCES']);
  });

  it('when it may not update itself, only says once that a release is out, and why', async () => {
    latest = '0.8.1';
    const u = updater({ manual: 'auto-update is off' });
    await u.check();
    await u.check();
    expect(installs).toBe(0);
    expect(said).toEqual([expect.stringMatching(/^ℹ️ agent-bridge 0\.8\.1 is out; anh runs 0\.8\.0 \(auto-update is off\)/)]);
  });

  it('points out once per release when a connected machine runs an older version, and how it gets updated', async () => {
    latest = '0.8.0';
    peerVersions = { cu: '0.6.3', minh: '0.8.0', zed: undefined, lan: '0.8.0-dev' };
    await updater().check();
    await updater().check();
    expect(said).toEqual([
      expect.stringMatching(/^ℹ️ cu runs agent-bridge 0\.6\.3; 0\.8\.0 is out\. It cannot update itself yet: .*npm install -g --prefer-online .*agent-bridge setup --name cu/),
    ]);
    peerVersions.cu = '0.8.0';
    latest = '0.8.1';
    peerVersions.minh = '0.8.0';
    installError = new Error('x');
    await updater().check();
    expect(said.slice(1)).toEqual([
      expect.stringMatching(/could not update/),
      expect.stringMatching(/^ℹ️ cu runs agent-bridge 0\.8\.0; 0\.8\.1 is out\. It updates itself within a few hours\.$/),
      expect.stringMatching(/^ℹ️ minh runs/),
      expect.stringMatching(/^ℹ️ lan runs agent-bridge 0\.8\.0-dev/),
    ]);
  });
});
