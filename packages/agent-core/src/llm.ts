import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  InvalidResponseDataError,
  NoContentGeneratedError,
  type LanguageModel,
} from 'ai';

export type LlmErrorKind = 'timeout' | 'network' | 'http' | 'empty' | 'aborted';

/** Why a model call failed, in the terms the rest of the agent reports (`llm_timeout`, `llm_http`, ...). */
export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export const isRetryable = (err: unknown): boolean =>
  err instanceof LlmError &&
  (err.kind === 'timeout' ||
    err.kind === 'network' ||
    err.kind === 'empty' ||
    (err.kind === 'http' && (err.status ?? 0) >= 500));

export interface OpenAiCompatibleOptions {
  /** e.g. http://127.0.0.1:20228/v1 (RINE's own 9Router, see infra/9router/README.md). */
  baseUrl: string;
  apiKey: string;
  /** A model or Combo alias on that router, e.g. "rine-chat". */
  model: string;
  /** Time allowed for one request to the model endpoint (the first token is the one that matters). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The first JSON object in a response body. 9Router answers requests that carry tools with the JSON
 * followed by an SSE "data: [DONE]" line, which a plain JSON.parse rejects.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface WireCompletion {
  model?: string;
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string;
  }[];
}

/** A complete answer from a body that is plain JSON, JSON + trailing SSE noise, or (rarely) all SSE chunks. */
function parseCompletion(text: string): WireCompletion | null {
  if (!text.trimStart().startsWith('data:')) return firstJsonObject(text) as WireCompletion | null;
  // A whole answer delivered as stream chunks: put the pieces back together.
  let content = '';
  let model: string | undefined;
  let finish: string | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
    const chunk = firstJsonObject(line.slice(5)) as {
      model?: string;
      choices?: {
        delta?: {
          content?: string;
          tool_calls?: {
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
        finish_reason?: string;
      }[];
    } | null;
    if (!chunk) continue;
    model ??= chunk.model;
    const choice = chunk.choices?.[0];
    content += choice?.delta?.content ?? '';
    finish = choice?.finish_reason ?? finish;
    for (const part of choice?.delta?.tool_calls ?? []) {
      const call = calls.get(part.index ?? 0) ?? { id: '', name: '', arguments: '' };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name += part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
      calls.set(part.index ?? 0, call);
    }
  }
  return {
    model,
    choices: [
      {
        message: {
          content,
          tool_calls: [...calls.values()].map((c, i) => ({
            id: c.id || `call_${i}`,
            function: { name: c.name, arguments: c.arguments },
          })),
        },
        finish_reason: finish,
      },
    ],
  };
}

/**
 * The HTTP layer under the AI SDK model: the time limit, the error kinds, and 9Router's quirks. A
 * complete (non-streamed) answer is read here so a body with trailing SSE noise, or a 200 that says
 * "failed" and carries nothing, is dealt with before the SDK sees it; those are retried once, like a
 * timeout, a network error or a 5xx, since nothing has been produced yet.
 */
function createLlmFetch(options: OpenAiCompatibleOptions): typeof fetch {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;

  async function attempt(input: Parameters<typeof fetch>[0], init: RequestInit, stream: boolean) {
    const caller = init.signal ?? undefined;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
    const failure = (err: unknown): LlmError => {
      if (caller?.aborted) return new LlmError('aborted', 'request was cancelled');
      if (timeout.aborted) return new LlmError('timeout', `no answer within ${timeoutMs} ms`);
      return new LlmError('network', err instanceof Error ? err.message : 'network error');
    };
    let res: Response;
    try {
      res = await doFetch(input, { ...init, signal });
    } catch (err) {
      throw failure(err);
    }
    if (!res.ok)
      throw new LlmError('http', `the model endpoint answered ${res.status}`, res.status);
    if (stream) {
      if (!res.body) throw new LlmError('empty', 'the model returned no body');
      return res;
    }
    let json: WireCompletion | null;
    try {
      json = parseCompletion(await res.text());
    } catch (err) {
      throw failure(err);
    }
    const message = json?.choices?.[0]?.message;
    // 9Router reports an upstream failure as 200 with finish_reason "failed" and no text.
    if (!message?.content?.trim() && !message?.tool_calls?.length) {
      throw new LlmError(
        'empty',
        `the model returned nothing (${json?.choices?.[0]?.finish_reason ?? 'no choices'})`,
      );
    }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return (async (input, init = {}) => {
    const stream = (() => {
      try {
        return JSON.parse(String(init.body)).stream === true;
      } catch {
        return false;
      }
    })();
    try {
      return await attempt(input, init, stream);
    } catch (err) {
      // A stream may already have been shown to someone; only a complete answer is retried here.
      if (stream || !isRetryable(err) || init.signal?.aborted) throw err;
      return attempt(input, init, stream);
    }
  }) as typeof fetch;
}

/** The chat model for AI_LLM_*: Chat Completions over HTTP, the protocol 9Router (and most providers) speak. */
/** A concrete model object (not a gateway model id string), as the memory planner and other adapters need. */
export type ChatModel = Exclude<LanguageModel, string>;

export function createChatModel(options: OpenAiCompatibleOptions): ChatModel {
  const provider = createOpenAICompatible({
    name: 'rine-llm',
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    apiKey: options.apiKey,
    fetch: createLlmFetch(options),
    // 9Router's endpoint may stream when this field is omitted.
    transformRequestBody: (body) => ({ ...body, stream: body.stream ?? false }),
  });
  return provider.chatModel(options.model);
}

/** An error from the SDK (or from `createChatModel`'s fetch, wrapped by the SDK) as an LlmError; anything else is returned as is. */
export function toLlmError(err: unknown, signal?: AbortSignal): unknown {
  if (err instanceof LlmError) return err;
  if (signal?.aborted) return new LlmError('aborted', 'request was cancelled');
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (e instanceof LlmError) return e;
    if (APICallError.isInstance(e)) {
      return new LlmError('http', e.message, e.statusCode);
    }
    // A stream that ended without a finish reason and without anything to show.
    if (NoContentGeneratedError.isInstance(e) || InvalidResponseDataError.isInstance(e))
      return new LlmError('empty', e.message);
    if (e instanceof Error && e.name === 'AbortError')
      return new LlmError('aborted', 'request was cancelled');
    e =
      (e as { cause?: unknown; lastError?: unknown }).lastError ?? (e as { cause?: unknown }).cause;
  }
  return err;
}
