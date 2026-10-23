import { describe, expect, it } from 'vitest';
import { delta, fakeEndpoint, sse } from './http-testkit.js';
import { createChatModel, LlmError, toLlmError } from './llm.js';
import { AgentTurnService, type TurnInput } from './turn.js';

const ctx = {
  roomId: '22222222-2222-4222-8222-222222222222',
  agentId: '11111111-1111-4111-8111-111111111111',
  user: { id: '66666666-6666-4666-8666-666666666666', displayName: 'Mei' },
};
const input = (over: Partial<TurnInput<typeof ctx>> = {}) => ({
  prompt: [
    { role: 'system' as const, content: 'be brief' },
    { role: 'user' as const, content: 'ping' },
  ],
  ctx,
  signal: new AbortController().signal,
  maxTokens: 20,
  ...over,
});
const service = (baseUrl: string, extra: { timeoutMs?: number; apiKey?: string } = {}) =>
  new AgentTurnService<typeof ctx>({
    model: createChatModel({
      baseUrl,
      apiKey: extra.apiKey ?? 'k-k-k-k-k-k',
      model: 'rine-chat',
      ...extra,
    }),
  });
const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const p of it) out.push(p);
  return out;
};

describe('the chat model over HTTP', () => {
  it('sends the key, the RINE alias and the limits, and returns the text', async () => {
    let seen: { auth?: string; body?: Record<string, any> } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const baseUrl = await fakeEndpoint((req, res, body) => {
      seen = { auth: req.headers.authorization, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'qwen-flash',
          choices: [{ message: { content: ' pong ' }, finish_reason: 'stop' }],
        }),
      );
    });
    expect(await service(baseUrl, { apiKey: 'sk-test-key' }).reply(input())).toEqual({
      text: 'pong',
    });
    expect(seen.auth).toBe('Bearer sk-test-key');
    expect(seen.body).toMatchObject({
      model: 'rine-chat',
      stream: false,
      max_tokens: 20,
      temperature: 0.6,
    });
    expect(seen.body!.messages[0]).toMatchObject({ role: 'system', content: 'be brief' });
    expect(seen.body!.messages[1]).toMatchObject({ role: 'user' });
    expect(seen.body!.tools).toBeUndefined();
  });

  it('streams pieces in order, tolerating frames split across network chunks', async () => {
    const baseUrl = await fakeEndpoint((_req, res) =>
      sse(res, [
        delta('Hel'),
        'data: {"choices":[{"delta":{"con',
        'tent":"lo"}}]}\n\n',
        ': keep-alive\n\n',
        delta(' there'),
        'data: [DONE]\n\n',
      ]),
    );
    expect((await collect(service(baseUrl).speech(input()))).join('')).toBe('Hello there');
  });

  it('turns a 200 with finish_reason "failed" (how 9Router reports a dead upstream) into an error', async () => {
    let calls = 0;
    const baseUrl = await fakeEndpoint((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'failed' }],
        }),
      );
    });
    await expect(service(baseUrl).reply(input())).rejects.toMatchObject({ kind: 'empty' });
    expect(calls).toBe(2); // one retry: nothing had been produced yet
  });

  it('retries a transient failure once, then succeeds', async () => {
    let calls = 0;
    const baseUrl = await fakeEndpoint((_req, res) => {
      if (++calls === 1) return void res.writeHead(502).end('bad gateway');
      res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    expect(await service(baseUrl).reply(input())).toEqual({ text: 'ok' });
    expect(calls).toBe(2);
  });

  it('gives up after the retry on 5xx and reports the status', async () => {
    let calls = 0;
    const baseUrl = await fakeEndpoint((_req, res) => {
      calls++;
      res.writeHead(502).end('bad gateway');
    });
    await expect(service(baseUrl).reply(input())).rejects.toMatchObject({
      kind: 'http',
      status: 502,
    });
    expect(calls).toBe(2);
  });

  it('reports a refusal with its status, does not retry it, and never leaks the key', async () => {
    let calls = 0;
    const baseUrl = await fakeEndpoint((_req, res) => {
      calls++;
      res.writeHead(401).end('{"error":"bad key sk-secret-secret"}');
    });
    const err = (await service(baseUrl, { apiKey: 'sk-secret-secret' })
      .reply(input())
      .catch((e) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'http', status: 401 });
    expect(err.message).not.toContain('sk-secret-secret');
    expect(calls).toBe(1);
  });

  it('times out when the endpoint is too slow', async () => {
    const baseUrl = await fakeEndpoint(() => new Promise(() => undefined));
    await expect(service(baseUrl, { timeoutMs: 60 }).reply(input())).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('reports an unreachable endpoint as a network error', async () => {
    await expect(
      service('http://127.0.0.1:1/v1', { timeoutMs: 500 }).reply(input()),
    ).rejects.toMatchObject({ kind: 'network' });
  });

  it('a newer request can cancel a stream in progress', async () => {
    const baseUrl = await fakeEndpoint((_req, res) =>
      sse(res, [delta('a'), delta('b'), delta('c'), delta('d'), 'data: [DONE]\n\n'], 40),
    );
    const controller = new AbortController();
    const got: string[] = [];
    const run = (async () => {
      for await (const p of service(baseUrl).speech(input({ signal: controller.signal }))) {
        got.push(p);
        if (got.length === 1) controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(got.length).toBeLessThan(4);
  });

  it('an empty stream is an error, not silence', async () => {
    const baseUrl = await fakeEndpoint((_req, res) => sse(res, ['data: [DONE]\n\n']));
    await expect(collect(service(baseUrl).speech(input()))).rejects.toMatchObject({
      kind: 'empty',
    });
  });

  it('a stream that breaks before any words is an error the caller can classify', async () => {
    const baseUrl = await fakeEndpoint((_req, res) => void res.writeHead(500).end('boom'));
    await expect(collect(service(baseUrl).speech(input()))).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
  });
});

describe('router quirks', () => {
  it('reads a complete answer that is followed by an SSE "[DONE]" line', async () => {
    const baseUrl = await fakeEndpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `${JSON.stringify({ model: 'm', choices: [{ message: { content: 'hello } {' }, finish_reason: 'stop' }] })}data: [DONE]\n\n`,
      );
    });
    expect((await service(baseUrl).reply(input())).text).toBe('hello } {');
  });

  it('puts together a complete answer that arrived as stream chunks', async () => {
    const baseUrl = await fakeEndpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          { model: 'm', choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
        ]
          .map((c) => `data: ${JSON.stringify(c)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
      );
    });
    expect((await service(baseUrl).reply(input())).text).toBe('Hello');
  });

  it('a body that is not JSON at all is an empty answer, not a crash', async () => {
    const baseUrl = await fakeEndpoint(
      (_req, res) => void res.writeHead(200).end('<html>bad gateway</html>'),
    );
    await expect(service(baseUrl).reply(input())).rejects.toMatchObject({ kind: 'empty' });
  });
});

describe('toLlmError', () => {
  it('keeps LlmErrors, finds them under a wrapper, and leaves other errors alone', () => {
    const own = new LlmError('timeout', 'slow');
    expect(toLlmError(own)).toBe(own);
    expect(toLlmError(new Error('wrapped', { cause: own }))).toBe(own);
    const other = new TypeError('a bug');
    expect(toLlmError(other)).toBe(other);
    expect(toLlmError(other, AbortSignal.abort())).toMatchObject({ kind: 'aborted' });
  });
});
