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
        `  open now: ${c.live ? 'yes' : 'no'}`,
        c.cwd && `  folder: ${c.cwd}`,
        c.title && `  title: ${c.title}`,
        c.firstPrompt && `  first request: ${c.firstPrompt}`,
        c.lastPrompt && `  latest request: ${c.lastPrompt}`,
    ]
        .filter(Boolean)
        .join('\n'))
        .join('\n');
    return [
        'You are a message router. A colleague\'s agent sent the question below.',
        'Pick ONE recent session whose context is DIRECTLY relevant to answering it (same topic, feature, bug or data).',
        'If none is clearly relevant, return null — a new session will be started.',
        'Reply with one line of JSON only: {"session_id": "<id>"} or {"session_id": null}. No explanation.',
        '',
        'Question:',
        '<<<',
        question.slice(0, 2000),
        '>>>',
        '',
        'Sessions:',
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
