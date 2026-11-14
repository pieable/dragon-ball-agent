export async function withActiveParent(state, parent, create) {
  if (!parent) return create();
  return state.exclusive(parent.agent_id, async () => {
    if (['cancelling','cancelled','closed','interrupted'].includes(parent.state)) throw new Error('Parent is no longer accepting child work');
    return create();
  });
}
// Delivery cannot be part of the child monitor a parent awaits during cancellation.
export function queueNotification(pending, key, work, onError) {
  if (pending.has(key)) return;
  const task = Promise.resolve().then(work).catch(onError).finally(() => pending.delete(key));
  pending.set(key, task);
}
