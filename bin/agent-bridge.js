#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`agent-bridge needs Node >= 22.13 (found ${process.version})`);
  process.exit(1);
}

// node:sqlite is still flagged experimental; keep every other warning visible.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.error(String(w));
});

await import('../dist/cli.js');
