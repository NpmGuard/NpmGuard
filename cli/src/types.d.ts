declare module "qrcode-terminal" {
  function generate(text: string, opts?: { small?: boolean }, cb?: (code: string) => void): void;
  export default { generate };
}

declare module "eventsource" {
  class EventSource {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSED: 2;

    readonly readyState: number;
    readonly url: string;

    constructor(url: string, eventSourceInitDict?: Record<string, unknown>);

    addEventListener(type: string, listener: (event: MessageEvent) => void): void;
    removeEventListener(type: string, listener: (event: MessageEvent) => void): void;
    close(): void;

    onerror: ((event: Event) => void) | null;
    onmessage: ((event: MessageEvent) => void) | null;
    onopen: ((event: Event) => void) | null;
  }

  interface MessageEvent {
    data: string;
    lastEventId: string;
    type: string;
  }

  export default EventSource;
}
