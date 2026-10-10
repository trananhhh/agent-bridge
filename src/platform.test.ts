import { describe, expect, it } from 'vitest';
import { claudeInvocation, launchdPlist, windowsLauncherVbs } from './platform.ts';

const spec = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cliPath: 'C:\\Users\\cu\\AppData\\Roaming\\npm\\node_modules\\@trananhhh\\agent-bridge\\dist\\cli.js',
  bridgeHome: 'C:\\Users\\cu\\.agent-bridge',
  logPath: 'C:\\Users\\cu\\.agent-bridge\\daemon.log',
};

describe('claudeInvocation', () => {
  it('runs an unwrapped npm cli.js with node, and anything else directly', () => {
    expect(claudeInvocation('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js')).toEqual({
      command: process.execPath,
      args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'],
    });
    expect(claudeInvocation('/Users/a/.local/bin/claude')).toEqual({ command: '/Users/a/.local/bin/claude', args: [] });
    expect(claudeInvocation('C:\\Users\\cu\\.local\\bin\\claude.exe').args).toEqual([]);
  });
});

describe('windowsLauncherVbs', () => {
  it('starts the daemon hidden, with every path quoted for VBScript', () => {
    const vbs = windowsLauncherVbs(spec);
    expect(vbs).toContain(
      'sh.Run """C:\\Program Files\\nodejs\\node.exe"" --disable-warning=ExperimentalWarning ""C:\\Users\\cu\\AppData\\Roaming\\npm\\node_modules\\@trananhhh\\agent-bridge\\dist\\cli.js"" daemon --log ""C:\\Users\\cu\\.agent-bridge\\daemon.log""", 0, False',
    );
    expect(vbs).not.toContain('BRIDGE_HOME');
    expect(vbs.endsWith('\r\n')).toBe(true);
  });

  it('passes an overridden BRIDGE_HOME through', () => {
    expect(windowsLauncherVbs({ ...spec, bridgeHomeEnv: 'D:\\ab' })).toContain('sh.Environment("Process")("BRIDGE_HOME") = "D:\\ab"');
  });
});

describe('launchdPlist', () => {
  it('runs the daemon with node and keeps it alive', () => {
    const plist = launchdPlist({
      nodePath: '/n/bin/node',
      cliPath: '/x/dist/cli.js',
      bridgeHome: '/h/.agent-bridge',
      logPath: '/h/l.log',
      claudeDir: '/h/.local/bin',
    });
    expect(plist).toContain(
      '<string>/n/bin/node</string><string>--disable-warning=ExperimentalWarning</string><string>/x/dist/cli.js</string><string>daemon</string>',
    );
    expect(plist).toContain('<key>PATH</key><string>/n/bin:/h/.local/bin:');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
  });
});
