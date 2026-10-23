import type { PubgPresentation } from './contracts/pubg.js';
import type { PubgRenderOptions } from './renderers/pubg.js';
import {
  buildPubgComparisonPresentation,
  buildPubgMatchDetailPresentation,
  buildPubgMatchListPresentation,
  buildPubgMatchReviewPresentation,
  buildPubgPeriodReviewPresentation,
  buildPubgPresentation,
  buildPubgStatsPresentation,
  buildPubgStatusPresentation,
  buildPubgTeamDamagePresentation,
  type PubgToolPresentationInput,
} from './builders/pubg.js';
import {
  renderPubgComparison,
  renderPubgMatchDetail,
  renderPubgMatchList,
  renderPubgMatchReview,
  renderPubgPeriodReview,
  renderPubgStats,
  renderPubgStatus,
  renderPubgTeamDamage,
} from './renderers/pubg.js';

export type PubgToolClassification = 'user-facing' | 'intermediate' | 'scheduled';

export type PubgToolName =
  | 'pubg_resolve_players'
  | 'pubg_search_matches'
  | 'pubg_query_stats'
  | 'pubg_compare_stats'
  | 'pubg_get_match'
  | 'pubg_get_review_facts'
  | 'pubg_get_period_review'
  | 'pubg_query_team_damage'
  | 'pubg_prefetch_telemetry'
  | 'pubg_telemetry_sync_report';

export interface PubgPresentationRegistration {
  classification: PubgToolClassification;
  build: (input: PubgToolPresentationInput) => PubgPresentation;
  render: (presentation: PubgPresentation, options?: PubgRenderOptions) => string;
}

function renderStats(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_stats'
    ? renderPubgStats(presentation, options)
    : renderStatus(presentation, options);
}

function renderMatchList(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_match_list'
    ? renderPubgMatchList(presentation, options)
    : renderStatus(presentation, options);
}

function renderComparison(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_comparison'
    ? renderPubgComparison(presentation, options)
    : renderStatus(presentation, options);
}

function renderMatchDetail(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_match_detail'
    ? renderPubgMatchDetail(presentation, options)
    : renderStatus(presentation, options);
}

function renderReview(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_match_review'
    ? renderPubgMatchReview(presentation, options)
    : renderStatus(presentation, options);
}

function renderPeriodReview(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_period_review'
    ? renderPubgPeriodReview(presentation, options)
    : renderStatus(presentation, options);
}

function renderTeamDamage(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return presentation.type === 'pubg_team_damage'
    ? renderPubgTeamDamage(presentation, options)
    : renderStatus(presentation, options);
}

function renderStatus(presentation: PubgPresentation, options?: PubgRenderOptions): string {
  return renderPubgStatus(
    presentation.type === 'pubg_status'
      ? presentation
      : buildPubgStatusPresentation({
          data: {},
          dataUpdatedAt: presentation.dataUpdatedAt,
          status: presentation.status,
        }),
    options,
  );
}

/**
 * This is the single coverage registry for native PUBG tools. The plugin and
 * architecture check both consume the same named mapping rather than keeping
 * scattered per-tool presentation conditionals.
 */
export const PUBG_PRESENTATION_REGISTRY: Record<PubgToolName, PubgPresentationRegistration> = {
  pubg_resolve_players: {
    classification: 'intermediate',
    build: buildPubgStatusPresentation,
    render: renderStatus,
  },
  pubg_search_matches: {
    classification: 'user-facing',
    build: buildPubgPresentation,
    render: renderMatchList,
  },
  pubg_query_stats: {
    classification: 'user-facing',
    build: buildPubgStatsPresentation,
    render: renderStats,
  },
  pubg_compare_stats: {
    classification: 'user-facing',
    build: buildPubgComparisonPresentation,
    render: renderComparison,
  },
  pubg_get_match: {
    classification: 'user-facing',
    build: buildPubgMatchDetailPresentation,
    render: renderMatchDetail,
  },
  pubg_get_review_facts: {
    classification: 'user-facing',
    build: buildPubgPresentation,
    render: renderReview,
  },
  pubg_get_period_review: {
    classification: 'user-facing',
    build: buildPubgPresentation,
    render: renderPeriodReview,
  },
  pubg_query_team_damage: {
    classification: 'user-facing',
    build: buildPubgTeamDamagePresentation,
    render: renderTeamDamage,
  },
  pubg_prefetch_telemetry: {
    classification: 'scheduled',
    build: buildPubgStatusPresentation,
    render: renderStatus,
  },
  pubg_telemetry_sync_report: {
    classification: 'scheduled',
    build: buildPubgStatusPresentation,
    render: renderStatus,
  },
};

export const PUBG_USER_FACING_TOOLS = Object.entries(PUBG_PRESENTATION_REGISTRY)
  .filter(([, registration]) => registration.classification === 'user-facing')
  .map(([name]) => name as PubgToolName);

export function buildPubgToolPresentation(
  toolName: string,
  input: Omit<PubgToolPresentationInput, 'toolName'>,
  options: PubgRenderOptions = {},
): { presentation: PubgPresentation; displayText: string } {
  const registration = PUBG_PRESENTATION_REGISTRY[toolName as PubgToolName];
  const enriched = { ...input, toolName };
  if (!registration) {
    const presentation = buildPubgStatusPresentation({
      ...enriched,
      status: input.status ?? 'error',
      error: {
        code: 'presentation_mapping_missing',
        reason: `No presentation mapping for ${toolName}`,
      },
    });
    return { presentation, displayText: renderPubgStatus(presentation, options) };
  }
  const presentation = registration.build(enriched);
  return { presentation, displayText: registration.render(presentation, options) };
}
