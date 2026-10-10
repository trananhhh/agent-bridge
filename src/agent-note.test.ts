import { describe, expect, it } from 'vitest';
import { buildAgentNote } from './agent-note.ts';

describe('buildAgentNote', () => {
  it('tells the agent who it can ask, about what, with which tools, and what it shares back', () => {
    const note = buildAgentNote({
      peer: 'cu',
      identity: 'cu@gmail.com',
      theirFolders: ['/Users/cu/Coding/trananhpremium'],
      myFolders: ['/Users/anh/Coding/shop'],
    });
    expect(note).toContain('memory');
    expect(note).toContain('cu (cu@gmail.com)');
    expect(note).toContain('trananhpremium (/Users/cu/Coding/trananhpremium)');
    expect(note).toContain('ask_peer');
    expect(note).toContain('to="cu"');
    expect(note).toContain('peer_inbox');
    expect(note).toContain('shop (/Users/anh/Coding/shop)');
  });
});
