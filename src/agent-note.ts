import { basename } from 'node:path';

const describeFolders = (folders: string[]) => folders.map((f) => `${basename(f)} (${f})`).join(', ') || '(chưa có)';

/** Text the user pastes into their Claude Code so it remembers how to use this connection. */
export function buildAgentNote(opts: { peer: string; identity?: string; theirFolders: string[]; myFolders: string[] }): string {
  const who = opts.identity ? `${opts.peer} (${opts.identity})` : opts.peer;
  return [
    'Hãy lưu vào memory (áp dụng cho mọi project) những điều sau:',
    `- Tôi đã kết nối agent-bridge với ${who}. Agent Claude Code của ${opts.peer} trả lời được câu hỏi về các folder/repo trên máy họ: ${describeFolders(opts.theirFolders)}.`,
    `- Khi cần thông tin hoặc xác nhận từ phía ${opts.peer} (code, dữ liệu, quyết định liên quan các folder đó), đừng bảo tôi đi hỏi — hãy dùng tool \`ask_peer\` của MCP server agent-bridge với to="${opts.peer}", viết câu hỏi tự đủ ngữ cảnh (họ không thấy cuộc hội thoại của mình). Nếu câu trả lời không tự hiện ra, gọi \`peer_inbox\` với thread_id và wait_seconds=120.`,
    `- Agent của ${opts.peer} chỉ đọc được, không sửa gì trên máy họ; việc cần ghi bên đó thì nhờ ${opts.peer} tự làm.`,
    `- Ngược lại, agent của ${opts.peer} có thể hỏi bạn về: ${describeFolders(opts.myFolders)}. Khi nhận tin kind="ask" từ họ, chỉ trả lời dựa trên các folder đó và dùng tool \`reply\`; việc cần ghi phải hỏi tôi trước.`,
  ].join('\n');
}
