import { basename } from 'node:path';
const describeFolders = (folders) => folders.map((f) => `${basename(f)} (${f})`).join(', ') || '(none)';
/** Text the user pastes into their Claude Code so it remembers how to use this connection. */
export function buildAgentNote(opts) {
    const who = opts.identity ? `${opts.peer} (${opts.identity})` : opts.peer;
    return [
        'Save the following to your memory (applies to every project):',
        `- I am connected via agent-bridge to ${who}. ${opts.peer}'s Claude Code agent can answer questions about these folders/repos on their machine: ${describeFolders(opts.theirFolders)}.`,
        `- When you need information or confirmation from ${opts.peer}'s side (code, data, decisions about those folders), don't ask me to go ask them — use the \`ask_peer\` tool of the agent-bridge MCP server with to="${opts.peer}", and write a self-contained question (they can't see our conversation). If the answer doesn't show up on its own, call \`peer_inbox\` with the thread_id and wait_seconds=120.`,
        `- ${opts.peer}'s agent can only read; it never changes anything on their machine. Anything that needs writing on their side, ${opts.peer} does themselves.`,
        `- In return, ${opts.peer}'s agent can ask you about: ${describeFolders(opts.myFolders)}. When a kind="ask" message arrives from them, answer only from those folders and use the \`reply\` tool; ask me before writing anything.`,
    ].join('\n');
}
