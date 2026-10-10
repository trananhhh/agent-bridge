import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readRawConfig } from './config.ts';
import { PeerMessageSchema, type PeerMessage } from './protocol.ts';
import { SseParser } from './sse.ts';

const MAX_WAIT_S = 300;

export async function runChannel(): Promise<void> {
  let peerNames: string[] = [];
  let localPort = 8791;
  let configError: string | undefined;
  try {
    const raw = readRawConfig();
    peerNames = (raw.peers ?? []).map((p) => p.name);
    localPort = raw.localPort ?? 8791;
  } catch (err) {
    configError = (err as Error).message;
  }

  const localUrl = process.env.BRIDGE_LOCAL_URL ?? `http://127.0.0.1:${localPort}`;
  const isLive = process.env.BRIDGE_LIVE === '1';
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || undefined;
  const cwd = process.cwd();
  const connId = randomUUID();

  const log = (event: string, data: Record<string, unknown> = {}) =>
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event, conn: connId, ...data })}\n`);

  const peersLine = peerNames.length ? `Peers: ${peerNames.join(', ')}.` : 'Chưa cấu hình peer nào (agent-bridge add-peer).';
  const instructions = `agent-bridge nối bạn với bot Claude Code của đồng nghiệp trên máy khác. ${peersLine}
Tools: ask_peer (hỏi bot bên kia), reply (trả lời một thread), peer_inbox (lấy câu trả lời đang chờ).
${
  isLive
    ? `Phiên này ở chế độ LIVE: tin đến tự xuất hiện dạng <channel source="agent-bridge" from="..." thread_id="..." kind="ask|reply">.
- kind="ask": đồng nghiệp hỏi. Tra cứu rồi gọi reply với đúng thread_id. Thao tác ghi (sửa file, ghi DB, deploy, gửi tin ra ngoài) vẫn phải hỏi chủ máy trước.
- kind="reply": câu trả lời cho ask_peer trước đó của bạn — dùng nó để tiếp tục việc đang làm.`
    : 'Phiên này KHÔNG ở chế độ live (không nhận push). Sau ask_peer, gọi peer_inbox với thread_id và wait_seconds để chờ câu trả lời.'
}
Khi hỏi: viết câu hỏi tự đủ ngữ cảnh (bên kia không thấy cuộc hội thoại của bạn), nêu rõ cần gì.`;

  const mcp = new Server(
    { name: 'agent-bridge', version: '0.1.0' },
    { capabilities: { experimental: { 'claude/channel': {} }, tools: {} }, instructions },
  );

  async function local<T>(path: string, init?: RequestInit): Promise<T> {
    if (configError) throw new Error(configError);
    let res: Response;
    try {
      res = await fetch(`${localUrl}${path}`, init);
    } catch {
      throw new Error(`agent-bridge daemon không chạy ở ${localUrl}. Chạy: agent-bridge daemon (hoặc agent-bridge install-service)`);
    }
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `daemon responded ${res.status}`);
    return body;
  }

  const sendLocal = (payload: Record<string, unknown>) =>
    local<{ id: string; thread_id: string; to: string; status: 'sent' | 'queued' }>('/local/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, conn_id: connId, session_id: sessionId, cwd }),
    });

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'ask_peer',
        description: `Gửi câu hỏi/yêu cầu sang bot Claude Code của đồng nghiệp. ${peersLine} Trả về thread_id; truyền thread_id cũ để hỏi tiếp cùng mạch.`,
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Nội dung tự đủ ngữ cảnh' },
            to: { type: 'string', ...(peerNames.length && { enum: peerNames }), description: 'Tên peer. Bỏ trống nếu chỉ có 1 peer hoặc đang hỏi tiếp thread cũ.' },
            thread_id: { type: 'string', description: 'Thread cũ để hỏi tiếp (tuỳ chọn)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'reply',
        description: 'Trả lời một tin kind="ask" từ bot bên kia, dùng đúng thread_id của tin đó.',
        inputSchema: {
          type: 'object',
          properties: { thread_id: { type: 'string' }, text: { type: 'string' } },
          required: ['thread_id', 'text'],
        },
      },
      {
        name: 'peer_inbox',
        description: 'Lấy các câu trả lời từ bot bên kia chưa đọc. Có thể chờ tối đa wait_seconds cho một thread.',
        inputSchema: {
          type: 'object',
          properties: {
            thread_id: { type: 'string' },
            wait_seconds: { type: 'number', description: `0-${MAX_WAIT_S}, mặc định 0` },
          },
        },
      },
    ],
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
    try {
      switch (req.params.name) {
        case 'ask_peer': {
          const r = await sendLocal({
            kind: 'ask',
            text: String(args.text ?? ''),
            to: args.to ? String(args.to) : undefined,
            thread_id: args.thread_id ? String(args.thread_id) : undefined,
          });
          return text(
            `${r.status === 'sent' ? `Đã gửi tới ${r.to}` : `${r.to} đang offline — đã xếp hàng, sẽ tự gửi lại`} · thread_id=${r.thread_id}` +
              (isLive ? '' : '\nGọi peer_inbox với thread_id này để nhận câu trả lời.'),
          );
        }
        case 'reply': {
          const r = await sendLocal({ kind: 'reply', text: String(args.text ?? ''), thread_id: String(args.thread_id ?? '') });
          return text(`${r.status === 'sent' ? `Đã trả lời ${r.to}` : `Đã xếp hàng (${r.to} offline)`} · thread_id=${r.thread_id}`);
        }
        case 'peer_inbox': {
          const thread = args.thread_id ? String(args.thread_id) : '';
          const deadline = Date.now() + Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_S) * 1000;
          const qs = new URLSearchParams(thread ? { thread } : {});
          for (;;) {
            const { messages } = await local<{ messages: PeerMessage[] }>(`/local/inbox?${qs}`);
            if (messages.length) return text(messages.map((m) => `[${m.kind} từ ${m.from} · thread ${m.thread_id}]\n${m.text}`).join('\n\n'));
            if (Date.now() >= deadline) return text('Chưa có câu trả lời mới.');
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        default:
          throw new Error(`unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      return { ...text(`Lỗi: ${(err as Error).message}`), isError: true };
    }
  });

  async function streamLoop() {
    let backoff = 1000;
    for (;;) {
      try {
        const qs = new URLSearchParams({ conn: connId, cwd, ...(sessionId && { session: sessionId }) });
        const res = await fetch(`${localUrl}/local/stream?${qs}`);
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        backoff = 1000;
        const parser = new SseParser((e) => {
          if (e.event === 'ready') log('live_ready', { session: sessionId });
          if (e.event !== 'message') return;
          const parsed = PeerMessageSchema.safeParse(JSON.parse(e.data));
          if (!parsed.success) return;
          const m = parsed.data;
          mcp
            .notification({
              method: 'notifications/claude/channel',
              params: { content: m.text, meta: { from: m.from, thread_id: m.thread_id, kind: m.kind } },
            })
            .catch((err) => log('push_failed', { error: String(err) }));
        });
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        throw new Error('stream closed');
      } catch (err) {
        log('stream_retry', { error: (err as Error).message, in_ms: backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  await mcp.connect(new StdioServerTransport());
  log('started', { live: isLive, session: sessionId, cwd, local: localUrl, configError });
  if (isLive && !configError) void streamLoop();
}
