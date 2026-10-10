# CLAUDE.md — agent-bridge

User-facing: [README.md](README.md) (human, CLI-only flow). [SETUP.md](SETUP.md) is the same flow for Claude Code — keep both in sync with CLI behaviour.

## Layout

- `src/cli.ts` — single entry (`bin/agent-bridge` → `dist/cli.js`): interactive wizard (`setup`, `connect`, `requests`, …) as thin clients of the daemon's local API, plus `daemon` / `channel`. Prompts read from one shared line queue so piped answers work.
- Connecting: requester's daemon `POST /connect` {request_id, name, url, secret, folders} → target stores a pending request (identity from `tailscale whois` of the remote IP, URL rebuilt from that IP) and notifies → target owner accepts → target `POST /connect/answer` back with the secret → both store the peer; the secret is the pair's bearer token.
- `src/discovery.ts` — `tailscale status --json` → probe `GET /health` (`app: "agent-bridge"`) on every online peer. `src/tailscale.ts` wraps the CLI (PATH or the macOS app bundle).
- `src/agent-note.ts` — the "save to memory" text printed after connecting.
- `src/daemon.ts` — peer HTTP (`/inbox`, `/connect`, `/connect/answer`, `/health`) + local HTTP (`/local/*`, 127.0.0.1 only) + routing + headless runs. Pure wiring is injectable (`runner`, `listSessions`, `fetchImpl`) so `daemon.test.ts` runs several daemons in-process.
- `src/router.ts` — routing decisions (pure). Change routing here, not in `daemon.ts`.
- `src/channel.ts` — MCP stdio server spawned by Claude Code per session. Talks only to the local daemon, never to peers.
- `src/sessions.ts` — reads `~/.claude/projects/*/*.jsonl` (head/tail 256 KB) for routing candidates.
- State: `~/.agent-bridge/config.json` (static: name, Tailscale IP, ports) + `bridge.db` (peers, requests, threads, messages, outbox) + `daemon.log` (`BRIDGE_HOME` overrides; tests and smoke runs must set it).

## Rules

- Source is erasable-only TypeScript with `.ts` import specifiers (`erasableSyntaxOnly`, `verbatimModuleSyntax`); `npm run build` emits `dist/` with specifiers rewritten to `.js`. Node refuses to strip types under `node_modules`, so installs must run `dist/`.
- `dist/` is committed so `npm i -g https://github.com/trananhhh/agent-bridge/tarball/main` needs no build (npm's allow-scripts can block `prepare`). Run `npm run build` before every commit that touches `src/`.
- `channel.ts` stdout is the MCP JSON-RPC stream: never `console.log` there; log to stderr.
- Peer `folders` is the data boundary: every place that picks a session or cwd for a peer's question must filter with `isWithin(cwd, peer.folders)`, and headless runs pass them as `readOnlyDirs` (→ `--restricted --add-dir`).
- Headless runs: `--restricted --strict-mcp-config --tools Read,Grep,Glob,WebSearch --permission-mode dontAsk`. Verified: Read outside folders is denied by the CLI, Write/Bash don't exist. Don't loosen this — it is the product's write-needs-owner guarantee.
- Never declare `claude/channel/permission` — it would let a peer approve tool calls on this machine.
- Tests first (`npm test`); keep the multi-daemon test green.

## Pitfalls

- Custom channels aren't on Anthropic's allowlist during the research preview: live push needs `--dangerously-load-development-channels server:agent-bridge` (`bin/claude-bridge`) and `BRIDGE_LIVE=1`. Without `BRIDGE_LIVE` the channel doesn't subscribe, otherwise the daemon would push into sessions that silently drop notifications.
- `claudeBin` must stay the launcher path (`~/.local/bin/claude`), not its realpath — the auto-updater swaps versioned targets.
- Claude Code records canonical cwds (`/tmp` → `/private/tmp`); `expandPath` realpaths folders to match.
- Tailscale node sharing is one-way (shared nodes are quarantined: they accept but can't initiate). Both people must share their machine with the other.
