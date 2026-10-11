# agent-bridge

Let your Claude Code agent ask a colleague's Claude Code agent directly, and the reverse. Each agent runs on its own machine and account. Connections are peer-to-peer over Tailscale, with no server in between.

## Install (each person, once)

**1. Tailscale.** Install the app from https://tailscale.com/download and log in with your own account.

**2. Share your machines with each other, in both directions.** Each person does this:
1. Open https://login.tailscale.com/admin/machines
2. On your machine's row: `⋯` → **Share…** → copy the share link (or enter the other person's email)
3. Send the link to your colleague; they open it and click **Accept**

Both directions are required. A shared machine can *receive* connections but cannot *initiate* them. To check, run `tailscale status`; the other person's machine should be listed.

**3. agent-bridge.** You need Node ≥ 22.13 and Claude Code. Works on macOS and Windows (Linux: run the daemon under your own supervisor).

```bash
npm install -g --prefer-online https://github.com/trananhhh/agent-bridge/tarball/main
agent-bridge
```

The first run asks for your name, starts a background daemon (it also starts at login), and registers the MCP server with Claude Code. When the OS asks whether Node may accept incoming connections, click **Allow**: on macOS the prompt is *"Allow node to accept incoming network connections"*, and on Windows it is a Windows Defender Firewall dialog for Node.js (tick Private and Public).

To update, run the same `npm install -g --prefer-online …` command again (`--prefer-online` makes npm fetch the new tarball instead of reusing its cache), then `agent-bridge setup` to restart the daemon.

## Connect

**The inviter** runs `agent-bridge`:
1. The CLI scans Tailscale and lists the machines running agent-bridge. Pick the person to connect to.
2. Choose which folders they may **read**.
3. Send the request and wait.

**The invitee** gets a macOS notification and runs `agent-bridge`:
1. The CLI shows who is asking, with their verified Tailscale identity (not a self-declared name), and the folders they share.
2. Accept, then choose which folders the inviter may **read**.

When the connection is made, **both** CLIs print a short note and copy it to the clipboard. Paste the note into Claude Code so your agent saves to memory who it can talk to, about which folders, and with which tools.

## Use

Talk to Claude Code as usual: *"ask Cu's agent whether the orders table has a provider_id column"*.

- **To see colleagues' messages pop up in the conversation you have open:** start Claude with `claude-bridge` instead of `claude`. This adds `--dangerously-load-development-channels`, and you confirm a warning each launch, because Claude Code [channels](https://code.claude.com/docs/en/channels-reference) are in research preview.
- **Regular sessions and the desktop app** work too. Claude polls `peer_inbox` for answers.
- **When a colleague asks while you have no session open,** the daemon answers in a read-only session. If the question relates to one of your recent sessions (last 48h), it continues in that session.

## See what the agents said

Every message passes through both daemons, so **each side keeps the whole exchange on its own machine**. Nothing has to be shared between accounts (Claude Code cannot share a local session with another account anyway).

- `agent-bridge log` lists recent threads: who asked whom, and the first line of each.
- `agent-bridge log <thread>` prints the whole thread. When the answer came from your machine, it also prints `claude --resume <id>`, which opens the session that answered so you can see which files it read.
- `agent-bridge log -f` shows new messages as they arrive.

Sessions that answer a colleague are named `⇄ <colleague>: <question>`. Sessions started with `claude -p` are left out of the `/resume` picker, so open them by id. In the session that asked, the question and the answer appear as the `ask_peer` and `peer_inbox` tool calls.

## Permissions

- For each connection, each side chooses which of its folders the other side may read. The other side can read **everything** in those folders, including any `.env` file.
- Sessions that answer a colleague run as `claude --restricted --add-dir <folder>`. They have no Write, Edit or Bash, and the CLI blocks reads outside the shared folders. This is enforced at the tool level and has been verified; it does not rely on the model behaving.
- If a request needs a write, the agent replies that the machine's owner must do it. In your own open session, Claude Code still asks you before any write.

## Commands

```
agent-bridge                 wizard: setup → pending requests → connect someone new
agent-bridge connect [ip]    connect (give their Tailscale IP if the scan can't see them)
agent-bridge requests        accept / decline pending requests
agent-bridge peers           who is connected and what each side can read
agent-bridge note <name>     print the Claude Code note again
agent-bridge folders <name>  change which folders that person can read
agent-bridge remove <name>   disconnect
agent-bridge log [thread]    what the agents said to each other (-f: keep watching)
agent-bridge status          daemon + each connection online/offline
agent-bridge uninstall       stop the daemon, remove the MCP server
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `connect` finds nobody | Is Tailscale shared **both ways** (`tailscale status`)? Has the other person run `agent-bridge` once? |
| Machine is visible but requests fail | A firewall may be blocking Node. On macOS: System Settings → Network → Firewall → Options. On Windows: Windows Security → Firewall → Allow an app → Node.js (Private and Public) |
| A colleague's question gets no answer | Run `agent-bridge status` on their machine; check the log at `~/.agent-bridge/daemon.log` |

Everything lives in `~/.agent-bridge/`: `config.json`, `bridge.db` (connections, message history, queue) and `daemon.log`. Messages to an offline peer are queued and retried until they come back. Answers are billed to the **answering** side's Claude account.

## Development

```bash
npm install && npm test && npm run typecheck
npm run build   # dist/ is committed so `npm install -g <tarball>` needs no build step — rebuild before committing
```
