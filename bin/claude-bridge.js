#!/usr/bin/env node
// Claude Code session that receives agent-bridge messages live (channel push).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const { CONFIG_PATH, loadConfig } = await import('../dist/config.js');
const { claudeInvocation } = await import('../dist/platform.js');

const inv = claudeInvocation(existsSync(CONFIG_PATH) ? loadConfig().claudeBin : 'claude');
const child = spawn(inv.command, [...inv.args, '--dangerously-load-development-channels', 'server:agent-bridge', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, BRIDGE_LIVE: '1' },
});
child.on('error', (err) => {
  console.error(`claude-bridge: cannot start Claude Code (${err.message}). Run: agent-bridge setup`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
