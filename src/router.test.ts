import { describe, expect, it } from 'vitest';
import { buildClassifierPrompt, parseClassifierOutput, resolveTarget, routeInbound } from './router.ts';
import type { PeerMessage } from './protocol.ts';

const ask = (over: Partial<PeerMessage> = {}): PeerMessage => ({
  id: 'm1',
  thread_id: 't1',
  from: 'cu',
  kind: 'ask',
  text: 'does the orders table have a provider_id column?',
  sent_at: '2026-10-10T00:00:00Z',
  ...over,
});

describe('routeInbound', () => {
  const live = new Set(['c-live']);

  it('delivers a reply to the live session that asked', () => {
    expect(routeInbound(ask({ kind: 'reply' }), { thread_id: 't1', origin: 'local', conn_id: 'c-live' }, live)).toEqual({
      type: 'deliver-live',
      connId: 'c-live',
    });
  });

  it('parks a reply in the inbox when the asking session is gone', () => {
    expect(routeInbound(ask({ kind: 'reply' }), { thread_id: 't1', origin: 'local', conn_id: 'c-dead' }, live)).toEqual({
      type: 'inbox',
    });
    expect(routeInbound(ask({ kind: 'reply' }), undefined, live)).toEqual({ type: 'inbox' });
  });

  it('keeps a follow-up ask in the live session that handled the thread', () => {
    expect(routeInbound(ask(), { thread_id: 't1', origin: 'remote', conn_id: 'c-live', session_id: 's1' }, live)).toEqual({
      type: 'deliver-live',
      connId: 'c-live',
    });
  });

  it('resumes the headless session that handled the thread when no live session owns it', () => {
    expect(routeInbound(ask(), { thread_id: 't1', origin: 'remote', conn_id: 'c-dead', session_id: 's1', cwd: '/w' }, live)).toEqual({
      type: 'resume',
      sessionId: 's1',
      cwd: '/w',
    });
  });

  it('classifies a brand-new ask', () => {
    expect(routeInbound(ask(), undefined, live)).toEqual({ type: 'classify' });
  });
});

describe('classifier', () => {
  const candidates = [
    { sessionId: 's-bill', cwd: '/w/shop', title: 'Bill reconciliation', firstPrompt: 'check bill', lastPrompt: 'September', mtimeMs: 2, live: false },
    { sessionId: 's-live', title: 'Telegram bot /donhang', firstPrompt: 'fix label', mtimeMs: 3, live: true },
  ];

  it('lists every candidate id in the prompt', () => {
    const prompt = buildClassifierPrompt('the question', candidates);
    expect(prompt).toContain('s-bill');
    expect(prompt).toContain('s-live');
    expect(prompt).toContain('the question');
    expect(prompt).toContain('/w/shop');
  });

  it('parses a valid choice, tolerating fences and prose', () => {
    const ids = candidates.map((c) => c.sessionId);
    expect(parseClassifierOutput('```json\n{"session_id":"s-bill"}\n```', ids)).toBe('s-bill');
    expect(parseClassifierOutput('Sure: {"session_id": null}', ids)).toBeNull();
    expect(parseClassifierOutput('{"session_id":"invented"}', ids)).toBeNull();
    expect(parseClassifierOutput('garbage', ids)).toBeNull();
  });

  it('resolves the choice to live delivery, resume, or a new session', () => {
    const lives = [{ connId: 'c1', sessionId: 's-live' }];
    expect(resolveTarget('s-live', lives)).toEqual({ type: 'deliver-live', connId: 'c1' });
    expect(resolveTarget('s-bill', lives)).toEqual({ type: 'resume', sessionId: 's-bill' });
    expect(resolveTarget(null, lives)).toEqual({ type: 'new' });
  });
});
