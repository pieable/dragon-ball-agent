param(
    [Parameter(Mandatory = $true)]
    [string]$StateDirectory
)

$ErrorActionPreference = 'Stop'

try {
    $resolvedStateDirectory = (Resolve-Path -LiteralPath $StateDirectory).Path
    if (-not (Test-Path -LiteralPath $resolvedStateDirectory -PathType Container)) {
        throw "StateDirectory must be an existing directory: $StateDirectory"
    }

    $htmlPath = Join-Path $resolvedStateDirectory '探索进度面板.html'
    $jsonPath = Join-Path $resolvedStateDirectory 'state.json'
    if (-not (Test-Path -LiteralPath $htmlPath -PathType Leaf)) {
        throw "Required panel file is missing: $htmlPath"
    }
    if (-not (Test-Path -LiteralPath $jsonPath -PathType Leaf)) {
        throw "Required state file is missing: $jsonPath"
    }

    $identity = [System.IO.Path]::GetFullPath($resolvedStateDirectory).TrimEnd('\').ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $identityBytes = [System.Text.Encoding]::UTF8.GetBytes($identity)
        $identityHash = [Convert]::ToHexString($sha.ComputeHash($identityBytes)).ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }

    $mutex = [System.Threading.Mutex]::new($false, "Local\CodexWorkflowRouteMapperPanel_$identityHash")
    $hasMutex = $false
    try {
        try { $hasMutex = $mutex.WaitOne([TimeSpan]::FromSeconds(15)) }
        catch [System.Threading.AbandonedMutexException] { $hasMutex = $true }
        if (-not $hasMutex) { throw 'Timed out waiting for the panel startup lock.' }

        $markerPath = Join-Path $resolvedStateDirectory '.探索进度面板-server.json'
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            try {
                $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $existingPid = [int]$marker.pid
                $existingUri = [Uri]$marker.url
                if ($existingUri.Host -eq '127.0.0.1' -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
                    $healthUri = "http://127.0.0.1:$($existingUri.Port)/__panel_health?token=$identityHash"
                    $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 2
                    if ($health.ok -eq $true -and $health.identity -eq $identityHash -and $health.version -eq 2) {
                        [pscustomobject]@{ url = $marker.url; pid = $existingPid } | ConvertTo-Json -Compress
                        exit 0
                    }
                }
            }
            catch {
                # An absent, stale, or unrelated marker is replaced after a fresh server starts.
            }
        }

        $python = Get-Command python -ErrorAction SilentlyContinue
        if (-not $python) { throw 'Python was not found on PATH.' }

        $pythonCode = @'
import http.server
import json
import os
import sys
from urllib.parse import urlsplit, parse_qs, unquote

root = os.path.abspath(sys.argv[1])
token = sys.argv[2]
ready_file = sys.argv[3]

class Handler(http.server.BaseHTTPRequestHandler):
    def respond(self, head_only=False):
        parsed = urlsplit(self.path)
        if parsed.path == '/__panel_health':
            valid = parse_qs(parsed.query).get('token', [''])[0] == token
            body = json.dumps({'ok': valid, 'identity': token if valid else '', 'version': 2}).encode('utf-8')
            self.send_response(200 if valid else 403)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return

        routes = {
            '/探索进度面板.html': ('探索进度面板.html', 'text/html; charset=utf-8'),
            '/state.json': ('state.json', 'application/json; charset=utf-8'),
        }
        route = routes.get(unquote(parsed.path))
        if route is None:
            self.send_error(404)
            return
        filename, content_type = route
        try:
            with open(os.path.join(root, filename), 'rb') as source:
                body = source.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if not head_only:
            self.wfile.write(body)
    def do_GET(self):
        self.respond()
    def do_HEAD(self):
        self.respond(head_only=True)
    def log_message(self, format, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
server.daemon_threads = True
with open(ready_file, 'w', encoding='utf-8') as ready:
    json.dump({'port': server.server_address[1]}, ready)
    ready.flush()
server.serve_forever()
'@
        $codeBytes = [System.Text.Encoding]::UTF8.GetBytes($pythonCode)
        $encodedCode = [Convert]::ToBase64String($codeBytes)
        $readyPath = Join-Path ([System.IO.Path]::GetTempPath()) ("codex-panel-ready-" + [Guid]::NewGuid().ToString('N') + '.json')

        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $python.Source
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $null = $startInfo.ArgumentList.Add('-c')
        $null = $startInfo.ArgumentList.Add("import base64;exec(compile(base64.b64decode('$encodedCode'),'<panel-server>','exec'))")
        $null = $startInfo.ArgumentList.Add($resolvedStateDirectory)
        $null = $startInfo.ArgumentList.Add($identityHash)
        $null = $startInfo.ArgumentList.Add($readyPath)

        $serverProcess = [System.Diagnostics.Process]::new()
        $serverProcess.StartInfo = $startInfo
        if (-not $serverProcess.Start()) { throw 'Python panel server failed to start.' }
        # Detach the server from the caller's console pipes so the invoking
        # pwsh process can exit while the HTTP server remains alive.
        $serverProcess.StandardOutput.BaseStream.Close()
        $serverProcess.StandardError.BaseStream.Close()

        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ([DateTime]::UtcNow -lt $deadline -and -not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
            if ($serverProcess.HasExited) { throw "Python panel server exited with code $($serverProcess.ExitCode)." }
            Start-Sleep -Milliseconds 100
        }
        if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
            try { $serverProcess.Kill() } catch { }
            throw 'Timed out waiting for the Python panel server to bind its local port.'
        }

        $ready = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8 | ConvertFrom-Json
        Remove-Item -LiteralPath $readyPath -Force
        $url = "http://127.0.0.1:$([int]$ready.port)/探索进度面板.html"
        $record = [pscustomobject]@{ url = $url; pid = $serverProcess.Id }
        $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerPath -Encoding UTF8

        # Confirm the child is reachable before publishing its address.
        $healthUri = "http://127.0.0.1:$([int]$ready.port)/__panel_health?token=$identityHash"
        $health = Invoke-RestMethod -Uri $healthUri -TimeoutSec 3
        if ($health.ok -ne $true -or $health.identity -ne $identityHash) {
            throw 'The panel server started but failed its local health check.'
        }
        $record | ConvertTo-Json -Compress
    }
    finally {
        if ($hasMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
