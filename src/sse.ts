export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private readonly onEvent: (e: SseEvent) => void;

  constructor(onEvent: (e: SseEvent) => void) {
    this.onEvent = onEvent;
  }

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      let hasField = false;
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const idx = line.indexOf(':');
        const field = idx === -1 ? line : line.slice(0, idx);
        const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else continue;
        hasField = true;
      }
      if (hasField) this.onEvent({ event, data: data.join('\n') });
    }
  }
}
