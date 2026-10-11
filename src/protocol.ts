import { z } from 'zod';

export const PeerMessageSchema = z.object({
  id: z.string().min(1).max(100),
  thread_id: z.string().min(1).max(100),
  from: z.string().min(1).max(50),
  kind: z.enum(['ask', 'reply']),
  text: z.string().min(1).max(32_000),
  sent_at: z.string().max(40),
  /** Telegram chat the sender mirrors this message to, so the receiver does not post it a second time. */
  mirror: z.string().max(100).optional(),
});

export type PeerMessage = z.infer<typeof PeerMessageSchema>;
export type MessageKind = PeerMessage['kind'];

const UUID_LEN = 36;
/** Thread ids are "<asker>-<uuid>"; "<asker>-<first 8 of uuid>" is short and still a unique prefix. */
export const shortThreadId = (id: string) => (id.length > UUID_LEN ? id.slice(0, id.length - UUID_LEN + 8) : id);

export interface ThreadRecord {
  thread_id: string;
  origin?: 'local' | 'remote';
  peer?: string;
  conn_id?: string;
  cwd?: string;
  session_id?: string;
}
