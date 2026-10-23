import type { PubgDomainService, ToolEnvelope } from '@rine-kit/pubg-domain';
import type { PubgToolSpec } from './catalog.js';
import { invalidInputError, runtimeError } from './envelopes.js';
import {
  resolveSubject,
  stripSubject,
  type PubgSubjectHost,
  type PubgSubjectInput,
} from './subject.js';

export interface RunPubgToolOptions {
  /** The Domain service of the one tenant / team the host authorised for this request. */
  service: PubgDomainService;
  host: PubgSubjectHost;
  sessionId: string;
  signal?: AbortSignal;
}

/**
 * One tool call, the same on every host: check the arguments, settle who the question is about through the
 * host, call the Domain. Every failure becomes an error envelope the model can relay; nothing throws.
 */
export async function runPubgTool(
  tool: PubgToolSpec,
  rawInput: unknown,
  options: RunPubgToolOptions,
): Promise<ToolEnvelope> {
  try {
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success)
      return invalidInputError(parsed.error.issues.map((i) => i.message).join('; '));
    const input = parsed.data as PubgSubjectInput;
    const prepared = tool.requiresSubject
      ? await resolveSubject(options.service, options.host, input)
      : stripSubject(input);
    if ('status' in prepared && prepared.status === 'error') return prepared as ToolEnvelope;
    return await tool.run(options.service, prepared as never, {
      sessionId: options.sessionId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    return runtimeError(error);
  }
}
