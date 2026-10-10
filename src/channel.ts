import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readRawConfig } from './config.ts';
import { z } from 'zod';
import { PeerMessageSchema, type PeerMessage } from './protocol.ts';
import { SseParser } from './sse.ts';

const MAX_WAIT_S = 300;

export async function runChannel(): Promise<void> {
  let localPort = 8791;
  let configError: string | undefined;
  try {
    localPort = readRawConfig().localPort ?? 8791;
  } catch (err) {
    configError = (err as Error).message;
  }

  const localUrl = process.env.BRIDGE_LOCAL_URL ?? `http://127.0.0.1:${localPort}`;
  const isLive = process.env.BRIDGE_LIVE === '1';
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || undefined;
  const cwd = process.cwd();
  const connId = randomUUID();

  let peers: { name: string; remote_folders: string[] }[] = [];
  if (!configError) {
    try {
      const res = await fetch(`${localUrl}/local/peers`, { signal: AbortSignal.timeout(1500) });
      peers = ((await res.json()) as { peers: typeof peers }).peers;
    } catch {
      // daemon down: tools will report it when used
    }
  }

  const log = (event: string, data: Record<string, unknown> = {}) =>
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), event, conn: connId, ...data })}\n`);

  const peerLines = peers.length
    ? peers.map((p) => `- ${p.name}: hỏi được về ${p.remote_folders.map((f) => basename(f)).join(', ') || '(chưa rõ folder)'}`).join('\n')
    : '- (chưa kết nối với ai — người dùng chạy `agent-bridge connect` trong terminal)';
  const instructions = `agent-bridge nối bạn với agent Claude Code của đồng nghiệp trên máy khác. Đã kết nối:
${peerLines}
Khi cần thông tin/xác nhận từ phía một người trong danh sách (về code, dữ liệu, quyết định trong các folder họ chia sẻ), tự dùng ask_peer thay vì bảo người dùng đi hỏi. Viết câu hỏi tự đủ ngữ cảnh (bên kia không thấy cuộc hội thoại này).
Tools: ask_peer (hỏi), reply (trả lời một thread), peer_inbox (lấy câu trả lời đang chờ), list_peers.
${
  isLive
    ? `Phiên LIVE: tin đến tự hiện dạng <channel source="agent-bridge" from="..." thread_id="..." kind="ask|reply" folders="...">.
- kind="ask": đồng nghiệp hỏi. CHỈ tra cứu trong các folder ở thuộc tính folders rồi gọi reply với đúng thread_id. Không đọc/tiết lộ gì ngoài các folder đó. Thao tác ghi phải hỏi chủ máy trước.
- kind="reply": câu trả lời cho ask_peer trước đó của bạn — dùng nó để tiếp tục việc đang làm.`
    : 'Phiên này không nhận push: sau ask_peer, gọi peer_inbox với thread_id và wait_seconds (vd 120) để chờ câu trả lời.'
}`;

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
      throw new Error(`agent-bridge daemon không chạy ở ${localUrl}. Chạy trong terminal: agent-bridge setup`);
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
        description: 'Gửi câu hỏi/yêu cầu sang bot Claude Code của đồng nghiệp. Trả về thread_id; truyền thread_id cũ để hỏi tiếp cùng mạch.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Nội dung tự đủ ngữ cảnh' },
            to: { type: 'string', description: 'Tên peer (xem list_peers). Bỏ trống nếu chỉ có 1 peer hoặc đang hỏi tiếp thread cũ.' },
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
      {
        name: 'list_peers',
        description: 'Liệt kê người đã kết nối: mình hỏi được họ về folder nào, họ đọc được folder nào của mình.',
        inputSchema: { type: 'object', properties: {} },
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
        case 'list_peers': {
          const r = await local<{ peers: { name: string; folders: string[]; remote_folders: string[] }[] }>('/local/peers');
          return text(
            r.peers.length
              ? r.peers.map((p) => `- ${p.name}: hỏi được về ${p.remote_folders.join(', ') || '?'} · họ đọc được của mình: ${p.folders.join(', ')}`).join('\n')
              : 'Chưa kết nối với ai (người dùng chạy `agent-bridge connect`).',
          );
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
          const raw = JSON.parse(e.data) as unknown;
          const parsed = PeerMessageSchema.extend({ folders: z.array(z.string()).optional() }).safeParse(raw);
          if (!parsed.success) return;
          const m = parsed.data;
          mcp
            .notification({
              method: 'notifications/claude/channel',
              params: {
                content: m.text,
                meta: { from: m.from, thread_id: m.thread_id, kind: m.kind, ...(m.folders && { folders: m.folders.join(', ') }) },
              },
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
