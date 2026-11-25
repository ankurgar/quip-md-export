import type { HtmlParser } from './convert';
import { Exporter, type ExportEvent, type ExportOptions } from './exporter';
import { QuipClient, type ClientOptions } from './quipClient';
import type { Sink } from './sink';

export interface SessionConfig {
  token: string;
  baseUrl?: string;
  sink: Sink;
  parseHtml: HtmlParser;
  options?: Partial<ExportOptions>;
  signal?: AbortSignal;
  onEvent?: (event: ExportEvent) => void;
  /** Transport overrides, mainly for tests. */
  client?: Partial<Pick<ClientOptions, 'fetch' | 'sleep' | 'now' | 'minIntervalMs' | 'maxRetries' | 'messagePageSize'>>;
}

/** Wires an API client and an exporter together, forwarding rate-limit pauses to the exporter's event stream. */
export function createSession(cfg: SessionConfig): { client: QuipClient; exporter: Exporter } {
  let exporter: Exporter | undefined;
  const client = new QuipClient({
    token: cfg.token,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.signal ? { signal: cfg.signal } : {}),
    ...cfg.client,
    onEvent: (event) => {
      if (event.type === 'throttle') exporter?.recordThrottle(event.waitMs, event.reason);
    },
  });
  exporter = new Exporter(
    {
      client,
      sink: cfg.sink,
      parseHtml: cfg.parseHtml,
      ...(cfg.onEvent ? { onEvent: cfg.onEvent } : {}),
      ...(cfg.signal ? { signal: cfg.signal } : {}),
    },
    cfg.options,
  );
  return { client, exporter };
}
