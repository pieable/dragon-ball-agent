export function parentIsAlive(parentPid, probe = process.kill) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('Expected a valid App owner PID');
  try { probe(parentPid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error; // Access/OS errors are not evidence that the owner exited.
  }
}
