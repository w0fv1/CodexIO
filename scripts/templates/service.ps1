param(
    [Parameter(Mandatory)]
    [ValidateSet("install", "uninstall", "start", "stop", "restart")]
    [string] $Action,
    [switch] $EnsureDependencies
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$CodexioRoot = Join-Path $Root ".codexio"
$LogRoot = Join-Path $CodexioRoot "log"
$ServiceCommand = Join-Path $CodexioRoot "codexio-service.exe"
$ReleaseMetadataPath = Join-Path $CodexioRoot "release.json"
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$LogPath = Join-Path $LogRoot ("command-{0}-{1:yyyyMMdd-HHmmss}.log" -f $Action, (Get-Date))

function Write-CommandLog {
    param([Parameter(Mandatory)] [string] $Text)
    Write-Host $Text
    Add-Content -LiteralPath $LogPath -Value $Text -Encoding utf8
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-Elevated {
    if ($env:CODEXIO_SKIP_ELEVATION -eq "1") {
        throw "Administrator privileges are required."
    }
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "`"$PSCommandPath`"",
        "-Action",
        $Action
    )
    if ($EnsureDependencies) {
        $arguments += "-EnsureDependencies"
    }
    Write-CommandLog "[codexio] administrator privileges are required, requesting elevation"
    Start-Process -FilePath "powershell" -ArgumentList $arguments -Verb RunAs | Out-Null
}

function Invoke-LocalCommand {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [Parameter(Mandatory)] [string[]] $Arguments
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($Arguments -join ' ')"
    }
}

function Read-PackagePlatform {
    if (-not (Test-Path -LiteralPath $ReleaseMetadataPath)) {
        throw "release metadata is missing: $ReleaseMetadataPath"
    }
    $metadata = Get-Content -Raw -LiteralPath $ReleaseMetadataPath | ConvertFrom-Json
    $platform = [string]$metadata.platform
    if ([string]::IsNullOrWhiteSpace($platform)) {
        throw "release platform is missing"
    }
    return $platform
}

function Test-ProductionDependencies {
    return (Test-Path -LiteralPath (Join-Path $Root "node_modules\@openai\codex\bin\codex.js")) `
        -and (Test-Path -LiteralPath (Join-Path $Root "node_modules\@openai\codex-win32-x64\package.json")) `
        -and (Test-Path -LiteralPath (Join-Path $Root "node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs")) `
        -and (Test-Path -LiteralPath (Join-Path $Root "node_modules\@anthropic-ai\claude-code-win32-x64\package.json"))
}

function Assert-ProductionDependencies {
    Write-CommandLog "[codexio] checking production dependencies"
    if (Test-ProductionDependencies) {
        Write-CommandLog "[codexio] dependencies are ready"
        return
    }
    $platform = Read-PackagePlatform
    if ($platform -eq "windows-x64-standalone") {
        throw "Standalone package dependencies are incomplete. Reinstall Codexio from a complete standalone package."
    }
    if ($platform -ne "windows-x64-pnpm") {
        throw "Unsupported package platform: $platform"
    }
    Write-CommandLog "[codexio] dependencies are missing, installing production dependencies"
    Invoke-LocalCommand -FilePath "powershell" -Arguments @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        (Join-Path $Root "nodew.ps1"),
        "pnpm",
        "install",
        "--prod",
        "--dir",
        $Root,
        "--config.node-linker=hoisted"
    )
    Write-CommandLog "[codexio] dependencies installed"
    foreach ($bootstrapPath in @((Join-Path $Root ".codexio\pnpm"), (Join-Path $Root ".codexio\download"))) {
        if (Test-Path -LiteralPath $bootstrapPath) {
            Write-CommandLog "[codexio] removing bootstrap path: $bootstrapPath"
            Remove-Item -Recurse -Force -LiteralPath $bootstrapPath
        }
    }
}

function Test-ServiceInstalled {
    $service = Get-Service -Name "codexio" -ErrorAction SilentlyContinue
    return $null -ne $service
}

function Get-ServicePathName {
    $service = Get-CimInstance Win32_Service -Filter "Name='codexio'" -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        return $null
    }
    return [string]$service.PathName
}

