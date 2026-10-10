import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite } from './invite.ts';

describe('invite codes', () => {
  it('round-trips', () => {
    const inv = { name: 'anh', url: 'http://100.1.2.3:8790', secret: 'a'.repeat(64) };
    const code = encodeInvite(inv);
    expect(code).toMatch(/^ab1_[A-Za-z0-9_-]+$/);
    expect(decodeInvite(`  ${code}\n`)).toEqual(inv);
  });

  it('rejects garbage with a readable error', () => {
    expect(() => decodeInvite('hello')).toThrow(/mã mời/);
    expect(() => decodeInvite('ab1_' + Buffer.from('{"name":"x"}').toString('base64url'))).toThrow(/mã mời/);
  });
});
