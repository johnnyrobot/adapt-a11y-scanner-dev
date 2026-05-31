/**
 * Thin ADAPT REST client — just enough to enumerate the questions in an
 * assignment for batch scanning. Uses the service-account JWT as a bearer token.
 * (Node fetch resolves real ADAPT domains directly; for *.localhost dev hosts,
 * scan questions by id instead of listing.)
 */
export interface AdaptQuestionRef {
  id: number | string;
  title?: string;
}

export async function listAssignmentQuestions(
  baseUrl: string,
  token: string,
  assignmentId: number | string,
): Promise<AdaptQuestionRef[]> {
  const res = await fetch(`${baseUrl}/api/assignments/${assignmentId}/get-questions-info`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`ADAPT get-questions-info ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = await res.json();
  // ADAPT nests the list under a few possible keys depending on version.
  const arr: unknown[] = body.questions ?? body.question_info ?? body.data ?? [];
  const refs: (AdaptQuestionRef | null)[] = (Array.isArray(arr) ? arr : []).map((q) => {
    const o = q as Record<string, unknown>;
    const id = o.id ?? o.question_id ?? o.questionId;
    if (id == null) return null;
    return { id: id as number | string, title: o.title ? String(o.title) : undefined };
  });
  return refs.filter((x): x is AdaptQuestionRef => x !== null);
}
