import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MatchSelectionRecord, MatchSelectionRequest } from './types.js';

export interface SelectionStore {
  set(record: MatchSelectionRecord): Promise<void>;
  get(token: string): Promise<MatchSelectionRecord | null>;
  resolve(token: string, request: MatchSelectionRequest): Promise<MatchSelectionRecord | null>;
}

function isValid(record: MatchSelectionRecord, request: MatchSelectionRequest): boolean {
  const now = request.now?.getTime() ?? Date.now();
  const expires = Date.parse(record.expiresAt);
  return (
    record.platform === request.platform &&
    record.chatId === request.chatId &&
    Number.isFinite(expires) &&
    expires > now
  );
}

export function createSelectionToken(): string {
  return `s${randomUUID().replaceAll('-', '').slice(0, 11)}`;
}

export function callbackDataForToken(token: string): string {
  return `pubg:m:${token}`;
}

export function tokenFromCallbackData(value: string): string | null {
  const match = String(value ?? '').match(/^pubg:m:([A-Za-z0-9_-]{4,32})$/u);
  return match?.[1] ?? null;
}

export class InMemorySelectionStore implements SelectionStore {
  private readonly values = new Map<string, MatchSelectionRecord>();

  async set(record: MatchSelectionRecord): Promise<void> {
    this.values.set(record.token, structuredClone(record));
  }

  async get(token: string): Promise<MatchSelectionRecord | null> {
    const record = this.values.get(token);
    return record ? structuredClone(record) : null;
  }

  async resolve(
    token: string,
    request: MatchSelectionRequest,
  ): Promise<MatchSelectionRecord | null> {
    const record = await this.get(token);
    return record && isValid(record, request) ? record : null;
  }
}

interface PersistedSelections {
  selections: Record<string, MatchSelectionRecord>;
}

export class JsonSelectionStore implements SelectionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async read(): Promise<PersistedSelections> {
    try {
      const value = JSON.parse(
        await fs.readFile(this.filePath, 'utf8'),
      ) as Partial<PersistedSelections>;
      return { selections: value.selections ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { selections: {} };
    }
  }

  private async write(mutator: (state: PersistedSelections) => void): Promise<void> {
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        const state = await this.read();
        mutator(state);
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        await fs.writeFile(temporaryPath, JSON.stringify(state), { mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
      });
    return this.queue;
  }

  async set(record: MatchSelectionRecord): Promise<void> {
    await this.write((state) => {
      state.selections[record.token] = record;
    });
  }

  async get(token: string): Promise<MatchSelectionRecord | null> {
    const state = await this.read();
    return state.selections[token] ?? null;
  }

  async resolve(
    token: string,
    request: MatchSelectionRequest,
  ): Promise<MatchSelectionRecord | null> {
    const record = await this.get(token);
    return record && isValid(record, request) ? record : null;
  }
}
