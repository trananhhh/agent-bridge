# SETUP — letting Claude Code install it for you

The [README](README.md) is enough to install by hand. This file is for Claude Code when the user says *"install agent-bridge for me using https://github.com/trananhhh/agent-bridge/blob/main/SETUP.md"*.

**Claude:** go through the steps in order. At every "ASK", ask the user. Never pick their name or their folders for them.

1. **Tailscale.** Run `tailscale ip -4 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4`. If there is no `100.x.y.z` address, stop and ask the user to install https://tailscale.com/download and log in.
2. **Install.** Check `node -v` (needs ≥ 22.13), then run `npm install -g --prefer-online https://github.com/trananhhh/agent-bridge/tarball/main`.
3. **ASK for a name** (lowercase, no spaces), then run `agent-bridge setup --name <name>`.
4. **Share Tailscale both ways.** Walk the user through "Share your machines with each other" in the README. You cannot do this step for them.
5. **Connect.** The CLI asks its questions interactively but accepts answers piped on stdin.
   - **To invite someone:** run `agent-bridge connect` to see the list. ASK the user who to connect and which folders that person may read (mention that `.env` files in those folders are readable too). Then run:
     `printf '<number>\n<folder1>,<folder2>\ny\n' | agent-bridge connect`
     The command waits up to 15 minutes for the other side to accept.
   - **When someone has invited the user:** run `agent-bridge requests` to see it. ASK whether to accept and which folders to share. Then run:
     `printf 'y\n<folder1>,<folder2>\n' | agent-bridge requests`
6. **Remember.** Save the note the CLI prints (or the output of `agent-bridge note <name>`) to your memory exactly as written.
7. **Report to the user:** who is connected, and which folders each side can read (`agent-bridge peers`). Tell them to start Claude with `claude-bridge` if they want colleagues' messages to pop up in the open conversation.
8. **Optional: one Telegram chat per colleague** (only if the user already mirrors to Telegram and wants a colleague's conversation kept out of the default group). Run on the machine that reads the bot: `agent-bridge telegram --peer=<machine>`. The user adds the bot to that colleague's group as an admin, or you pass `--chat=<id|@username>`. `agent-bridge telegram --peer=<machine> off` removes the route, and `agent-bridge status` lists each one. A colleague who joins with `--hub=<this machine>` gets their own group, never the default one.
