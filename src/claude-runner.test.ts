import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, parseClaudeJson } from './claude-runner.ts';

describe('buildClaudeArgs', () => {
  it('builds a locked-down headless invocation (prompt goes via stdin)', () => {
    const args = buildClaudeArgs({ allowedTools: ['Read', 'Bash(git log:*)'], appendSystemPrompt: 'be brief' });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      'Read,Bash(git log:*)',
      '--append-system-prompt',
      'be brief',
    ]);
  });

  it('adds resume, fork, model and disables tools for the classifier', () => {
    expect(buildClaudeArgs({ resumeSessionId: 's1', fork: true, model: 'haiku', noTools: true })).toEqual([
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--resume',
      's1',
      '--fork-session',
      '--model',
      'haiku',
      '--tools=',
    ]);
  });
});

describe('parseClaudeJson', () => {
  it('reads session id and result', () => {
    expect(parseClaudeJson('{"type":"result","is_error":false,"result":"ok","session_id":"abc"}')).toEqual({
      sessionId: 'abc',
      result: 'ok',
      isError: false,
    });
  });

  it('takes the last JSON line when stdout has noise', () => {
    expect(parseClaudeJson('warning\n{"result":"x","session_id":"s","is_error":true}\n').isError).toBe(true);
  });

  it('throws on unparseable output', () => {
    expect(() => parseClaudeJson('boom')).toThrow(/unparseable/);
  });
});
