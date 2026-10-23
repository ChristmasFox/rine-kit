import type { FunConfidence, FunEvent } from './types.js';

export interface FunRankerOptions {
  limit?: number;
  visibleConfidences?: FunConfidence[];
}

function compareEvents(left: FunEvent, right: FunEvent): number {
  return (
    right.funScore - left.funScore ||
    right.evidenceIds.length - left.evidenceIds.length ||
    left.type.localeCompare(right.type) ||
    (left.actorPlayerId ?? '').localeCompare(right.actorPlayerId ?? '') ||
    left.id.localeCompare(right.id)
  );
}

/** Rank structured events, hide heuristic output, and apply explicit suppression. */
export class FunRanker {
  private readonly limit: number;
  private readonly visibleConfidences: Set<FunConfidence>;

  constructor(options: FunRankerOptions = {}) {
    this.limit = Math.max(0, options.limit ?? 5);
    this.visibleConfidences = new Set(options.visibleConfidences ?? ['CONFIRMED', 'DERIVED']);
  }

  rank(events: FunEvent[]): FunEvent[] {
    const candidates = [...events]
      .filter((event) => this.visibleConfidences.has(event.confidence))
      .filter((event) => event.factIds.length > 0 && event.evidenceIds.length > 0)
      .sort(compareEvents);
    const selected: FunEvent[] = [];
    const suppressedTypes = new Set<string>();
    const suppressedGroups = new Set<string>();
    const selectedActors = new Set<string>();
    const selectedTypes = new Set<string>();
    const seenIds = new Set<string>();

    const add = (event: FunEvent): void => {
      if (
        selected.length >= this.limit ||
        seenIds.has(event.id) ||
        suppressedTypes.has(event.type) ||
        (event.dedupGroup && suppressedGroups.has(event.dedupGroup))
      )
        return;
      selected.push(event);
      seenIds.add(event.id);
      if (event.actorPlayerId) selectedActors.add(event.actorPlayerId);
      selectedTypes.add(event.type);
      if (event.dedupGroup) suppressedGroups.add(event.dedupGroup);
      for (const type of event.suppresses ?? []) suppressedTypes.add(type);
      if (event.suppresses?.some((value) => value.startsWith('GROUP:'))) {
        for (const value of event.suppresses.filter((item) => item.startsWith('GROUP:')))
          suppressedGroups.add(value.slice('GROUP:'.length));
      }
    };

    // First pass favors different players and event types for a readable group card.
    for (const event of candidates) {
      if (selected.length >= this.limit) break;
      if (event.actorPlayerId && selectedActors.has(event.actorPlayerId)) continue;
      if (selectedTypes.has(event.type)) continue;
      add(event);
    }
    for (const event of candidates) {
      if (selected.length >= this.limit) break;
      add(event);
    }
    return selected;
  }
}

export function rankFunEvents(events: FunEvent[], limit = 5): FunEvent[] {
  return new FunRanker({ limit }).rank(events);
}
