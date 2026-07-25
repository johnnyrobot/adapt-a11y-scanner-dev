/**
 * Thin ADAPT REST client — just enough to enumerate the questions in an
 * assignment for batch scanning. Uses the service-account JWT as a bearer token.
 * (Node fetch resolves real ADAPT domains directly; for *.localhost dev hosts,
 * scan questions by id instead of listing.)
 */
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
): Promise<AdaptQuestionRef[]> {
  // Without a signal this request can hang indefinitely on a stalled ADAPT
  // endpoint, stalling the whole assignment batch — and, because the caller
  // runs it inside a try/finally, delaying renderer.close() with it.
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/assignments/${assignmentId}/get-questions-info`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`ADAPT get-questions-info timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`ADAPT get-questions-info ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = parseJsonStrict(await res.text(), 'ADAPT get-questions-info') as Record<string, unknown>;
  // ADAPT nests the list under a few possible keys depending on version.
  const arr = (body.questions ?? body.question_info ?? body.data ?? []) as unknown[];
  const refs: (AdaptQuestionRef | null)[] = (Array.isArray(arr) ? arr : []).map((q) => {
    const o = q as Record<string, unknown>;
    const id = o.id ?? o.question_id ?? o.questionId;
    if (id == null) return null;
    return { id: id as number | string, title: o.title ? String(o.title) : undefined };
  });
  return refs.filter((x): x is AdaptQuestionRef => x !== null);
}
