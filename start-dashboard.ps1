#Requires -Version 5.1
<#
.SYNOPSIS
  Avvia la dashboard di ISL - Improvement Software Loop.
.DESCRIPTION
  Prepara e lancia il control plane:
    1. verifica Node >= 22.5 (serve node:sqlite integrato)
    2. installa le dipendenze (root + dashboard) se mancano
    3. builda la dashboard se dist/ manca o e' piu' vecchia del sorgente
    4. avvia il server (che serve la UI buildata) e apre il browser
  Idempotente: rilancialo quando vuoi. Ctrl+C ferma il server.
.PARAMETER Port
  Porta del server (default 7878, sovrascrive PORT).
.PARAMETER Dev
  Avvia la dashboard in modalita' sviluppo (Vite HMR) invece della build statica.
.PARAMETER Rebuild
  Forza la ri-build della dashboard anche se dist/ e' aggiornata.
.PARAMETER NoOpen
  Non aprire automaticamente il browser.
.EXAMPLE
  .\start-dashboard.ps1
.EXAMPLE
  .\start-dashboard.ps1 -Port 8080 -Rebuild
.EXAMPLE
  .\start-dashboard.ps1 -Dev
#>
[CmdletBinding()]
param(
  [int]$Port = 7878,
  [switch]$Dev,
  [switch]$Rebuild,
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
Set-Location $Root

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "ERRORE: $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "  ISL - Improvement Software Loop" -ForegroundColor White
Write-Host "  -------------------------------" -ForegroundColor DarkGray

# 1. Node presente e abbastanza recente ------------------------------------
Write-Step "Controllo Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js non trovato nel PATH. Installa Node >= 22.5 da https://nodejs.org" }
$verRaw = (& node --version).TrimStart('v')       # es. 24.15.0
$verParts = $verRaw.Split('.')
$major = [int]$verParts[0]; $minor = [int]$verParts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  Fail "Node $verRaw troppo vecchio: serve >= 22.5.0 (per node:sqlite integrato)."
}
Write-Ok "Node v$verRaw"

# 2. Dipendenze -------------------------------------------------------------
Write-Step "Dipendenze"
if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Write-Warn2 "installo dipendenze del server (npm install)..."
  & npm install
  if ($LASTEXITCODE -ne 0) { Fail "npm install (server) fallito" }
} else { Write-Ok "server: gia' installate" }

$dashDir = Join-Path $Root 'dashboard'
if (-not (Test-Path (Join-Path $dashDir 'node_modules'))) {
  Write-Warn2 "installo dipendenze della dashboard..."
  & npm --prefix $dashDir install
  if ($LASTEXITCODE -ne 0) { Fail "npm install (dashboard) fallito" }
} else { Write-Ok "dashboard: gia' installate" }

# porta
$env:PORT = "$Port"

# --- Modalita' sviluppo: due processi (server API + Vite HMR) --------------
if ($Dev) {
  Write-Step "Modalita' sviluppo (Vite HMR)"
  Write-Ok "server API su http://localhost:$Port"
  Write-Warn2 "avvio il server API in background..."
  $srv = Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -PassThru -WorkingDirectory $Root
  try {
    Write-Ok "avvio Vite dev server (Ctrl+C per fermare tutto)..."
    & npm --prefix $dashDir run dev
  } finally {
    if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
    Write-Host "`nServer API fermato." -ForegroundColor DarkGray
  }
  exit 0
}

# 3. Build della dashboard (se serve) ---------------------------------------
Write-Step "Build dashboard"
$dist = Join-Path $dashDir 'dist'
$distIndex = Join-Path $dist 'index.html'
$needBuild = $Rebuild -or -not (Test-Path $distIndex)

if (-not $needBuild) {
  # ri-builda se un sorgente e' piu' recente dell'artefatto
  $newestSrc = Get-ChildItem -Path (Join-Path $dashDir 'src'), (Join-Path $dashDir 'index.html') -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  $builtAt = (Get-Item $distIndex).LastWriteTimeUtc
  if ($newestSrc -and $newestSrc.LastWriteTimeUtc -gt $builtAt) {
    Write-Warn2 "sorgente modificato dopo l'ultima build -> ricostruisco"
    $needBuild = $true
  }
}

if ($needBuild) {
  Write-Warn2 "npm run build..."
  & npm --prefix $dashDir run build
  if ($LASTEXITCODE -ne 0) { Fail "build della dashboard fallita" }
  Write-Ok "build completata"
} else {
  Write-Ok "dist/ aggiornata (usa -Rebuild per forzare)"
}

# 4. Avvio server + apertura browser ----------------------------------------
Write-Step "Avvio server"
$url = "http://localhost:$Port"
Write-Ok "dashboard su $url"
Write-Host "    Primo accesso: usa la tua email admin e scegli la password." -ForegroundColor DarkGray
Write-Host "    (Ctrl+C per fermare)" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoOpen) {
  # apre il browser quando il server risponde, senza bloccare l'avvio
  Start-Job -ScriptBlock {
    param($u)
    for ($i = 0; $i -lt 40; $i++) {
      try { Invoke-WebRequest -Uri "$u/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $u; break }
      catch { Start-Sleep -Milliseconds 500 }
    }
  } -ArgumentList $url | Out-Null
}

# esegue il server in primo piano (Ctrl+C lo termina)
& node src/server.js
