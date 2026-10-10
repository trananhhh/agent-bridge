export function routeInbound(msg, thread, liveConnIds) {
    const liveOwner = thread?.conn_id && liveConnIds.has(thread.conn_id) ? thread.conn_id : undefined;
    if (msg.kind === 'reply')
        return liveOwner ? { type: 'deliver-live', connId: liveOwner } : { type: 'inbox' };
    if (liveOwner)
        return { type: 'deliver-live', connId: liveOwner };
    if (thread?.session_id)
        return { type: 'resume', sessionId: thread.session_id, cwd: thread.cwd };
    return { type: 'classify' };
}
export function buildClassifierPrompt(question, candidates) {
    const list = candidates
        .map((c) => [
        `- id: ${c.sessionId}`,
        `  đang mở: ${c.live ? 'có' : 'không'}`,
        c.cwd && `  thư mục: ${c.cwd}`,
        c.title && `  tiêu đề: ${c.title}`,
        c.firstPrompt && `  yêu cầu đầu: ${c.firstPrompt}`,
        c.lastPrompt && `  yêu cầu gần nhất: ${c.lastPrompt}`,
    ]
        .filter(Boolean)
        .join('\n'))
        .join('\n');
    return [
        'Bạn là bộ định tuyến tin nhắn. Bot đồng nghiệp gửi câu hỏi dưới đây.',
        'Chọn MỘT phiên làm việc gần đây có ngữ cảnh liên quan TRỰC TIẾP để trả lời câu hỏi (cùng chủ đề, cùng feature/bug/dữ liệu).',
        'Nếu không phiên nào liên quan rõ ràng, trả về null — một phiên mới sẽ được tạo.',
        'Chỉ trả về JSON một dòng: {"session_id": "<id>"} hoặc {"session_id": null}. Không giải thích.',
        '',
        'Câu hỏi:',
        '<<<',
        question.slice(0, 2000),
        '>>>',
        '',
        'Các phiên:',
        list,
    ].join('\n');
}
export function parseClassifierOutput(output, validIds) {
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    if (start === -1 || end <= start)
        return null;
    try {
        const parsed = JSON.parse(output.slice(start, end + 1));
        return typeof parsed.session_id === 'string' && validIds.includes(parsed.session_id) ? parsed.session_id : null;
    }
    catch {
        return null;
    }
}
export function resolveTarget(choice, lives) {
    if (!choice)
        return { type: 'new' };
    const live = lives.find((l) => l.sessionId === choice);
    return live ? { type: 'deliver-live', connId: live.connId } : { type: 'resume', sessionId: choice };
}
