/** A single accessibility finding (shape mirrors remedy-core output). */
export interface Finding {
  ruleId: string;
  wcag?: string;
  severity: 'error' | 'warning' | 'info' | string;
  message: string;
  selector?: string;
  snippet?: string;
  fixable?: boolean;
  source?: string;
}

/** Result of scanning one ADAPT question. */
export interface QuestionScanResult {
  questionId: number | string;
  assignmentId?: number | string;
  renderedUrl: string;
  capturedBytes: number;
  scannedAt: string;
  findings: Finding[];
  /** The validator's authoritative verdict for this question (fail-closed). */
  overallPassed: boolean;
  /** True when the question could not be rendered/scanned (render/network/auth). */
  failed: boolean;
  stats: { errors: number; warnings: number; total: number };
  error?: string;
}
