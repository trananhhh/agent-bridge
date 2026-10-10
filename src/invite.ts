import { z } from 'zod';

const PREFIX = 'ab1_';

const InviteSchema = z.object({
  name: z.string().min(1).max(50),
  url: z.url(),
  secret: z.string().regex(/^[a-f0-9]{64}$/),
});

export type Invite = z.infer<typeof InviteSchema>;

export function encodeInvite(inv: Invite): string {
  return PREFIX + Buffer.from(JSON.stringify(inv)).toString('base64url');
}

export function decodeInvite(code: string): Invite {
  const trimmed = code.trim();
  try {
    if (!trimmed.startsWith(PREFIX)) throw new Error('prefix');
    return InviteSchema.parse(JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')));
  } catch {
    throw new Error('mã mời không hợp lệ (phải bắt đầu bằng ab1_ và được copy đầy đủ)');
  }
}
