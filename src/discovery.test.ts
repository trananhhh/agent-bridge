import { describe, expect, it } from 'vitest';
import { findBridges, parseTailscaleStatus } from './discovery.ts';

const status = {
  Self: { HostName: 'anh-mac', TailscaleIPs: ['100.1.1.1', 'fd7a::1'], Online: true },
  Peer: {
    a: { HostName: 'cu-mac', DNSName: 'cu-mac.tail.ts.net.', OS: 'macOS', TailscaleIPs: ['100.2.2.2', 'fd7a::2'], Online: true },
    b: { HostName: 'iphone', DNSName: 'iphone.tail.ts.net.', OS: 'iOS', TailscaleIPs: ['100.3.3.3'], Online: false },
    c: { HostName: 'nas', DNSName: 'nas.tail.ts.net.', OS: 'linux', TailscaleIPs: ['100.4.4.4'], Online: true },
  },
};

describe('parseTailscaleStatus', () => {
  it('returns self IPv4 and online peers only', () => {
    expect(parseTailscaleStatus(status)).toEqual({
      selfIp: '100.1.1.1',
      peers: [
        { ip: '100.2.2.2', host: 'cu-mac', os: 'macOS' },
        { ip: '100.4.4.4', host: 'nas', os: 'linux' },
      ],
    });
  });
});

describe('findBridges', () => {
  it('keeps only hosts answering as agent-bridge, tolerating failures', async () => {
    const fetchImpl = async (url: string) => {
      if (url.startsWith('http://100.2.2.2')) return new Response(JSON.stringify({ ok: true, app: 'agent-bridge', name: 'cu' }));
      if (url.startsWith('http://100.4.4.4')) return new Response('not found', { status: 404 });
      throw new Error('timeout');
    };
    const found = await findBridges(parseTailscaleStatus(status).peers, { port: 8790, fetchImpl });
    expect(found).toEqual([{ name: 'cu', ip: '100.2.2.2', host: 'cu-mac', url: 'http://100.2.2.2:8790' }]);
  });
});
