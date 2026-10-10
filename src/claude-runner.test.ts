import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, parseClaudeJson } from './claude-runner.ts';

describe('buildClaudeArgs', () => {
  it('locks a peer session to read-only tools inside the shared folders', () => {
    expect(buildClaudeArgs({ readOnlyDirs: ['/w/a', '/w/b'], appendSystemPrompt: 'be brief' })).toEqual([
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--restricted',
      '--strict-mcp-config',
      '--tools',
      'Read,Grep,Glob,WebSearch',
      '--allowedTools',
      'Read,Grep,Glob,WebSearch',
      '--disallowedTools',
      'Edit,Write,NotebookEdit',
      '--add-dir',
      '/w/a',
      '--add-dir',
      '/w/b',
      '--append-system-prompt',
      'be brief',
    ]);
  });

  it('resumes/forks and runs the classifier with no tools at all', () => {
    expect(buildClaudeArgs({ resumeSessionId: 's1', fork: true, model: 'haiku', noTools: true })).toEqual([
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--restricted',
      '--strict-mcp-config',
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
