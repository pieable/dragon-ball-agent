import { spawn } from 'node:child_process';

const powershellScript = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Get-Hash([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $raw = $sha.ComputeHash($bytes); return -join ($raw | ForEach-Object { $_.ToString('x2') }) }
  finally { $sha.Dispose() }
}
function Read-AllBytes([System.IO.FileStream]$stream) {
  $stream.Position = 0
  $memory = [System.IO.MemoryStream]::new()
  try { $stream.CopyTo($memory); return ,$memory.ToArray() }
  finally { $memory.Dispose() }
}
$stream = $null
$result = $null
try {
  try {
    $stream = [System.IO.FileStream]::new($payload.path, [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    $nativeCode = $_.Exception.HResult -band 0xffff
    if ($nativeCode -eq 32 -or $nativeCode -eq 33) {
      $result = @{ state = 'busy'; code = 'app_config_writer_busy'; message = 'The App config file is held by another writer.' }
    } else {
      $result = @{ state = 'error'; code = 'app_config_writer_open_failed'; message = 'The App config file could not be opened with an exclusive handle.' }
    }
    throw [System.OperationCanceledException]::new('writer-result')
  }
  $baseline = Read-AllBytes $stream
  $actualHash = Get-Hash $baseline
  if ($actualHash -eq $payload.target_sha256) {
    $result = @{ state = 'already_target'; actual_sha256 = $actualHash }
  } elseif ($actualHash -ne $payload.baseline_sha256) {
    $result = @{ state = 'conflict'; code = 'app_config_external_edit_conflict'; actual_sha256 = $actualHash }
  } else {
    $target = [Convert]::FromBase64String([string]$payload.target_base64)
    if ((Get-Hash $target) -ne $payload.target_sha256) {
      $result = @{ state = 'error'; code = 'app_config_journal_invalid'; message = 'The journal target hash does not match its bytes.' }
      throw [System.OperationCanceledException]::new('writer-result')
    }
    if ($payload.test_hold_after_lock_ms -gt 0) {
      [Console]::Out.WriteLine('{"event":"locked"}')
      [Console]::Out.Flush()
      Start-Sleep -Milliseconds ([int]$payload.test_hold_after_lock_ms)
    }
    $stream.Position = 0
    $stream.Write($target, 0, $target.Length)
    $stream.SetLength($target.Length)
    $stream.Flush($true)
    $verified = Read-AllBytes $stream
    $verifiedHash = Get-Hash $verified
    if ($verifiedHash -ne $payload.target_sha256) {
      $result = @{ state = 'error'; code = 'app_config_write_verification_failed'; actual_sha256 = $verifiedHash }
    } else {
      $result = @{ state = 'written'; actual_sha256 = $verifiedHash }
    }
  }
} catch [System.OperationCanceledException] {
  if ($null -eq $result) { $result = @{ state = 'error'; code = 'app_config_writer_failed'; message = 'The App config writer stopped before verification.' } }
} catch {
  $result = @{ state = 'interrupted'; code = 'app_config_write_interrupted'; message = 'The App config write did not reach verified completion.' }
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
if ($null -eq $result) { $result = @{ state = 'error'; code = 'app_config_writer_failed'; message = 'The App config writer returned no result.' } }
[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 4))
`;

export class AppConfigWriterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppConfigWriterError';
    this.code = code;
    this.stage = 'app_registration_written';
    this.next_action = details.next_action ?? 'Keep the transaction journal and App config bytes; inspect the file state before retrying.';
    Object.assign(this, details);
  }
}

function decodeLines(buffer, callback) {
  let pending = buffer;
  while (true) {
    const newline = pending.indexOf(0x0a);
    if (newline < 0) break;
    const line = pending.subarray(0, newline).toString('utf8').trim();
    pending = pending.subarray(newline + 1);
    if (!line) continue;
    try { callback(JSON.parse(line)); }
    catch { /* malformed child output is reported after exit */ }
  }
  return pending;
}

export async function writeAppConfigTarget({
  path,
  baseline_sha256,
  target_sha256,
  target_bytes,
  intent,
  on_locked,
  test_hold_after_lock_ms = 0,
} = {}) {
  if (process.platform !== 'win32') {
    throw new AppConfigWriterError('app_config_writer_unsupported', 'The exclusive App config writer requires Windows .NET FileStream sharing semantics.', {
      next_action: 'Run apply on Windows; no rename-based or non-Windows fallback is available.',
    });
  }
  if (typeof path !== 'string' || !path || !Buffer.isBuffer(target_bytes) ||
      !/^[a-f0-9]{64}$/.test(target_sha256 ?? '') || !/^[a-f0-9]{64}$/.test(baseline_sha256 ?? '')) {
    throw new AppConfigWriterError('app_config_writer_input_invalid', 'The exclusive App config writer received invalid paths or hashes.');
  }
  if (intent !== undefined && (typeof intent !== 'object' || intent === null || Array.isArray(intent) ||
      typeof intent.sidecar_id !== 'string' || typeof intent.project_id !== 'string' ||
      typeof intent.fields !== 'object' || intent.fields === null || Array.isArray(intent.fields))) {
    throw new AppConfigWriterError('app_config_writer_input_invalid', 'The exclusive App config writer received an invalid journaled intent.');
  }
  const encoded = Buffer.from(powershellScript, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const payload = JSON.stringify({ path, baseline_sha256, target_sha256,
    target_base64: target_bytes.toString('base64'), test_hold_after_lock_ms });
  child.stdin.on('error', () => {});
  child.stdin.end(payload, 'utf8');
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let result;
  child.stdout.on('data', chunk => {
    stdout = Buffer.concat([stdout, chunk]);
    stdout = decodeLines(stdout, event => {
      if (event.event === 'locked') on_locked?.();
      else result = event;
    });
  });
  child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]); });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const finalLine = stdout.toString('utf8').trim();
  if (finalLine) {
    try { const parsed = JSON.parse(finalLine); if (!parsed.event) result = parsed; }
    catch { /* report only a sanitized writer failure below */ }
  }
  if (!result || exitCode !== 0 && result.state === undefined) {
    throw new AppConfigWriterError('app_config_writer_failed', 'The Windows App config writer did not return a structured result.', {
      writer_exit_code: exitCode,
      writer_stderr: stderr.length ? 'nonempty' : 'empty',
    });
  }
  if (result.state === 'busy') {
    throw new AppConfigWriterError('app_config_writer_busy', result.message, { actual_sha256: result.actual_sha256 });
  }
  if (result.state === 'conflict') {
    throw new AppConfigWriterError('app_config_external_edit_conflict', 'The App config changed after the transaction journaled its baseline; no bytes were written.', {
      expected_sha256: baseline_sha256, target_sha256, actual_sha256: result.actual_sha256,
      next_action: 'Preserve the external edit and journal; recalculate the App config target from the current file.',
    });
  }
  if (result.state === 'interrupted' || result.state === 'error') {
    throw new AppConfigWriterError(result.code ?? 'app_config_writer_failed', result.message ?? 'The App config write did not reach verified completion.', {
      expected_sha256: target_sha256, actual_sha256: result.actual_sha256,
    });
  }
  if (!['written', 'already_target'].includes(result.state) || result.actual_sha256 !== target_sha256) {
    throw new AppConfigWriterError('app_config_write_verification_failed', 'The exclusive App config writer did not verify the exact target hash.', {
      expected_sha256: target_sha256, actual_sha256: result.actual_sha256,
    });
  }
  return { state: result.state, target_sha256, actual_sha256: result.actual_sha256 };
}