function Resolve-ServiceExecutablePath {
    param([Parameter(Mandatory)] [string] $PathName)
    $trimmed = $PathName.Trim()
    if ($trimmed.StartsWith('"')) {
        $end = $trimmed.IndexOf('"', 1)
        if ($end -gt 1) {
            return [System.IO.Path]::GetFullPath($trimmed.Substring(1, $end - 1))
        }
    }
    $space = $trimmed.IndexOf(' ')
    if ($space -gt 0) {
        return [System.IO.Path]::GetFullPath($trimmed.Substring(0, $space))
    }
    return [System.IO.Path]::GetFullPath($trimmed)
}

function Test-ServiceMatchesPackage {
    $pathName = Get-ServicePathName
    if ([string]::IsNullOrWhiteSpace($pathName)) {
        return $false
    }
    $actualPath = Resolve-ServiceExecutablePath -PathName $pathName
    $expectedPath = [System.IO.Path]::GetFullPath($ServiceCommand)
    return $actualPath -eq $expectedPath
}

function Test-ServiceRunning {
    $service = Get-Service -Name "codexio" -ErrorAction SilentlyContinue
    return $null -ne $service -and $service.Status -eq "Running"
}

function Remove-ServiceRegistration {
    if (-not (Test-ServiceInstalled)) {
        return
    }
    if (Test-ServiceRunning) {
        Write-CommandLog "[codexio] stopping existing service"
        Invoke-LocalCommand -FilePath "sc.exe" -Arguments @("stop", "codexio")
        for ($attempt = 1; $attempt -le 30; $attempt++) {
            if (-not (Test-ServiceRunning)) {
                break
            }
            Start-Sleep -Milliseconds 500
        }
    }
    Write-CommandLog "[codexio] deleting existing service registration"
    Invoke-LocalCommand -FilePath "sc.exe" -Arguments @("delete", "codexio")
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        if (-not (Test-ServiceInstalled)) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Existing service registration was not deleted."
}

function Install-Service {
    if (Test-ServiceInstalled) {
        if (Test-ServiceMatchesPackage) {
            Write-CommandLog "[codexio] service is already installed"
            return
        }
        Write-CommandLog "[codexio] service path changed, reinstalling service"
        Remove-ServiceRegistration
    }
    Write-CommandLog "[codexio] installing service"
    Invoke-LocalCommand -FilePath $ServiceCommand -Arguments @("install")
}

function Start-ServiceProcess {
    Install-Service
    if (Test-ServiceRunning) {
        Write-CommandLog "[codexio] service is already running"
        return
    }
    Write-CommandLog "[codexio] starting service"
    Invoke-LocalCommand -FilePath $ServiceCommand -Arguments @("start")
}

function Stop-ServiceProcess {
    if (-not (Test-ServiceInstalled)) {
        Write-CommandLog "[codexio] service is not installed"
        return
    }
    if (-not (Test-ServiceRunning)) {
        Write-CommandLog "[codexio] service is not running"
        return
    }
    Write-CommandLog "[codexio] stopping service"
    Invoke-LocalCommand -FilePath $ServiceCommand -Arguments @("stop")
}

function Uninstall-ServiceProcess {
    if (-not (Test-ServiceInstalled)) {
        Write-CommandLog "[codexio] service is not installed"
        return
    }
    Stop-ServiceProcess
    Write-CommandLog "[codexio] uninstalling service"
    Invoke-LocalCommand -FilePath $ServiceCommand -Arguments @("uninstall")
}

function Restart-ServiceProcess {
    if (Test-ServiceInstalled) {
        Stop-ServiceProcess
    }
    Start-ServiceProcess
}

function Invoke-ServiceAction {
    switch ($Action) {
        "install" { Install-Service }
        "uninstall" { Uninstall-ServiceProcess }
        "start" { Start-ServiceProcess }
        "stop" { Stop-ServiceProcess }
        "restart" { Restart-ServiceProcess }
    }
}

try {
    Write-CommandLog "[codexio] $Action Codexio Windows service"
    Write-CommandLog "[codexio] working directory: $Root"
    Write-CommandLog "[codexio] command log: $LogPath"
    Set-Location -LiteralPath $Root
    if ($EnsureDependencies) {
        Assert-ProductionDependencies
    }
    if (-not (Test-Administrator)) {
        Start-Elevated
        exit 0
    }
    Invoke-ServiceAction
    Write-CommandLog "[codexio] $Action done"
    exit 0
}
catch {
    Write-CommandLog "[codexio] command failed: $($_.Exception.Message)"
    Write-CommandLog "[codexio] press Enter to close"
    [Console]::ReadLine() | Out-Null
    exit 1
}
