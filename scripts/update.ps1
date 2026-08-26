<#
.SYNOPSIS
  Update Arihant MIS to the latest code, on a Windows server.

.DESCRIPTION
  Backs up the database first, then pulls, rebuilds and restarts. Migrations run
  automatically on start via `prisma migrate deploy`, which only applies
  committed migrations and never drops or resets anything.

  The PostgreSQL volume is a named Docker volume and is never removed here, so
  the financial data survives every update.

.EXAMPLE
  .\scripts\update.ps1
#>

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# Read .env for the port and database settings.
$envFile = '.env'
$settings = @{}
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
      $settings[$Matches[1]] = $Matches[2].Trim('"').Trim("'")
    }
  }
}

$appPort = if ($settings.ContainsKey('APP_PORT')) { $settings['APP_PORT'] } else { '3000' }
$dbUser  = if ($settings.ContainsKey('POSTGRES_USER')) { $settings['POSTGRES_USER'] } else { 'arihant' }
$dbName  = if ($settings.ContainsKey('POSTGRES_DB')) { $settings['POSTGRES_DB'] } else { 'arihant_mis' }

Write-Host '==> 1/5  Backing up before changing anything' -ForegroundColor Cyan
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path 'backups' | Out-Null
$dump = "backups\arihant-mis-$stamp.sql"

docker compose exec -T postgres pg_dump -U $dbUser -d $dbName --clean --if-exists |
  Out-File -FilePath $dump -Encoding utf8
if ($?) { } else { throw 'pg_dump failed; nothing was changed.' }

if ((Get-Item $dump).Length -eq 0) {
  Remove-Item $dump
  throw 'The dump is empty. Nothing was backed up, so the update was stopped.'
}
Compress-Archive -Path $dump -DestinationPath "$dump.zip" -Force
Remove-Item $dump
Write-Host "    Backup written to $dump.zip"

Write-Host ''
Write-Host '==> 2/5  Fetching the latest code' -ForegroundColor Cyan
git pull --ff-only
if (-not $?) { throw 'git pull failed; nothing was changed.' }

Write-Host ''
Write-Host '==> 3/5  Building the new image' -ForegroundColor Cyan
docker compose build app
if (-not $?) { throw 'The build failed. The running application is untouched.' }

Write-Host ''
Write-Host '==> 4/5  Restarting (migrations run automatically on start)' -ForegroundColor Cyan
docker compose up -d
if (-not $?) { throw 'docker compose up failed.' }

Write-Host ''
Write-Host '==> 5/5  Waiting for the application to report healthy' -ForegroundColor Cyan
$healthy = $false
foreach ($i in 1..60) {
  try {
    $response = Invoke-RestMethod -Uri "http://localhost:$appPort/api/health" -TimeoutSec 5
    if ($response.status -eq 'ok') {
      Write-Host "    Healthy. Version $($response.version), database $($response.database)."
      $healthy = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 2
  }
}

if (-not $healthy) {
  Write-Host ''
  Write-Host 'ERROR: the application did not become healthy within 2 minutes.' -ForegroundColor Red
  Write-Host 'Check the logs:  docker compose logs --tail=100 app' -ForegroundColor Red
  Write-Host "The database was backed up in step 1 to $dump.zip and has not been modified." -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host 'Update complete.' -ForegroundColor Green

# Prune backups past the retention window.
$retention = if ($settings.ContainsKey('BACKUP_RETENTION_DAYS')) { [int]$settings['BACKUP_RETENTION_DAYS'] } else { 30 }
$cutoff = (Get-Date).AddDays(-$retention)
Get-ChildItem 'backups' -Filter 'arihant-mis-*.zip' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  ForEach-Object {
    Write-Host "    Pruning old backup $($_.Name)"
    Remove-Item $_.FullName
  }
