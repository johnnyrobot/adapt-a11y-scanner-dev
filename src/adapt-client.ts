/**
 * Thin ADAPT REST client — just enough to enumerate the questions in an
 * assignment for batch scanning. Uses the service-account JWT as a bearer token.
 * (Node fetch resolves real ADAPT domains directly; for *.localhost dev hosts,
 * scan questions by id instead of listing.)
 */
import { withRequestSignal } from './lifecycle.js';
import { parseJsonStrict } from './scanner.js';

export interface AdaptQuestionRef {
  id: number | string;
  title?: string;
}

export async function listAssignmentQuestions(
  baseUrl: string,
  token: string,
  assignmentId: number | string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<AdaptQuestionRef[]> {
  signal?.throwIfAborted();
  if (!positiveId(assignmentId)) throw new Error('ADAPT assignment id must be a positive integer');
  // Without a signal this request can hang indefinitely on a stalled ADAPT
  // endpoint, stalling the whole assignment batch — and, because the caller
  // runs it inside a try/finally, delaying renderer.close() with it.
  let res: Response;
  let text: string;
  try {
    ({ res, text } = await withRequestSignal(timeoutMs, signal, async attemptSignal => {
      const res = await fetch(`${baseUrl}/api/assignments/${assignmentId}/questions/ids`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: attemptSignal,
      });
      return { res, text: await res.text() };
    }));
  } catch (e) {
    signal?.throwIfAborted();
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`ADAPT questions/ids timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`ADAPT questions/ids ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = parseJsonStrict(text, 'ADAPT questions/ids');
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('ADAPT questions/ids contract: expected an object');
  }
  const b = body as Record<string, unknown>;
  if (b.type !== 'success' || !Array.isArray(b.question_ids_array)) {
    throw new Error('ADAPT questions/ids contract: expected type=success and question_ids_array');
  }
  // Source snapshot ee9478b: question_ids is a JSON-encoded legacy duplicate.
  // Never infer an empty list from missing data or silently discard bad IDs.
  return b.question_ids_array.map(id => {
    if (!positiveId(id)) throw new Error('ADAPT questions/ids contract: invalid positive integer question id');
    return { id };
  });
}

function positiveId(id: unknown): id is number | string {
  return typeof id === 'number'
    ? Number.isSafeInteger(id) && id > 0
    : typeof id === 'string' && /^[0-9]+$/.test(id) && /[1-9]/.test(id);
}
