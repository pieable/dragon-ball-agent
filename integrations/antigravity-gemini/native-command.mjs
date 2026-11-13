import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { runtimeConfig } from './runtime-config.mjs';

// Diagnostics are persisted by callers; never copy credential values into them.
function diagnosticText(value) {
  if (typeof value !== 'string') return null;
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie|csrf[_-]?token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

/** Run one native App CLI command with bounded response and settlement budgets. */
export function runNativeCommand(file, args, {
  timeoutMs = runtimeConfig.nativeCommandTimeoutMs,
  settleGraceMs = runtimeConfig.nativeCommandSettleGraceMs,
  captureLimitBytes = runtimeConfig.nativeResponseLimitBytes,
  spawnImpl = nodeSpawn,
} = {}) {
  if (typeof file !== 'string' || !file || !Array.isArray(args) || !args.every(value => typeof value === 'string')) {
    throw new Error('Invalid native command invocation.');
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ evidence: { exit_code: null, signal: null, spawn_error: true, timed_out: false,
        close_observed: false, termination_requested: false,
        settlement_timed_out: false, stdout_bytes: 0, stdout_sha256: createHash('sha256').digest('hex'),
        stderr_bytes: 0, stderr_sha256: createHash('sha256').digest('hex'), response_truncated: false,
        native_error: null, native_rejected: false, stderr_text: null, stderr_truncated: false },
      stdout: null, response: null });
      return;
    }

    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnError = false;
    let timedOut = false;
    let responseTruncated = false;
    let stderrTruncated = false;
    let closeObserved = false;
    let terminationRequested = false;
    let terminationError = false;
    let terminationResult = null;
    let settlementTimedOut = false;
    let settled = false;
    let commandTimer;
    let settleTimer;

    const settle = (exitCode, signal, observedClose) => {
      if (settled) return;
      settled = true;
      closeObserved = observedClose;
      clearTimeout(commandTimer);
      clearTimeout(settleTimer);
      const stdout = responseTruncated || !observedClose ? null : Buffer.concat(stdoutChunks);
      const stderrText = stderrTruncated ? null : diagnosticText(Buffer.concat(stderrChunks).toString('utf8'));
      let response = null;
      let envelope = null;
      if (observedClose && stdout) {
        try { envelope = JSON.parse(stdout.toString('utf8')); }
        catch { /* Invalid JSON is evidence of no verified acknowledgement. */ }
      }
      const rawError = typeof envelope?.error === 'string' ? envelope.error : envelope?.error?.message;
      const nativeError = diagnosticText(rawError)?.trim() || null;
      // This records an explicit provider rejection, not an inference from exit code or stderr.
      const nativeRejected = Boolean(observedClose && !spawnError && !timedOut && nativeError &&
        envelope?.response == null && envelope?.payload == null);
      if (observedClose && !spawnError && !timedOut && exitCode === 0 && !nativeError) {
        response = envelope?.response ?? null;
      }
      if (!observedClose) {
        try { child.stdout?.destroy(); } catch { /* The pipe may already be closed. */ }
        try { child.stderr?.destroy(); } catch { /* The pipe may already be closed. */ }
        try { child.unref?.(); } catch { /* Do not extend this local wait. */ }
      }
      resolve({ evidence: { exit_code: exitCode, signal, spawn_error: spawnError, timed_out: timedOut,
        close_observed: closeObserved, termination_requested: terminationRequested,
        termination_error: terminationError,
        termination_result: terminationResult, settlement_timed_out: settlementTimedOut,
        stdout_bytes: stdoutBytes, stdout_sha256: stdoutHash.digest('hex'), stderr_bytes: stderrBytes,
        stderr_sha256: stderrHash.digest('hex'), response_truncated: responseTruncated,
        native_error: nativeError, native_rejected: nativeRejected,
        stderr_text: stderrText || null, stderr_truncated: stderrTruncated }, stdout, response });
    };

    child.stdout?.on('data', chunk => {
      if (settled) return;
      stdoutBytes += chunk.length;
      stdoutHash.update(chunk);
      if (stdoutBytes <= captureLimitBytes) stdoutChunks.push(chunk);
      else { responseTruncated = true; stdoutChunks.length = 0; }
    });
    child.stderr?.on('data', chunk => {
      if (settled) return;
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
      if (stderrBytes <= captureLimitBytes) stderrChunks.push(chunk);
      else { stderrTruncated = true; stderrChunks.length = 0; }
    });
    child.on('error', () => {
      spawnError = true;
      if (!timedOut) return settle(null, null, false);
      // A kill error after the command budget still has unknown delivery state.
      terminationError = true;
    });
    child.on('close', (exitCode, signal) => settle(exitCode, signal, true));

    commandTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminationRequested = true;
      try { terminationResult = child.kill(); }
      catch { terminationError = true; }
      settleTimer = setTimeout(() => {
        if (settled) return;
        settlementTimedOut = true;
        settle(null, null, false);
      }, settleGraceMs);
    }, timeoutMs);
  });
}
