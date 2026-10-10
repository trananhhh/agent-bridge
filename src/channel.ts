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
    ? peers.map((p) => `- ${p.name}: can answer about ${p.remote_folders.map((f) => basename(f)).join(', ') || '(unknown folders)'}`).join('\n')
    : '- (nobody yet — the user runs `agent-bridge connect` in a terminal)';
  const instructions = `agent-bridge connects you to colleagues' Claude Code agents on other machines. Connected:
${peerLines}
When you need information or confirmation from someone on this list (code, data, decisions in the folders they share), use ask_peer yourself instead of telling the user to go ask. Write self-contained questions (they can't see this conversation).
Tools: ask_peer (ask), reply (answer a thread), peer_inbox (collect waiting answers), list_peers.
${
  isLive
    ? `LIVE session: messages arrive as <channel source="agent-bridge" from="..." thread_id="..." kind="ask|reply" folders="...">.
- kind="ask": a colleague asks. Look things up ONLY inside the folders in the folders attribute, then call reply with the same thread_id. Don't read or reveal anything outside those folders. Ask the owner before any write.
- kind="reply": the answer to your earlier ask_peer — use it to continue your task.`
    : 'This session does not receive pushes: after ask_peer, call peer_inbox with the thread_id and wait_seconds (e.g. 120) to wait for the answer.'
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
      throw new Error(`agent-bridge daemon is not running at ${localUrl}. Run in a terminal: agent-bridge setup`);
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
        description: 'Send a question or request to a colleague\'s Claude Code agent. Returns a thread_id; pass an existing thread_id to follow up in the same thread.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Self-contained message' },
            to: { type: 'string', description: 'Peer name (see list_peers). Omit when there is only one peer or when following up on a thread.' },
            thread_id: { type: 'string', description: 'Existing thread to follow up on (optional)' },
          },
          required: ['text'],
        },
      },
      {
        name: 'reply',
        description: 'Answer a kind="ask" message from a colleague\'s agent, using that message\'s thread_id.',
        inputSchema: {
          type: 'object',
          properties: { thread_id: { type: 'string' }, text: { type: 'string' } },
          required: ['thread_id', 'text'],
        },
      },
      {
        name: 'peer_inbox',
        description: 'Collect unread answers from colleagues\' agents. Optionally wait up to wait_seconds for one thread.',
        inputSchema: {
          type: 'object',
          properties: {
            thread_id: { type: 'string' },
            wait_seconds: { type: 'number', description: `0-${MAX_WAIT_S}, default 0` },
          },
        },
      },
      {
        name: 'list_peers',
        description: 'List connections: which folders you can ask each peer about, and which of yours they can read.',
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
            `${r.status === 'sent' ? `Sent to ${r.to}` : `${r.to} is offline — queued, will retry automatically`} · thread_id=${r.thread_id}` +
              (isLive ? '' : '\nCall peer_inbox with this thread_id to get the answer.'),
          );
        }
        case 'reply': {
          const r = await sendLocal({ kind: 'reply', text: String(args.text ?? ''), thread_id: String(args.thread_id ?? '') });
          return text(`${r.status === 'sent' ? `Replied to ${r.to}` : `Queued (${r.to} offline)`} · thread_id=${r.thread_id}`);
        }
        case 'peer_inbox': {
          const thread = args.thread_id ? String(args.thread_id) : '';
          const deadline = Date.now() + Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_WAIT_S) * 1000;
          const qs = new URLSearchParams(thread ? { thread } : {});
          for (;;) {
            const { messages } = await local<{ messages: PeerMessage[] }>(`/local/inbox?${qs}`);
            if (messages.length) return text(messages.map((m) => `[${m.kind} from ${m.from} · thread ${m.thread_id}]\n${m.text}`).join('\n\n'));
            if (Date.now() >= deadline) return text('No new answers yet.');
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        case 'list_peers': {
          const r = await local<{ peers: { name: string; folders: string[]; remote_folders: string[] }[] }>('/local/peers');
          return text(
            r.peers.length
              ? r.peers.map((p) => `- ${p.name}: you can ask about ${p.remote_folders.join(', ') || '?'} · they can read yours: ${p.folders.join(', ')}`).join('\n')
              : 'Not connected to anyone (the user runs `agent-bridge connect`).',
          );
        }
        default:
          throw new Error(`unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      return { ...text(`Error: ${(err as Error).message}`), isError: true };
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
