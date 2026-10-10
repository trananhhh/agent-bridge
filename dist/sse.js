export class SseParser {
    buffer = '';
    onEvent;
    constructor(onEvent) {
        this.onEvent = onEvent;
    }
    push(chunk) {
        this.buffer += chunk.replace(/\r\n/g, '\n');
        let sep;
        while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
            const block = this.buffer.slice(0, sep);
            this.buffer = this.buffer.slice(sep + 2);
            let event = 'message';
            const data = [];
            let hasField = false;
            for (const line of block.split('\n')) {
                if (!line || line.startsWith(':'))
                    continue;
                const idx = line.indexOf(':');
                const field = idx === -1 ? line : line.slice(0, idx);
                const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
                if (field === 'event')
                    event = value;
                else if (field === 'data')
                    data.push(value);
                else
                    continue;
                hasField = true;
            }
            if (hasField)
                this.onEvent({ event, data: data.join('\n') });
        }
    }
}
