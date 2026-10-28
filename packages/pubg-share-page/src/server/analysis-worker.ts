import { parentPort } from 'node:worker_threads';
import type { NormalizedMatch } from '@rine-kit/pubg-domain';
import { analyzeMatchStory } from '@rine-kit/pubg-intelligence';
import { RawTelemetryArchive } from '@rine-kit/pubg-intelligence/archive';
import { computeMatchAnalysis } from './match-analysis.js';

interface AnalysisTask {
  kind: 'analysis' | 'story';
  archiveDirectory: string;
  match: NormalizedMatch;
  memberIds: string[];
}

/** Reads one archived payload and derives either the per-match analysis or the match story; 'missing' = no archive entry. */
parentPort!.on('message', async (task: AnalysisTask) => {
  try {
    const payload = await new RawTelemetryArchive(task.archiveDirectory).read(task.match.matchId);
    if (!payload) {
      parentPort!.postMessage({ ok: true, result: 'missing' });
      return;
    }
    const result =
      task.kind === 'story'
        ? analyzeMatchStory(payload, new Set(task.memberIds))
        : computeMatchAnalysis(payload, task.match, task.memberIds);
    parentPort!.postMessage({ ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'analysis_failed',
    });
  }
});
