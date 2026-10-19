import { spawnSync } from 'node:child_process';
import { claudeInvocation } from './platform.ts';

/** Runs a command to completion and returns its exit status. */
export type Exec = (cmd: string, args: string[]) => number;

export interface RemoteControl {
  /** Opens the session interactively with Remote Control, replacing any window already open for it. */
  open(s: { sessionId: string; cwd: string; title: string }): void;
  /** Closes the session's window, so a headless run can resume the transcript without a second writer. */
  close(sessionId: string): void;
}

const TMUX_SESSION = 'agent-bridge-rc';
// The window runs under the tmux server's environment, not the daemon's: strip what would make claude think it is nested.
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'BRIDGE_LIVE'];

const defaultExec: Exec = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore' }).status ?? 1;

/**
 * Owner-facing copies of answering sessions: an interactive `claude --resume --remote-control` per session,
 * each in its own window of one detached tmux session. Windows are never closed on idle; the owner closes them.
 */
export function createRemoteControl(opts: { claudeBin: string; exec?: Exec }): RemoteControl {
  const exec = opts.exec ?? defaultExec;
  const windowName = (sessionId: string) => `rc-${sessionId.slice(0, 8)}`;
  const close = (sessionId: string) => {
    exec('tmux', ['kill-window', '-t', `${TMUX_SESSION}:${windowName(sessionId)}`]);
  };
  return {
    close,
    open({ sessionId, cwd, title }) {
      close(sessionId);
      const inv = claudeInvocation(opts.claudeBin);
      const command = ['env', ...STRIPPED_ENV.flatMap((k) => ['-u', k]), inv.command, ...inv.args, '--resume', sessionId, '--remote-control', title];
      const place = ['-n', windowName(sessionId), '-c', cwd, '--', ...command];
      const hasSession = exec('tmux', ['has-session', '-t', TMUX_SESSION]) === 0;
      const status = hasSession
        ? exec('tmux', ['new-window', '-d', '-t', TMUX_SESSION, ...place])
        : exec('tmux', ['new-session', '-d', '-s', TMUX_SESSION, ...place]);
      if (status !== 0) throw new Error(`tmux exited ${status} opening Remote Control for ${sessionId}`);
    },
  };
}
