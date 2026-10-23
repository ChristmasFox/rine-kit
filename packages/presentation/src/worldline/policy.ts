import type { WorldlineNotificationIntent, WorldlineTheme } from './contracts.js';

function has(kind: string, ...values: string[]): boolean {
  return values.includes(kind);
}

export function selectWorldlineTheme(intent: WorldlineNotificationIntent): WorldlineTheme {
  const kind = intent.kind.trim().toLowerCase();

  if (has(kind, 'operation', 'migration', 'migration_readiness', 'readiness', 'skuld'))
    return 'operation_skuld';
  if (has(kind, 'rollback', 'restore', 'recovery_checkpoint')) return 'time_leap';
  if (has(kind, 'critical_dependency', 'dependency_failure')) return 'ibn_5100';
  if (has(kind, 'state_drift', 'config_drift', 'identity_drift')) return 'reading_steiner';
  const occurrenceCount = intent.correlation?.occurrenceCount ?? intent.occurrenceCount;
  if (occurrenceCount !== undefined && occurrenceCount >= 3 && intent.severity !== 'success')
    return 'attractor_field';
  if (
    has(kind, 'confirmed_compromise', 'security_incident') &&
    intent.severity === 'error' &&
    intent.significance === 'critical'
  )
    return 'sern_alert';
  if (has(kind, 'security_scan', 'security_probe', 'auth_anomaly', 'probe'))
    return 'rounder_activity';
  if (has(kind, 'scheduled_report', 'telemetry_sync', 'market_report', 'heartbeat', 'daily_report'))
    return 'dmail';
  if (
    has(kind, 'release', 'deployment', 'source_recovered', 'operation_completed') &&
    intent.severity === 'success'
  )
    return 'worldline_convergence';
  if (
    has(
      kind,
      'price_changed',
      'status_changed',
      'network_degraded',
      'source_degraded',
      'dependency_degraded',
      'delivery_failed',
    )
  )
    return 'worldline_divergence';
  return 'worldline_observation';
}
