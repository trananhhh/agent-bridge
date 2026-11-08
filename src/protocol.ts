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

/**
 * How agents write to each other. The reader is another model, not a person, so we
 * optimise for tokens and unambiguity: shared IDs instead of retelling, deltas instead
 * of full state. Humans get their own summary from their own agent.
 */
export const AGENT_STYLE =
  'Agent-to-agent register: the reader is another Claude, not a person. Write dense and terse: ' +
  'no greetings, apologies, recaps or explanations aimed at humans; key: value lines, ids, numbers, deltas. ' +
  'If the shared folders hold a decision register or status file both sides use, cite its ids and only send what changed ' +
  '(and update it, or say what the owner must update), instead of restating settled points. ' +
  'Self-contained still means: everything the other agent needs to act, nothing it already has.';
