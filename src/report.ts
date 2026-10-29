/**
 * Fail-closed run summary + exit-code decision (MF-2).
 *
 * The CLI's purpose is to gate CI on accessibility problems. The exit code must
 * therefore fail CLOSED: a run exits non-zero if ANY question was not-passed by
 * the validator, carried error-severity findings, or failed to render/scan at
 * all. It exits 0 only when every attempted question genuinely passed. This is
 * what defeats the old fail-open bugs (H1 severity gate, H2 swallowed failures,
 * M4 silent zero-findings) in one place.
 */
import type { QuestionScanResult } from './types.js';

export interface RunSummary {
  totals: {
    errors: number;
    warnings: number;
    scanned: number;
    failed: number;
    notPassed: number;
  };
  exitCode: number;
  outcome?: 'no_work';
  message?: string;
}

export function summarize(results: QuestionScanResult[]): RunSummary {
  const totals = results.reduce(
    (acc, r) => {
      acc.errors += r.stats.errors;
      acc.warnings += r.stats.warnings;
      if (r.failed) acc.failed += 1;
      else {
        acc.scanned += 1;
        if (!r.overallPassed) acc.notPassed += 1;
      }
      return acc;
    },
    { errors: 0, warnings: 0, scanned: 0, failed: 0, notPassed: 0 },
  );

  if (results.length === 0) {
    return { totals, exitCode: 1, outcome: 'no_work', message: 'No questions were available to scan.' };
  }
  const clean = totals.failed === 0 && totals.notPassed === 0 && totals.errors === 0;
  return { totals, exitCode: clean ? 0 : 1 };
}
