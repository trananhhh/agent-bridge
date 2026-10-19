import { describe, expect, it } from 'vitest';
import { createRemoteControl, type Exec } from './remote-control.ts';

function fakeExec(existing: { session?: boolean; windows?: string[] } = {}) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'has-session') return existing.session ? 0 : 1;
    if (args[0] === 'kill-window') return existing.windows?.includes(args[2].split(':')[1]) ? 0 : 1;
    return 0;
  };
  return { calls, exec };
}

describe('remote control sessions', () => {
  it('opens the answering session interactively with Remote Control, in its cwd, in a detached tmux window', () => {
    const { calls, exec } = fakeExec();
    createRemoteControl({ claudeBin: '/u/.local/bin/claude', exec }).open({ sessionId: 'abcdef12-3456', cwd: '/w/shared', title: '⇄ cu: schema?' });
    expect(calls).toEqual([
      ['tmux', 'kill-window', '-t', 'agent-bridge-rc:rc-abcdef12'],
      ['tmux', 'has-session', '-t', 'agent-bridge-rc'],
      ['tmux', 'new-session', '-d', '-s', 'agent-bridge-rc', '-n', 'rc-abcdef12', '-c', '/w/shared', '--',
        'env', '-u', 'CLAUDECODE', '-u', 'CLAUDE_CODE_SESSION_ID', '-u', 'CLAUDE_CODE_CHILD_SESSION', '-u', 'CLAUDE_CODE_ENTRYPOINT', '-u', 'BRIDGE_LIVE',
        '/u/.local/bin/claude', '--resume', 'abcdef12-3456', '--remote-control', '⇄ cu: schema?'],
    ]);
  });

  it('adds a window to the existing tmux session, replacing the one already open for that session', () => {
    const { calls, exec } = fakeExec({ session: true, windows: ['rc-abcdef12'] });
    createRemoteControl({ claudeBin: 'claude', exec }).open({ sessionId: 'abcdef12-3456', cwd: '/w', title: 't' });
    expect(calls.map((c) => c[1])).toEqual(['kill-window', 'has-session', 'new-window']);
    expect(calls[2].slice(0, 9)).toEqual(['tmux', 'new-window', '-d', '-t', 'agent-bridge-rc', '-n', 'rc-abcdef12', '-c', '/w']);
  });

  it('close kills only that session window', () => {
    const { calls, exec } = fakeExec({ session: true, windows: ['rc-abcdef12'] });
    createRemoteControl({ claudeBin: 'claude', exec }).close('abcdef12-3456');
    expect(calls).toEqual([['tmux', 'kill-window', '-t', 'agent-bridge-rc:rc-abcdef12']]);
  });
});
