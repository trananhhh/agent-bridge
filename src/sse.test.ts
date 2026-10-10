import { describe, expect, it } from 'vitest';
import { SseParser } from './sse.ts';

describe('SseParser', () => {
  it('emits complete events across arbitrary chunk boundaries', () => {
    const events: { event: string; data: string }[] = [];
    const p = new SseParser((e) => events.push(e));
    p.push('event: ready\ndata: {"a"');
    p.push(':1}\n\nevent: message\ndata: line1\ndata: line2\nid: 7\n\n: comment\n\nevent: pi');
    expect(events).toEqual([
      { event: 'ready', data: '{"a":1}' },
      { event: 'message', data: 'line1\nline2' },
    ]);
    p.push('ng\ndata: \n\n');
    expect(events.at(-1)).toEqual({ event: 'ping', data: '' });
  });

  it('handles CRLF line endings', () => {
    const events: { event: string; data: string }[] = [];
    new SseParser((e) => events.push(e)).push('event: message\r\ndata: x\r\n\r\n');
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });
});
