import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.ts';

const token = 'x'.repeat(32);
const base = { name: 'anh', workdirs: ['/Users/anh/Coding/proj/'] };

describe('parseConfig', () => {
  it('applies defaults and normalizes workdirs', () => {
    const cfg = parseConfig(base, '/Users/anh');
    expect(cfg).toMatchObject({
      name: 'anh',
      listenHost: '0.0.0.0',
      peerPort: 8790,
      localPort: 8791,
      workdirs: ['/Users/anh/Coding/proj'],
      peers: [],
      claudeBin: 'claude',
      routing: { recentHours: 48, recentLimit: 8, activeWindowMin: 10, classifierModel: 'haiku' },
    });
    expect(cfg.headless.allowedTools).toContain('Read');
    expect(cfg.headless.allowedTools).not.toContain('Edit');
  });

  it('expands ~ and lets a peer narrow its workdirs, falling back to the global list', () => {
    const cfg = parseConfig(
      {
        ...base,
        workdirs: ['~/Coding/a', '~/Coding/b'],
        peers: [
          { name: 'cu', url: 'http://100.1.2.3:8790', token, workdirs: ['~/Coding/a'] },
          { name: 'minh', url: 'http://100.1.2.4:8790', token: 'y'.repeat(32) },
        ],
      },
      '/Users/anh',
    );
    expect(cfg.peers[0].workdirs).toEqual(['/Users/anh/Coding/a']);
    expect(cfg.peers[1].workdirs).toEqual(['/Users/anh/Coding/a', '/Users/anh/Coding/b']);
  });

  it('rejects duplicate peer names, reused tokens, short tokens and missing workdirs', () => {
    const peer = { name: 'cu', url: 'http://100.1.2.3:8790', token };
    expect(() => parseConfig({ ...base, peers: [peer, peer] }, '/h')).toThrow(/duplicate peer/);
    expect(() => parseConfig({ ...base, peers: [peer, { ...peer, name: 'minh' }] }, '/h')).toThrow(/token reused/);
    expect(() => parseConfig({ ...base, peers: [{ ...peer, token: 'short' }] }, '/h')).toThrow(/token/);
    expect(() => parseConfig({ name: 'anh', workdirs: [] }, '/h')).toThrow(/workdirs/);
  });
});
