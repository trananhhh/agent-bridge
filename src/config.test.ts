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
      autoUpdate: true,
      routing: { recentHours: 48, recentLimit: 8, activeWindowMin: 10, classifierModel: 'haiku', answerModel: 'opus' },
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

  it('accepts per-peer Telegram chats keyed by peer name', () => {
    const base = { name: 'anh', listenHost: '100.1.2.3' };
    const telegram = { botToken: '1:x', chatId: -1001, peerChats: { silver: { chatId: -2002, chatTitle: 'Silver' }, 'cu-2': { chatId: '@room' } } };
    expect(parseConfig({ ...base, telegram }).telegram?.peerChats).toEqual(telegram.peerChats);
    expect(parseConfig({ ...base, telegram: { botToken: '1:x', chatId: 1 } }).telegram?.peerChats).toBeUndefined();
    expect(() => parseConfig({ ...base, telegram: { ...telegram, peerChats: { 'Bad Name': { chatId: 1 } } } })).toThrow();
    expect(() => parseConfig({ ...base, telegram: { ...telegram, peerChats: { silver: {} } } })).toThrow();
  });

  it('takes the answering model and effort, and the machine that reads a shared bot', () => {
    const cfg = parseConfig({
      name: 'anh',
      listenHost: '100.1.2.3',
      routing: { answerModel: 'sonnet', answerEffort: 'xhigh' },
      telegram: { botToken: '1:x', chatId: -1001, hub: 'mac-16' },
    });
    expect(cfg.routing).toMatchObject({ answerModel: 'sonnet', answerEffort: 'xhigh', classifierModel: 'haiku' });
    expect(cfg.telegram?.hub).toBe('mac-16');
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
