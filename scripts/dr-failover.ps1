[CmdletBinding()]
param(
    [string]$ProjectName = 'shop-platform-devtools',
    [string]$ApplicationProjectName = 'shop-platform-application',
    [switch]$NoApplicationSwitch,
    [switch]$NoEnvironmentFileUpdate,
    [switch]$ConfirmFailover,
    [int]$RtoTargetSeconds = 300,
    [string]$ManagementUrl = 'http://localhost:8081/actuator/health/readiness'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    $compose = @('-p', $ProjectName, '-f', 'compose.devtools.yml', '-f', 'compose.dr.yml')

    function Invoke-Docker {
        param([string[]]$Arguments)
        & docker @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "docker $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
        }
    }

    function Invoke-DatabaseQuery {
        param([string]$Service, [string]$Sql)
        $user = (& docker compose @compose exec -T $Service printenv POSTGRES_USER).Trim()
        $database = (& docker compose @compose exec -T $Service printenv POSTGRES_DB).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($user) -or [string]::IsNullOrWhiteSpace($database)) {
            throw "Could not read the PostgreSQL connection identity from $Service"
        }
        $result = & docker compose @compose exec -T $Service psql -X -A -t -v ON_ERROR_STOP=1 -U $user -d $database -c $Sql
        if ($LASTEXITCODE -ne 0) {
            throw "PostgreSQL probe failed on $Service"
        }
        return ($result -join "`n").Trim()
    }

    function Set-DatabaseHost {
        param([string]$HostName)
        $envPath = Join-Path $repoRoot '.env'
        if (-not (Test-Path -LiteralPath $envPath)) {
            throw 'Application switching requires the root .env file; create it from .env.example first.'
        }
        $lines = [System.Collections.Generic.List[string]]::new()
        foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
            if ($line -match '^\s*DATABASE_HOST\s*=') {
                if ($lines -notcontains "DATABASE_HOST=$HostName") {
                    $lines.Add("DATABASE_HOST=$HostName")
                }
            } else {
                $lines.Add($line)
            }
        }
        if (-not ($lines | Where-Object { $_ -match '^\s*DATABASE_HOST\s*=' })) {
            $lines.Add("DATABASE_HOST=$HostName")
        }
        [System.IO.File]::WriteAllText(
            $envPath,
            (($lines -join [Environment]::NewLine) + [Environment]::NewLine),
            [System.Text.UTF8Encoding]::new($false))
    }

    if (-not $ConfirmFailover) {
        throw "Failover is destructive and fences the current primary. Review the target project, then rerun with -ConfirmFailover."
    }

    $existingPrimary = & docker compose @compose ps --all --quiet postgres
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the existing primary for Compose project '$ProjectName'."
    }
    if (-not [string]::IsNullOrWhiteSpace(($existingPrimary -join ''))) {
        $runningPrimary = & docker compose @compose ps --status running --quiet postgres
        if ($LASTEXITCODE -ne 0) {
            throw "Could not verify the primary state for Compose project '$ProjectName'."
        }
        if ([string]::IsNullOrWhiteSpace(($runningPrimary -join ''))) {
            throw "The primary container already exists but is stopped. Refusing to start a possibly fenced former primary."
        }
    }

    Invoke-Docker -Arguments (@('compose') + $compose + @('up', '--detach', '--wait', 'postgres'))

    Invoke-Docker -Arguments (@('compose') + $compose + @('exec', '-T', 'postgres', 'sh', '/usr/local/bin/dr-bootstrap.sh'))

    Invoke-Docker -Arguments (@('compose') + $compose + @('up', '--detach', '--wait', 'postgres-dr'))

    Invoke-DatabaseQuery -Service 'postgres' -Sql "ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 (shop_dr)'" | Out-Null
    Invoke-DatabaseQuery -Service 'postgres' -Sql 'SELECT pg_reload_conf()' | Out-Null
    $syncDeadline = [DateTime]::UtcNow.AddMinutes(2)
    $syncState = ''
    do {
        $syncState = Invoke-DatabaseQuery -Service 'postgres' -Sql "SELECT state || '|' || sync_state FROM pg_stat_replication WHERE application_name = 'shop_dr'"
        if ($syncState -eq 'streaming|sync') { break }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $syncDeadline)
    if ($syncState -ne 'streaming|sync') {
        throw "DR standby did not become synchronous (last state: '$syncState'). Primary remains active."
    }

    $probeId = [Guid]::NewGuid().ToString()
    $createProbe = "CREATE TABLE IF NOT EXISTS public.dr_failover_probe (probe_id uuid PRIMARY KEY, committed_at timestamptz NOT NULL); INSERT INTO public.dr_failover_probe (probe_id, committed_at) VALUES ('$probeId', clock_timestamp());"
    Invoke-DatabaseQuery -Service 'postgres' -Sql $createProbe | Out-Null
    $probeDeadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $probeFound = Invoke-DatabaseQuery -Service 'postgres-dr' -Sql "SELECT count(*) FROM public.dr_failover_probe WHERE probe_id = '$probeId'"
        if ($probeFound -eq '1') { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $probeDeadline)
    if ($probeFound -ne '1') {
        throw 'The acknowledged primary probe was not visible on the standby; refusing promotion.'
    }

    $recoveryStarted = [DateTime]::UtcNow
    Invoke-Docker -Arguments (@('compose') + $compose + @('stop', '--timeout', '10', 'postgres'))
    $primaryRunning = (& docker compose @compose ps --status running --services postgres).Trim()
    if ($LASTEXITCODE -ne 0 -or $primaryRunning -match '(^|\s)postgres($|\s)') {
        throw 'Could not confirm that the former primary is fenced; refusing to promote the standby.'
    }

    Invoke-Docker -Arguments (@('compose') + $compose + @('exec', '-T', 'postgres-dr', 'gosu', 'postgres', 'pg_ctl', 'promote', '-D', '/var/lib/postgresql/data', '-w'))
    $promoted = Invoke-DatabaseQuery -Service 'postgres-dr' -Sql 'SELECT NOT pg_is_in_recovery()'
    if ($promoted -ne 't') {
        throw 'The standby did not leave recovery after the promotion request.'
    }
    $probeFound = Invoke-DatabaseQuery -Service 'postgres-dr' -Sql "SELECT count(*) FROM public.dr_failover_probe WHERE probe_id = '$probeId'"
    if ($probeFound -ne '1') {
        throw 'The acknowledged primary probe was missing after promotion; stopping before application cutover.'
    }
    $postPromotionId = [Guid]::NewGuid().ToString()
    Invoke-DatabaseQuery -Service 'postgres-dr' -Sql "INSERT INTO public.dr_failover_probe (probe_id, committed_at) VALUES ('$postPromotionId', clock_timestamp())" | Out-Null
    $postPromotionFound = Invoke-DatabaseQuery -Service 'postgres-dr' -Sql "SELECT count(*) FROM public.dr_failover_probe WHERE probe_id = '$postPromotionId'"
    if ($postPromotionFound -ne '1') {
        throw 'The promoted database did not accept a durable write.'
    }

    if (-not $NoApplicationSwitch) {
        if (-not $NoEnvironmentFileUpdate) {
            Set-DatabaseHost -HostName 'postgres-dr'
        }
        $env:DATABASE_HOST = 'postgres-dr'
        $env:APP_NETWORK_NAME = if ([string]::IsNullOrWhiteSpace($env:DR_NETWORK_NAME)) { 'shop-platform' } else { $env:DR_NETWORK_NAME }
        Invoke-Docker -Arguments @(
            'compose', '-p', $ApplicationProjectName, '-f', 'compose.application.yml',
            'up', '--detach', '--wait', '--wait-timeout', "$RtoTargetSeconds",
            '--no-deps', '--force-recreate', 'api')
        $healthDeadline = [DateTime]::UtcNow.AddSeconds($RtoTargetSeconds)
        $healthy = $false
        do {
            try {
                $health = Invoke-RestMethod -Uri $ManagementUrl -TimeoutSec 5
                if ($health.status -eq 'UP') { $healthy = $true; break }
            } catch {
                Start-Sleep -Seconds 2
            }
        } while ([DateTime]::UtcNow -lt $healthDeadline)
        if (-not $healthy) {
            throw "The API did not become ready at $ManagementUrl after database cutover. The old primary remains fenced; inspect logs before further action."
        }
    }

    $recoverySeconds = [Math]::Round(([DateTime]::UtcNow - $recoveryStarted).TotalSeconds, 2)
    Write-Output "Acknowledged-probe RPO: 0 lost transactions (synchronous standby verified before fencing)."
    Write-Output "Database recovery time: $recoverySeconds seconds (target <= $RtoTargetSeconds seconds)."
    if (-not $NoApplicationSwitch) {
        if ($NoEnvironmentFileUpdate) {
            Write-Output "API readiness verified at $ManagementUrl; set DATABASE_HOST=postgres-dr before the normal application restart."
        } else {
            Write-Output "API readiness verified at $ManagementUrl; .env now points DATABASE_HOST to postgres-dr."
        }
    } else {
        Write-Output 'Application endpoint was not changed (-NoApplicationSwitch); set DATABASE_HOST=postgres-dr before restarting the API.'
    }
    Invoke-DatabaseQuery -Service 'postgres-dr' -Sql 'DROP TABLE public.dr_failover_probe' | Out-Null
    if ($recoverySeconds -gt $RtoTargetSeconds) {
        throw "Failover completed but missed the configured recovery-time target of $RtoTargetSeconds seconds."
    }
} finally {
    Pop-Location
}
