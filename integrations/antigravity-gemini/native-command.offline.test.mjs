import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { runNativeCommand } from './native-command.mjs';

function fakeChild(kill) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = kill;
  child.unref = () => { child.unreferenced = true; };
  return child;
}

test('a timeout with kill=false and no close settles within the second budget as unknown', async () => {
  const child = fakeChild(() => false);
  const started = Date.now();
  const result = await runNativeCommand('fake-agentapi', ['send-message'], {
    timeoutMs: 15,
    settleGraceMs: 25,
    spawnImpl: () => child,
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(result.response, null);
  assert.equal(result.stdout, null);
  assert.equal(result.evidence.timed_out, true);
  assert.equal(result.evidence.termination_requested, true);
  assert.equal(result.evidence.termination_result, false);
  assert.equal(result.evidence.close_observed, false);
  assert.equal(result.evidence.settlement_timed_out, true);
  assert.equal(child.unreferenced, true);
});

test('a timeout whose kill throws still settles without claiming process exit', async () => {
  const child = fakeChild(() => { throw new Error('denied'); });
  const result = await runNativeCommand('fake-agentapi', ['get-conversation-metadata'], {
    timeoutMs: 10,
    settleGraceMs: 15,
    spawnImpl: () => child,
  });
  assert.equal(result.evidence.timed_out, true);
  assert.equal(result.evidence.termination_error, true);
  assert.equal(result.evidence.close_observed, false);
  assert.equal(result.evidence.settlement_timed_out, true);
  assert.equal(result.evidence.exit_code, null);
});

test('a close after timeout is observed but the command response remains untrusted', async () => {
  const child = fakeChild(() => {
    child.stdout.end(JSON.stringify({ error: 'transport timed out', payload: null }));
    setTimeout(() => child.emit('close', 1, 'SIGTERM'), 0);
    return true;
  });
  const result = await runNativeCommand('fake-agentapi', ['send-message'], {
    timeoutMs: 10,
    settleGraceMs: 100,
    spawnImpl: () => child,
  });
  assert.equal(result.evidence.timed_out, true);
  assert.equal(result.evidence.close_observed, true);
  assert.equal(result.evidence.exit_code, 1);
  assert.equal(result.response, null);
  assert.equal(result.evidence.native_error, 'transport timed out');
  assert.equal(result.evidence.native_rejected, false);
});

test('a clean native response still parses after close', async () => {
  const child = fakeChild(() => true);
  const resultPromise = runNativeCommand('fake-agentapi', ['get-conversation-metadata'], {
    timeoutMs: 100,
    settleGraceMs: 10,
    spawnImpl: () => {
      setImmediate(() => {
        child.stdout.end(JSON.stringify({ response: { conversationMetadata: { id: 'fixture' } } }));
        child.stderr.end();
        setImmediate(() => child.emit('close', 0, null));
      });
      return child;
    },
  });
  const result = await resultPromise;
  assert.equal(result.evidence.close_observed, true);
  assert.equal(result.evidence.timed_out, false);
  assert.deepEqual(result.response, { conversationMetadata: { id: 'fixture' } });
});

async function nativeFixture(stdout, stderr = '', exitCode = 1, options = {}) {
  const child = fakeChild(() => true);
  return runNativeCommand('fake-agentapi', ['new-conversation'], {
    timeoutMs: 100,
    ...options,
    spawnImpl: () => {
      setImmediate(() => {
        child.stdout.end(stdout);
        child.stderr.end(stderr);
        setImmediate(() => child.emit('close', exitCode, null));
      });
      return child;
    },
  });
}

test('an explicit native rejection preserves the provider error without a success response', async () => {
  const message = 'no available model for "gemini-4-argon-high"';
  const result = await nativeFixture(JSON.stringify({ error: message, payload: null }));
  assert.equal(result.response, null);
  assert.equal(result.evidence.native_error, message);
  assert.equal(result.evidence.native_rejected, true);
  const zeroExitError = await nativeFixture(JSON.stringify({ error: { message }, response: null }), '', 0);
  assert.equal(zeroExitError.response, null);
  assert.equal(zeroExitError.evidence.native_error, message);
  assert.equal(zeroExitError.evidence.native_rejected, true);
});

test('diagnostic errors never certify rejection after partial or ambiguous output', async () => {
  const result = await nativeFixture(JSON.stringify({ error: 'post-send failure', response: { sendMessage: {} } }));
  assert.equal(result.evidence.native_error, 'post-send failure');
  assert.equal(result.evidence.native_rejected, false);
  assert.equal(result.response, null);
  const malformed = await nativeFixture('broken json', 'native transport closed');
  assert.equal(malformed.evidence.native_rejected, false);
  assert.equal(malformed.evidence.stderr_text, 'native transport closed');
});

test('diagnostic text redacts credentials and bounds stderr capture', async () => {
  const result = await nativeFixture(JSON.stringify({ error: 'Authorization: Bearer secret-value api_key=private-value' }),
    'token=private-token password="private password" sk-secretvalue123456789');
  assert.ok(!result.evidence.native_error.includes('secret-value'));
  assert.ok(!result.evidence.native_error.includes('private-value'));
  assert.ok(!result.evidence.stderr_text.includes('private-token'));
  assert.ok(!result.evidence.stderr_text.includes('private password'));
  assert.ok(!result.evidence.stderr_text.includes('sk-secretvalue'));
  const large = await nativeFixture('{}', 'x'.repeat(100), 1, { captureLimitBytes: 20 });
  assert.equal(large.evidence.stderr_truncated, true);
  assert.equal(large.evidence.stderr_text, null);
});
