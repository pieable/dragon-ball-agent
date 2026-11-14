export const EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
export function normalizeEffort(value) {
  const effort = value === 'none' ? 'off' : value;
  if (!EFFORTS.includes(effort)) throw new Error('Unsupported reasoning effort');
  return effort;
}
export function selectionFor(record, effort = record.reasoning_effort) {
  return { provider: record.provider ?? 'luna-api', model: 'gpt-6-luna', reasoningEffort: normalizeEffort(effort) };
}
