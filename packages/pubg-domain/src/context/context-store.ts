import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CanonicalQuery, Selector } from '../schema/query.js';
import type { ResultSetRecord, SessionContextRecord } from '../data/model.js';

export interface ContextStore {
  getContext(sessionId: string): Promise<SessionContextRecord | null>;
  setContext(context: SessionContextRecord): Promise<void>;
  getResultSet(sessionId: string, resultSetId: string): Promise<ResultSetRecord | null>;
  setResultSet(result: ResultSetRecord): Promise<void>;
}

function validUntil(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

export function sessionId(input: {
  platform: string;
  chatId: string;
  userId: string;
  domain?: string;
}): string {
  return [input.platform, input.chatId, input.userId, input.domain ?? 'pubg']
    .map((part) => encodeURIComponent(String(part || 'unknown')))
    .join(':');
}

export function emptyContext(id: string, now = new Date()): SessionContextRecord {
  return {
    schemaVersion: 3,
    sessionId: id,
    activeDomain: null,
    lastQuery: null,
    lastSelector: null,
    lastResultSetId: null,
    lastSubject: null,
    references: {},
    activeMatchId: null,
    activeMatchOrdinal: null,
    activeReviewResultSetId: null,
    sourceMatchResultSetId: null,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(),
  };
}

export class InMemoryContextStore implements ContextStore {
  private readonly contexts = new Map<string, SessionContextRecord>();
  private readonly results = new Map<string, ResultSetRecord>();

  async getContext(id: string): Promise<SessionContextRecord | null> {
    const value = this.contexts.get(id);
    return value && validUntil(value.expiresAt) ? structuredClone(value) : null;
  }

  async setContext(value: SessionContextRecord): Promise<void> {
    this.contexts.set(value.sessionId, structuredClone(value));
  }

  async getResultSet(session: string, id: string): Promise<ResultSetRecord | null> {
    const value = this.results.get(session + ':' + id);
    return value && validUntil(value.expiresAt) ? structuredClone(value) : null;
  }

  async setResultSet(value: ResultSetRecord): Promise<void> {
    this.results.set(value.sessionId + ':' + value.id, structuredClone(value));
  }
}

interface PersistedState {
  contexts: Record<string, SessionContextRecord>;
  results: Record<string, ResultSetRecord>;
}

export class JsonContextStore implements ContextStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async read(): Promise<PersistedState> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<PersistedState>;
      return { contexts: value.contexts ?? {}, results: value.results ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { contexts: {}, results: {} };
    }
  }

  private async write(mutator: (state: PersistedState) => void): Promise<void> {
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read();
        mutator(state);
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = this.filePath + '.tmp';
        await fs.writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
      });
    return this.queue;
  }

  async getContext(id: string): Promise<SessionContextRecord | null> {
    const state = await this.read();
    const value = state.contexts[id];
    return value && validUntil(value.expiresAt) ? structuredClone(value) : null;
  }

  async setContext(value: SessionContextRecord): Promise<void> {
    await this.write((state) => {
      state.contexts[value.sessionId] = value;
    });
  }

  async getResultSet(session: string, id: string): Promise<ResultSetRecord | null> {
    const state = await this.read();
    const value = state.results[session + ':' + id];
    return value && validUntil(value.expiresAt) ? value : null;
  }

  async setResultSet(value: ResultSetRecord): Promise<void> {
    await this.write((state) => {
      state.results[value.sessionId + ':' + value.id] = value;
    });
  }
}

export function contextForQuery(
  query: CanonicalQuery,
  resultSetId: string,
  sessionIdValue: string,
  ttlMs = 12 * 60 * 60 * 1000,
): SessionContextRecord {
  const now = new Date();
  return {
    schemaVersion: 3,
    sessionId: sessionIdValue,
    activeDomain: 'pubg',
    lastQuery: query,
    lastSelector: query.selector,
    lastResultSetId: resultSetId,
    lastSubject: query.subject,
    references: {
      selectorSource: query.reference.selectorExplicit ? 'tool_input' : 'default',
    },
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

export function withSessionId(
  query: CanonicalQuery,
  id: string,
): CanonicalQuery & { reference: CanonicalQuery['reference'] & { sessionId: string } } {
  return { ...query, reference: { ...query.reference, sessionId: id } };
}
