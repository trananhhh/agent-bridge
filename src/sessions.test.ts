import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin, listRecentSessions } from './sessions.ts';

const line = (o: unknown) => (typeof o === 'string' ? o : JSON.stringify(o));
const uuid = (tag: string) => `00000000-0000-4000-8000-${tag.padStart(12, '0')}`;

describe('isWithin', () => {
  it('matches the dir itself and children, not siblings with a shared prefix', () => {
    expect(isWithin('/a/proj', ['/a/proj'])).toBe(true);
    expect(isWithin('/a/proj/sub', ['/a/proj'])).toBe(true);
    expect(isWithin('/a/project-x', ['/a/proj'])).toBe(false);
    expect(isWithin(undefined, ['/a/proj'])).toBe(false);
  });
});

describe('listRecentSessions', () => {
  let root: string;
  const now = Date.parse('2026-10-10T12:00:00Z');

  const writeSession = (project: string, id: string, lines: unknown[], mtime: number) => {
    const dir = join(root, project);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, lines.map(line).join('\n') + '\n');
    utimesSync(file, mtime / 1000, mtime / 1000);
  };
  const user = (cwd: string, content: unknown) => ({ type: 'user', cwd, message: { role: 'user', content } });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bridge-sessions-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('scans every project, keeps only allowed cwds, newest first, with title/prompts/cwd', () => {
    writeSession(
      '-w-shop',
      uuid('aaa'),
      [
        user('/w/shop', 'Reconcile KHANHHOANG bills'),
        'not json',
        { type: 'custom-title', customTitle: 'Bill reconciliation' },
        user('/w/shop', [{ type: 'text', text: 'recheck September' }]),
        user('/w/shop', [{ type: 'tool_result', content: 'x' }]),
      ],
      now - 60_000,
    );
    writeSession('-w-shop', uuid('bbb'), [user('/w/shop/apps/api', 'pricing import')], now - 30_000);
    writeSession('-w-private', uuid('ccc'), [user('/w/private', 'secret stuff')], now - 10_000);
    writeSession('-w-shop', uuid('eee'), [user('/w/shop', 'ancient')], now - 72 * 3600_000);
    writeFileSync(join(root, '-w-shop', 'notes.txt'), 'ignore');

    const sessions = listRecentSessions(root, { now, sinceHours: 48, limit: 10, allowedDirs: ['/w/shop'] });
    expect(sessions.map((s) => s.sessionId)).toEqual([uuid('bbb'), uuid('aaa')]);
    expect(sessions[0].cwd).toBe('/w/shop/apps/api');
    expect(sessions[1]).toMatchObject({
      cwd: '/w/shop',
      title: 'Bill reconciliation',
      firstPrompt: 'Reconcile KHANHHOANG bills',
      lastPrompt: 'recheck September',
    });
  });

  it('returns [] when the projects root does not exist', () => {
    expect(listRecentSessions(join(root, 'nope'), { now, sinceHours: 48, limit: 5, allowedDirs: ['/'] })).toEqual([]);
  });

  it('applies the limit after filtering', () => {
    for (let i = 0; i < 5; i++) writeSession('-p', uuid(`${i}`), [user(i % 2 ? '/other' : '/p', `p${i}`)], now - i * 1000);
    expect(listRecentSessions(root, { now, sinceHours: 48, limit: 2, allowedDirs: ['/p'] }).map((s) => s.sessionId)).toEqual([
      uuid('0'),
      uuid('2'),
    ]);
  });

  it('skips copies of sessions that run on another machine over SSH (desktop app ssh-* projects)', () => {
    writeSession(`ssh-${uuid('fff')}`, uuid('fff'), [user('/w/shop', 'remote session copy')], now - 1_000);
    writeSession('-w-shop', uuid('ddd'), [user('/w/shop', 'local session')], now - 2_000);
    expect(listRecentSessions(root, { now, sinceHours: 48, limit: 10, allowedDirs: ['/w/shop'] }).map((s) => s.sessionId)).toEqual([
      uuid('ddd'),
    ]);
  });

  it('skips transcripts that cannot be resumed by id (subagent agent-*.jsonl and other non-UUID names)', () => {
    writeSession('-w-shop', 'agent-a4facc464943ead88', [user('/w/shop', 'subagent work')], now - 1_000);
    writeSession('-w-shop', 'scratch', [user('/w/shop', 'not a session')], now - 2_000);
    writeSession('-w-shop', uuid('ddd'), [user('/w/shop', 'real session')], now - 3_000);
    expect(listRecentSessions(root, { now, sinceHours: 48, limit: 10, allowedDirs: ['/w/shop'] }).map((s) => s.sessionId)).toEqual([
      uuid('ddd'),
    ]);
  });
});
