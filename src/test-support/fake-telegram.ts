/** In-memory Telegram Bot API: records every call; answers OK unless a response was queued. */
interface Sent {
  method: string;
  body: Record<string, unknown>;
}

export function fakeTelegram() {
  const sent: Sent[] = [];
  const queue: { status: number; body: unknown }[] = [];
  let messageId = 100;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').pop()!;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    const next = queue.shift() ?? { status: 200, body: { ok: true, result: method === 'sendMessage' ? { message_id: ++messageId } : method === 'getUpdates' ? [] : true } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  const fail = (status: number, description: string, retry_after?: number) =>
    queue.push({ status, body: { ok: false, description, parameters: retry_after ? { retry_after } : undefined } });
  const respond = (result: unknown) => queue.push({ status: 200, body: { ok: true, result } });
  return { sent, fetchImpl, fail, respond };
}
