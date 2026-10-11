import { describe, expect, it } from 'vitest';
import { expandPath, parseConfig } from './config.ts';

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig({ name: 'anh', listenHost: '100.1.2.3' })).toMatchObject({
      name: 'anh',
      listenHost: '100.1.2.3',
      peerPort: 8790,
      localPort: 8791,
      claudeBin: 'claude',
      headlessTimeoutMs: 900_000,
      routing: { recentHours: 48, recentLimit: 8, activeWindowMin: 10, classifierModel: 'haiku' },
    });
  });

  it('accepts an optional Telegram mirror target', () => {
    expect(parseConfig({ name: 'anh', listenHost: '100.1.2.3' }).telegram).toBeUndefined();
    expect(parseConfig({ name: 'anh', listenHost: '100.1.2.3', telegram: { botToken: '1:x', chatId: -1001, chatTitle: 'log' } }).telegram).toEqual({
      botToken: '1:x',
      chatId: -1001,
      chatTitle: 'log',
    });
    expect(() => parseConfig({ name: 'anh', listenHost: '100.1.2.3', telegram: { chatId: -1001 } })).toThrow();
  });

  it('rejects bad names and a missing listen host', () => {
    expect(() => parseConfig({ name: 'Anh Tran', listenHost: '100.1.2.3' })).toThrow(/name/);
    expect(() => parseConfig({ name: 'anh' })).toThrow(/listenHost/);
  });
});

describe('expandPath', () => {
  it('expands ~ and strips trailing slashes', () => {
    expect(expandPath('~/nope-dir/x/', '/Users/anh')).toBe('/Users/anh/nope-dir/x');
  });
});
