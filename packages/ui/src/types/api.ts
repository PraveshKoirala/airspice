// Shared types for FastAPI backend response payloads and callback parameters.
// Each interface is derived from how the value is consumed in the UI code
// (fields accessed, arrays iterated); see issue #50.

/**
 * A single diagnostic emitted by AIR validation / normalization.
 * `severity` is optional because some payloads (e.g. /normalize-xml
 * diagnostics) only carry code + message.
 */
export interface Diagnostic {
  severity?: string;
  code: string;
  message: string;
}

/**
 * Response payload of POST /validate (also the shape stored for the
 * normalize path: `{ success, diagnostics }`). Read by DiagnosticsPanel
 * as `validation.success` and `validation.diagnostics`.
 */
export interface ValidationResult {
  success: boolean;
  diagnostics?: Diagnostic[];
}

/**
 * One turn of agent conversation history returned by POST /agent/chat as
 * `data.history` and echoed back as the `history` request field. The UI
 * never inspects individual turns, so the internal shape is opaque.
 */
export type ChatHistoryEntry = Record<string, unknown>;

/**
 * The subset of an axios error the UI reads when a request rejects:
 * `error.response?.data?.detail` and `error.message`.
 */
export interface ApiError {
  message?: string;
  response?: {
    data?: {
      detail?: string;
    };
  };
}
