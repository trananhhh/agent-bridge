import { z } from 'zod';
export const PeerMessageSchema = z.object({
    id: z.string().min(1).max(100),
    thread_id: z.string().min(1).max(100),
    from: z.string().min(1).max(50),
    kind: z.enum(['ask', 'reply']),
    text: z.string().min(1).max(32_000),
    sent_at: z.string().max(40),
});
