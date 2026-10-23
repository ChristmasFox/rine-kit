import type { FunEvent, MatchReviewFacts } from './types.js';
import { EventCombinationEngine } from './event-combination-engine.js';
import { generateBaseFunEvents } from './fun-event-generator.js';
import { FunRanker } from './fun-ranker.js';

export interface FunIntelligenceOptions {
  limit?: number;
  combinationEngine?: EventCombinationEngine;
}
export class FunIntelligence {
  private readonly limit: number;
  private readonly combinationEngine: EventCombinationEngine;

  constructor(options: FunIntelligenceOptions = {}) {
    this.limit = Math.max(0, options.limit ?? 5);
    this.combinationEngine = options.combinationEngine ?? new EventCombinationEngine();
  }

  analyze(facts: MatchReviewFacts): FunEvent[] {
    const baseEvents = generateBaseFunEvents(facts);
    const combined = this.combinationEngine.combine(facts, baseEvents);
    return new FunRanker({ limit: this.limit }).rank([...baseEvents, ...combined]);
  }
}

export function generateFunEvents(facts: MatchReviewFacts, limit = 5): FunEvent[] {
  return new FunIntelligence({ limit }).analyze(facts);
}
