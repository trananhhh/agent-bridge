# CLAUDE.md — agent-bridge

User-facing: [README.md](README.md). Setup runbook executed by Claude Code on a new member's machine: [SETUP.md](SETUP.md) — keep it in sync with CLI behaviour.

## Layout

- `src/cli.ts` — single entry (`bin/agent-bridge`): `setup`, `invite`/`accept`/`peers`/… (thin clients of the daemon's local API), `daemon`, `channel`.
- `src/invite.ts` — `ab1_` invite codes (inviter name, URL, one-time secret). Accepting POSTs `/pair` to the inviter; the secret becomes the pair's bearer token.
- `src/daemon.ts` — peer HTTP (`/inbox`, `/pair`, `/health`) + local HTTP (`/local/*`, 127.0.0.1 only) + routing + headless runs. Pure wiring is injectable (`runner`, `listSessions`, `fetchImpl`) so `daemon.test.ts` runs several daemons in-process.
- `src/router.ts` — routing decisions (pure). Change routing here, not in `daemon.ts`.
- `src/channel.ts` — MCP stdio server spawned by Claude Code per session. Talks only to the local daemon, never to peers.
- `src/sessions.ts` — reads `~/.claude/projects/*/*.jsonl` (head/tail 256 KB) for routing candidates.
- State: `~/.agent-bridge/config.json` (static: name, Tailscale IP, ports) + `bridge.db` (peers, invites, threads, messages, outbox) + `daemon.log` (`BRIDGE_HOME` overrides; tests and smoke runs must set it).

## Rules

- Runs as native TypeScript on Node ≥ 22.18 (type stripping): erasable syntax only, `.ts` import extensions, `import type` for types. `tsc` enforces this (`erasableSyntaxOnly`, `verbatimModuleSyntax`). No build step — don't add one.
- `channel.ts` stdout is the MCP JSON-RPC stream: never `console.log` there; log to stderr.
- Peer `folders` is the data boundary: every place that picks a session or cwd for a peer's question must filter with `isWithin(cwd, peer.folders)`, and headless runs pass them as `readOnlyDirs` (→ `--restricted --add-dir`).
- Headless runs: `--restricted --strict-mcp-config --tools Read,Grep,Glob,WebSearch --permission-mode dontAsk`. Verified: Read outside folders is denied by the CLI, Write/Bash don't exist. Don't loosen this — it is the product's write-needs-owner guarantee.
- Never declare `claude/channel/permission` — it would let a peer approve tool calls on this machine.
- Tests first (`npm test`); keep the multi-daemon test green.

## Pitfalls

- Custom channels aren't on Anthropic's allowlist during the research preview: live push needs `--dangerously-load-development-channels server:agent-bridge` (`bin/claude-bridge`) and `BRIDGE_LIVE=1`. Without `BRIDGE_LIVE` the channel doesn't subscribe, otherwise the daemon would push into sessions that silently drop notifications.
- `claudeBin` must stay the launcher path (`~/.local/bin/claude`), not its realpath — the auto-updater swaps versioned targets.
- Claude Code records canonical cwds (`/tmp` → `/private/tmp`); `expandPath` realpaths folders to match.
