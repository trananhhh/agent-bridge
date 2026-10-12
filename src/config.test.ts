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
      routing: { recentHours: 48, recentLimit: 8, activeWindowMin: 10, classifierModel: 'haiku', answerModel: 'opus' },
    });
  });

  it('accepts an optional Telegram mirror target', () => {
    expect(parseConfig({ name: 'anh', listenHost: '100.1.2.3' }).telegram).toBeUndefined();
    expect(parseConfig({ name: 'anh', listenHost: '100.1.2.3', telegram: { botToken: '1:x', chatId: -1001, chatTitle: 'log' } }).telegram).toEqual({
      botToken: '1:x',
      chatId: -1001,
      chatTitle: 'log',
      owners: [],
    });
    expect(() => parseConfig({ name: 'anh', listenHost: '100.1.2.3', telegram: { chatId: -1001 } })).toThrow();
  });

  it('takes the answering model and effort, and who may answer from Telegram', () => {
    const cfg = parseConfig({
      name: 'anh',
      listenHost: '100.1.2.3',
      routing: { answerModel: 'sonnet', answerEffort: 'xhigh' },
      telegram: { botToken: '1:x', chatId: -1001, owners: [{ id: 42, name: 'Anh' }] },
    });
    expect(cfg.routing).toMatchObject({ answerModel: 'sonnet', answerEffort: 'xhigh', classifierModel: 'haiku' });
    expect(cfg.telegram?.owners).toEqual([{ id: 42, name: 'Anh' }]);
    expect(() => parseConfig({ name: 'anh', listenHost: '100.1.2.3', routing: { answerEffort: 'extreme' } })).toThrow();
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
