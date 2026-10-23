import { chmodSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from './intent.js';
import type { EvaluationExperimentReport } from './evaluation.js';

interface Statement {
  run(...values: unknown[]): unknown;
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
}

interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => Database };

export interface StoredResearchRun {
  question: string;
  intent: unknown;
  source: string;
  report: unknown;
  assistant?: unknown;
}

export type EvaluationReviewLabel = 'confirm' | 'reject' | 'unresolved' | 'wrong_evidence';
export type BattleReviewLabel = 'correct' | 'insufficient_inference' | 'wrong' | 'unknown';

export interface EvaluationRunSummary {
  runId: string;
  createdAt: string;
  experimentName: string;
  datasetFingerprint: string;
  candidateVersion: string;
  caseCount: number;
  runtimeMs: number;
  reviewedLabels: number;
}

export interface EvaluationReview {
  caseId: string;
  ruleId: string;
  label: EvaluationReviewLabel;
  createdAt: string;
}

export interface BattleReview {
  matchId: string;
  battleId: string;
  label: BattleReviewLabel;
  createdAt: string;
}

interface EvaluationRunRow {
  run_id: string;
  created_at: string;
  report_json: string;
  reviewed_labels?: number;
}

/** Persistent experiment output lives outside the production PUBG database. */
export class ExperimentRunStore {
  private readonly db: Database;

  constructor(readonly filename: string) {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_runs (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        question TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        planner_source TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_research_runs_created ON research_runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS battle_reviews (
        match_id TEXT NOT NULL,
        battle_id TEXT NOT NULL,
        label TEXT NOT NULL CHECK (label IN ('correct', 'insufficient_inference', 'wrong', 'unknown')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (match_id, battle_id)
      );
      CREATE TABLE IF NOT EXISTS evaluation_experiments (
        run_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        experiment_name TEXT NOT NULL,
        dataset_fingerprint TEXT NOT NULL,
        candidate_version TEXT NOT NULL,
        case_count INTEGER NOT NULL,
        runtime_ms REAL NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_evaluation_experiments_created ON evaluation_experiments(created_at DESC);
      CREATE TABLE IF NOT EXISTS evaluation_reviews (
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        label TEXT NOT NULL CHECK (label IN ('confirm', 'reject', 'unresolved', 'wrong_evidence')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, case_id, rule_id),
        FOREIGN KEY (run_id) REFERENCES evaluation_experiments(run_id) ON DELETE CASCADE
      );
    `);
  }

  save(run: StoredResearchRun): string {
    const id = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO research_runs(run_id, created_at, question, intent_json, planner_source, report_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        new Date().toISOString(),
        redactSensitiveText(run.question),
        JSON.stringify(run.intent),
        run.source,
        JSON.stringify({ report: run.report, assistant: run.assistant ?? null }),
      );
    return id;
  }

  saveEvaluation(report: EvaluationExperimentReport): string {
    const runId = randomUUID();
    this.db
      .prepare(
        `
      INSERT INTO evaluation_experiments(run_id, created_at, experiment_name, dataset_fingerprint, candidate_version, case_count, runtime_ms, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        runId,
        report.provenance.startedAt,
        report.experimentName,
        report.dataset.fingerprint,
        report.algorithm.candidateVersion,
        report.dataset.caseCount,
        report.provenance.runtimeMs,
        JSON.stringify(report),
      );
    return runId;
  }

  listEvaluations(limit = 20): EvaluationRunSummary[] {
    const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `
      SELECT e.run_id, e.created_at, e.experiment_name, e.dataset_fingerprint, e.candidate_version, e.case_count, e.runtime_ms,
        (SELECT COUNT(*) FROM evaluation_reviews r WHERE r.run_id = e.run_id) AS reviewed_labels
      FROM evaluation_experiments e ORDER BY e.created_at DESC, e.run_id DESC LIMIT ?
    `,
      )
      .all(bounded) as Array<{
      run_id: string;
      created_at: string;
      experiment_name: string;
      dataset_fingerprint: string;
      candidate_version: string;
      case_count: number;
      runtime_ms: number;
      reviewed_labels: number;
    }>;
    return rows.map((row) => ({
      runId: row.run_id,
      createdAt: row.created_at,
      experimentName: row.experiment_name,
      datasetFingerprint: row.dataset_fingerprint,
      candidateVersion: row.candidate_version,
      caseCount: row.case_count,
      runtimeMs: row.runtime_ms,
      reviewedLabels: row.reviewed_labels,
    }));
  }

  getEvaluation(runId: string): EvaluationExperimentReport | null {
    const row = this.db
      .prepare('SELECT report_json FROM evaluation_experiments WHERE run_id = ?')
      .get(runId) as { report_json?: string } | undefined;
    if (!row?.report_json) return null;
    return JSON.parse(row.report_json) as EvaluationExperimentReport;
  }

  saveEvaluationReview(input: {
    runId: string;
    caseId: string;
    ruleId: string;
    label: EvaluationReviewLabel;
  }): EvaluationReview {
    const report = this.getEvaluation(input.runId);
    if (!report) throw new Error('evaluation_run_not_found');
    if (
      input.ruleId !== report.algorithm.ruleId ||
      !report.caseOutcomes.some((row) => row.caseId === input.caseId)
    ) {
      throw new Error('evaluation_review_outside_run');
    }
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO evaluation_reviews(run_id, case_id, rule_id, label, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, case_id, rule_id) DO UPDATE SET label = excluded.label, created_at = excluded.created_at
    `,
      )
      .run(input.runId, input.caseId, input.ruleId, input.label, createdAt);
    return { caseId: input.caseId, ruleId: input.ruleId, label: input.label, createdAt };
  }

  listEvaluationReviews(runId: string): EvaluationReview[] {
    return (
      this.db
        .prepare(
          `
      SELECT case_id, rule_id, label, created_at FROM evaluation_reviews WHERE run_id = ? ORDER BY case_id, rule_id
    `,
        )
        .all(runId) as Array<{
        case_id: string;
        rule_id: string;
        label: EvaluationReviewLabel;
        created_at: string;
      }>
    ).map((row) => ({
      caseId: row.case_id,
      ruleId: row.rule_id,
      label: row.label,
      createdAt: row.created_at,
    }));
  }

  saveBattleReview(input: {
    matchId: string;
    battleId: string;
    label: BattleReviewLabel;
  }): BattleReview {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO battle_reviews(match_id, battle_id, label, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(match_id, battle_id) DO UPDATE SET label = excluded.label, created_at = excluded.created_at
    `,
      )
      .run(input.matchId, input.battleId, input.label, createdAt);
    return { ...input, createdAt };
  }

  listBattleReviews(matchId: string): BattleReview[] {
    return (
      this.db
        .prepare(
          `
      SELECT match_id, battle_id, label, created_at FROM battle_reviews WHERE match_id = ? ORDER BY battle_id
    `,
        )
        .all(matchId) as Array<{
        match_id: string;
        battle_id: string;
        label: BattleReviewLabel;
        created_at: string;
      }>
    ).map((row) => ({
      matchId: row.match_id,
      battleId: row.battle_id,
      label: row.label,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
