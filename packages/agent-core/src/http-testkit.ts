import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach } from 'vitest';

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
) => void | Promise<void>;

/** A throwaway OpenAI-style endpoint for tests; call inside a test, servers are closed after it. */
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    s.close();
  }
});

export async function fakeEndpoint(handler: Handler): Promise<string> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    await handler(req, res, raw ? JSON.parse(raw) : {});
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

/** Writes server-sent-event frames (objects are JSON-encoded; strings go out as they are). */
export const sse = (res: ServerResponse, frames: (string | object)[], delayMs = 0) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (i: number) => {
    if (i >= frames.length) return res.end();
    const f = frames[i]!;
    res.write(typeof f === 'string' ? f : `data: ${JSON.stringify(f)}\n\n`);
    setTimeout(() => send(i + 1), delayMs);
  };
  send(0);
};

export const delta = (content: string) => ({ choices: [{ delta: { content } }] });

export const completion = (message: object, finish = 'stop') => ({
  model: 'qwen-flash',
  choices: [{ message, finish_reason: finish }],
});

export const toolCallMessage = (calls: { id: string; name: string; args: unknown }[]) => ({
  role: 'assistant',
  content: null,
  tool_calls: calls.map((c) => ({
    id: c.id,
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) },
  })),
});
