import { PubgApiError, type ToolEnvelope } from '@rine-kit/pubg-domain';

const PLUGIN_ID = 'pubg';

function failure(
  queryResolved: Record<string, unknown>,
  calculation: string,
  error: { code: string; retryable: boolean; reason: string },
  sourceUnavailable: boolean,
): ToolEnvelope {
  const now = new Date().toISOString();
  return {
    status: 'error',
    data: {},
    coverage: {
      status: 'SOURCE_UNAVAILABLE',
      complete: false,
      coverageStart: null,
      coverageEnd: null,
      checkedAt: now,
      failedMatchIds: [],
      sourceUnavailable,
      freshness: 'unknown',
    },
    asOf: now,
    metricVersion: 'pubg-metrics-v1',
    queryResolved,
    evidenceRefs: { matchIds: [], playerIds: [], fields: [], calculation },
    error,
  };
}

/** The question cannot be answered because nobody (or the wrong people) could be identified. */
export function subjectError(code: string, reason: string): ToolEnvelope {
  return failure(
    { tool: PLUGIN_ID, identity: 'required' },
    'identity_resolution',
    { code, retryable: false, reason },
    false,
  );
}

/** The model's arguments did not match the tool's contract. */
export function invalidInputError(reason: string): ToolEnvelope {
  return failure(
    { tool: PLUGIN_ID },
    'input_validation',
    { code: 'invalid_input', retryable: false, reason: reason.slice(0, 512) },
    false,
  );
}

/** Configuration or upstream failure while running a tool; details of unexpected errors are not exposed. */
export function runtimeError(error: unknown): ToolEnvelope {
  const details =
    error instanceof PubgApiError
      ? { code: error.code, retryable: error.retryable, reason: error.message }
      : {
          code: 'plugin_runtime_error',
          retryable: false,
          reason: 'PUBG plugin configuration or execution failed',
        };
  return failure({ tool: PLUGIN_ID }, 'pubg_plugin_runtime', details, true);
}
