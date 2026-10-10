import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin, listRecentSessions } from './sessions.ts';

const line = (o: unknown) => (typeof o === 'string' ? o : JSON.stringify(o));

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
      'aaa',
      [
        user('/w/shop', 'Đối soát bill KHANHHOANG'),
        'not json',
        { type: 'custom-title', customTitle: 'Đối soát bill' },
        user('/w/shop', [{ type: 'text', text: 'check lại tháng 9' }]),
        user('/w/shop', [{ type: 'tool_result', content: 'x' }]),
      ],
      now - 60_000,
    );
    writeSession('-w-shop', 'bbb', [user('/w/shop/apps/api', 'pricing import')], now - 30_000);
    writeSession('-w-private', 'ccc', [user('/w/private', 'secret stuff')], now - 10_000);
    writeSession('-w-shop', 'old', [user('/w/shop', 'ancient')], now - 72 * 3600_000);
    writeFileSync(join(root, '-w-shop', 'notes.txt'), 'ignore');

    const sessions = listRecentSessions(root, { now, sinceHours: 48, limit: 10, allowedDirs: ['/w/shop'] });
    expect(sessions.map((s) => s.sessionId)).toEqual(['bbb', 'aaa']);
    expect(sessions[0].cwd).toBe('/w/shop/apps/api');
    expect(sessions[1]).toMatchObject({
      cwd: '/w/shop',
      title: 'Đối soát bill',
      firstPrompt: 'Đối soát bill KHANHHOANG',
      lastPrompt: 'check lại tháng 9',
    });
  });

  it('returns [] when the projects root does not exist', () => {
    expect(listRecentSessions(join(root, 'nope'), { now, sinceHours: 48, limit: 5, allowedDirs: ['/'] })).toEqual([]);
  });

  it('applies the limit after filtering', () => {
    for (let i = 0; i < 5; i++) writeSession('-p', `s${i}`, [user(i % 2 ? '/other' : '/p', `p${i}`)], now - i * 1000);
    expect(listRecentSessions(root, { now, sinceHours: 48, limit: 2, allowedDirs: ['/p'] }).map((s) => s.sessionId)).toEqual([
      's0',
      's2',
    ]);
  });
});
