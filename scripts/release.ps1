param(
    [string] $AppDomain = "next.firco.cn",
    [string[]] $Platforms = @("windows-x64-pnpm", "windows-x64-standalone"),
    [switch] $BuildOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Path (Split-Path -Path $ProjectRoot -Parent) -Parent
$BuildRoot = Join-Path $ProjectRoot "build"
$InstallRoot = Join-Path $BuildRoot "production-install"
$ReleaseRoot = Join-Path $ProjectRoot "release"
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$PackageName = "codexio"
$StandaloneRoot = Join-Path $BuildRoot "standalone\codexio"
$PnpmRoot = Join-Path $BuildRoot "pnpm\codexio"
$NodeRuntimeVersion = "22.20.0"
$PnpmRuntimeVersion = "10.33.4"
$WinSWVersion = "2.12.0"

function Write-Step {
    param([Parameter(Mandatory)] [string] $Text)
    Write-Host "[codexio release] $Text"
}

function Assert-PathExists {
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -Path $Path)) {
        throw "Required package path is missing: $Path"
    }
}

function Read-ProjectVersion {
    $package = Get-Content -Raw -Path $PackageJsonPath | ConvertFrom-Json
    $version = [string]$package.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Project version must match x.y.z"
    }
    return $version
}

function Resolve-NodeRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:PACKAGE_NODE_ROOT)) {
        Assert-PathExists $env:PACKAGE_NODE_ROOT
        return (Resolve-Path -Path $env:PACKAGE_NODE_ROOT).Path
    }
    $nodeCommand = Get-Command node -ErrorAction Stop
    return Split-Path -Parent $nodeCommand.Source
}

function Resolve-PnpmRoot {
    if (-not [string]::IsNullOrWhiteSpace($env:PACKAGE_PNPM_ROOT)) {
        Assert-PathExists $env:PACKAGE_PNPM_ROOT
        return (Resolve-Path -Path $env:PACKAGE_PNPM_ROOT).Path
    }
    $corepackPnpmRoot = Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$PnpmRuntimeVersion"
    if (Test-Path -Path (Join-Path $corepackPnpmRoot "bin\pnpm.cjs")) {
        return (Resolve-Path -Path $corepackPnpmRoot).Path
    }
    $pnpmCommand = Get-Command pnpm -ErrorAction Stop
    $pnpmPath = (Resolve-Path -Path $pnpmCommand.Source).Path
    $pnpmRoot = Split-Path -Parent $pnpmPath
    if (Test-Path -Path (Join-Path $pnpmRoot "package.json")) {
        return $pnpmRoot
    }
    throw "pnpm runtime $PnpmRuntimeVersion not found. Run corepack pnpm@$PnpmRuntimeVersion --version first or set PACKAGE_PNPM_ROOT."
}

function Write-Utf8File {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Text
    )
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Assert-ArchiveContains {
    param(
        [Parameter(Mandatory)] [string] $Archive,
        [Parameter(Mandatory)] [string[]] $Entries
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $names = @{}
        foreach ($entry in $zip.Entries) {
            $names[$entry.FullName.Replace("\", "/")] = $true
        }
        foreach ($entryName in $Entries) {
            if (-not $names.ContainsKey($entryName)) {
                throw "Release archive is missing required file: $entryName"
            }
        }
    }
    finally {
        $zip.Dispose()
    }
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [string[]] $ArgumentList = @(),
        [string] $WorkingDirectory = $ProjectRoot
    )
    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($ArgumentList -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Resolve-WinSW {
    $vendoredWinswPath = Join-Path $ProjectRoot "WinSW-x64.exe"
    if (Test-Path -Path $vendoredWinswPath) {
        Assert-PathExists $vendoredWinswPath
        return (Resolve-Path -Path $vendoredWinswPath).Path
    }
    $winswRoot = Join-Path $BuildRoot "winsw"
    $winswPath = Join-Path $winswRoot "WinSW-x64.exe"
    if (Test-Path -Path $winswPath) {
        return $winswPath
    }
    New-Item -ItemType Directory -Force -Path $winswRoot | Out-Null
    $url = "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-x64.exe"
    Write-Step "download WinSW: $url"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $winswPath -UseBasicParsing -TimeoutSec 300
    }
    catch {
        if (Test-Path -Path $winswPath) {
            Remove-Item -Force $winswPath
        }
        $curl = Get-Command curl.exe -ErrorAction Stop
        & $curl.Source --location --fail --retry 3 --output $winswPath $url
        if ($LASTEXITCODE -ne 0) {
            throw "WinSW download failed with curl exit code $LASTEXITCODE"
        }
    }
    Assert-PathExists $winswPath
    return $winswPath
}

function New-HttpCommandOptions {
    param([Parameter(Mandatory)] [string] $CommandName)
    $options = @{}
    $command = Get-Command $CommandName -ErrorAction Stop
    if ($command.Parameters.ContainsKey("NoProxy")) {
        $options.NoProxy = $true
    }
    return $options
}

function Read-AdminApiHeaders {
    Import-Module (Join-Path $RepoRoot "script\NfircoBackendApiCredential.psm1") -Force
    $adminApiCredential = Read-NfircoBackendApiCredential -RepoRoot $RepoRoot
    $adminApiUsername = [string]$adminApiCredential.Username
    $adminApiPassword = [string]$adminApiCredential.Password
    return @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${adminApiUsername}:${adminApiPassword}")) }
}

function Invoke-NfircoApi {
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [object] $Body,
        [Parameter(Mandatory)] [hashtable] $Headers
    )
    $json = $Body | ConvertTo-Json -Depth 8
    $requestOptions = New-HttpCommandOptions -CommandName "Invoke-RestMethod"
    $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec 60 @requestOptions
    if ($null -eq $response) {
        throw "Nfirco API returned empty response"
    }
    if ($response.isf) {
        throw "Nfirco API failed: $($response.msg)"
    }
    return $response.data
}

function Get-ZipSha256 {
    param([Parameter(Mandatory)] [string] $Path)
    $stream = [System.IO.File]::OpenRead((Resolve-Path -Path $Path).Path)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = $sha256.ComputeHash($stream)
            return -join ($hash | ForEach-Object { $_.ToString("x2") })
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Format-Duration {
    param([Parameter(Mandatory)] [TimeSpan] $Duration)
    return "{0:n2}s" -f $Duration.TotalSeconds
}

function Measure-Step {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [scriptblock] $Action
    )
    $startedAt = Get-Date
    Write-Step "$Name started"
    & $Action | Out-Host
    $duration = (Get-Date) - $startedAt
    Write-Step "$Name completed in $(Format-Duration -Duration $duration)"
    return $duration
}

function Remove-PathWithRetry {
    param([Parameter(Mandatory)] [string] $Path)
    $lastError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            if (Test-Path -Path $Path) {
                Remove-Item -Recurse -Force $Path
            }
            return
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds (250 * $attempt)
        }
    }
    throw $lastError
}

function New-ServiceXml {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Executable,
        [Parameter(Mandatory)] [string] $Arguments
    )
    $escapedExecutable = [System.Security.SecurityElement]::Escape($Executable)
    $escapedArguments = [System.Security.SecurityElement]::Escape($Arguments)
    $text = @"
<service>
  <id>codexio</id>
  <name>Codexio</name>
  <description>Codexio coding agent bridge</description>
  <executable>$escapedExecutable</executable>
  <arguments>$escapedArguments</arguments>
  <workingdirectory>%BASE%\..</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>%BASE%\log\winsw</logpath>
  <log mode="roll-by-size-time">
    <sizeThreshold>10485760</sizeThreshold>
    <pattern>yyyyMMdd</pattern>
    <keepFiles>30</keepFiles>
  </log>
</service>
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function Copy-ServiceWrapper {
    param([Parameter(Mandatory)] [string] $DestinationRoot)
    $winswPath = Resolve-WinSW
    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationRoot ".codexio") | Out-Null
    Copy-Item -Force $winswPath (Join-Path $DestinationRoot ".codexio\codexio-service.exe")
}

function New-ServiceCommandFiles {
    param(
        [Parameter(Mandatory)] [string] $DestinationRoot,
        [switch] $EnsureDependencies
    )
    New-ServiceScriptFile -Path (Join-Path $DestinationRoot "service.ps1")
    New-ServiceCommandFile -Path (Join-Path $DestinationRoot "install.cmd") -Action "install" -EnsureDependencies:$EnsureDependencies
    New-ServiceCommandFile -Path (Join-Path $DestinationRoot "uninstall.cmd") -Action "uninstall"
    New-ServiceCommandFile -Path (Join-Path $DestinationRoot "start.cmd") -Action "start" -EnsureDependencies:$EnsureDependencies
    New-ServiceCommandFile -Path (Join-Path $DestinationRoot "stop.cmd") -Action "stop"
    New-ServiceCommandFile -Path (Join-Path $DestinationRoot "restart.cmd") -Action "restart" -EnsureDependencies:$EnsureDependencies
}

function New-ServiceCommandFile {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [ValidateSet("install", "uninstall", "start", "stop", "restart")] [string] $Action,
        [switch] $EnsureDependencies
    )
    $dependencyArg = if ($EnsureDependencies) { " -EnsureDependencies" } else { "" }
    $text = @"
@echo off
cd /d %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service.ps1" -Action $Action$dependencyArg
exit /b %ERRORLEVEL%
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function New-ServiceScriptFile {
    param([Parameter(Mandatory)] [string] $Path)
    $text = @'
param(
    [Parameter(Mandatory)]
    [ValidateSet("install", "uninstall", "start", "stop", "restart")]
    [string] $Action,
    [switch] $EnsureDependencies
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$LogRoot = Join-Path $Root ".codexio\log"
$ServiceCommand = Join-Path $Root ".codexio\codexio-service.exe"
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

function Test-ProductionDependencies {
    return (Test-Path -LiteralPath (Join-Path $Root "node_modules\@openai\codex\bin\codex.js")) `
        -and (Test-Path -LiteralPath (Join-Path $Root "node_modules\@openai\codex-win32-x64\package.json")) `
        -and (Test-Path -LiteralPath (Join-Path $Root "node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs")) `
        -and (Test-Path -LiteralPath (Join-Path $Root "node_modules\@anthropic-ai\claude-code-win32-x64\package.json"))
}

function Install-ProductionDependencies {
    if (-not $EnsureDependencies) {
        return
    }
    Write-CommandLog "[codexio] checking production dependencies"
    if (Test-ProductionDependencies) {
        Write-CommandLog "[codexio] dependencies are ready"
        return
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
    Install-ProductionDependencies
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
'@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function New-NodewFile {
    param([Parameter(Mandatory)] [string] $Path)
    $script = @"
`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

`$Root = `$PSScriptRoot
`$RuntimeRoot = Join-Path `$Root ".codexio\node"
`$LocalNode = Join-Path `$RuntimeRoot "node.exe"
`$PnpmRoot = Join-Path `$Root ".codexio\pnpm"
`$LocalPnpm = Join-Path `$PnpmRoot "bin\pnpm.cjs"
`$NodeVersion = "$NodeRuntimeVersion"

function Test-ZipArchive {
    param([Parameter(Mandatory)] [string] `$Path)
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        `$zip = [System.IO.Compression.ZipFile]::OpenRead(`$Path)
        try {
            return `$zip.Entries.Count -gt 0
        }
        finally {
            `$zip.Dispose()
        }
    }
    catch {
        return `$false
    }
}

function Save-NodeArchive {
    param(
        [Parameter(Mandatory)] [string] `$ArchivePath,
        [Parameter(Mandatory)] [string] `$ArchiveName
    )
    `$tempPath = "`$ArchivePath.tmp"
    `$baseUrls = @()
    if (-not [string]::IsNullOrWhiteSpace(`$env:CODEXIO_NODE_DIST_BASE_URL)) {
        `$baseUrls += `$env:CODEXIO_NODE_DIST_BASE_URL.TrimEnd("/")
    }
    `$baseUrls += "https://npmmirror.com/mirrors/node"
    `$baseUrls += "https://nodejs.org/dist"
    foreach (`$baseUrl in `$baseUrls) {
        `$archiveUrl = "`$baseUrl/v`$NodeVersion/`$ArchiveName"
        if (Test-Path -LiteralPath `$tempPath) {
            Remove-Item -Force -LiteralPath `$tempPath
        }
        Write-Host "[codexio nodew] downloading Node.js from `$baseUrl"
        try {
            Invoke-WebRequest -Uri `$archiveUrl -OutFile `$tempPath -TimeoutSec 600
            if (Test-ZipArchive -Path `$tempPath) {
                Move-Item -Force -LiteralPath `$tempPath -Destination `$ArchivePath
                return
            }
        }
        catch {
            Write-Host "[codexio nodew] download failed from `$baseUrl"
        }
    }
    `$fallbackUrl = "https://next.firco.cn/api/download/release/nodejs/latest/file?platform=windows-x64"
    if (Test-Path -LiteralPath `$tempPath) {
        Remove-Item -Force -LiteralPath `$tempPath
    }
    Write-Host "[codexio nodew] downloading Node.js from Nfirco mirror"
    try {
        Invoke-WebRequest -Uri `$fallbackUrl -OutFile `$tempPath -TimeoutSec 600
        if (Test-ZipArchive -Path `$tempPath) {
            Move-Item -Force -LiteralPath `$tempPath -Destination `$ArchivePath
            return
        }
    }
    catch {
        Write-Host "[codexio nodew] download failed from Nfirco mirror"
    }
    if (Test-Path -LiteralPath `$tempPath) {
        Remove-Item -Force -LiteralPath `$tempPath
    }
    throw "Node.js download failed. Delete .codexio\download and retry, or manually extract node-v`$NodeVersion-win-x64.zip to .codexio\node."
}

function Expand-NodeArchive {
    param(
        [Parameter(Mandatory)] [string] `$ArchivePath,
        [Parameter(Mandatory)] [string] `$ExtractDir,
        [Parameter(Mandatory)] [string] `$ExtractedRoot
    )
    if (Test-Path -LiteralPath `$ExtractDir) {
        Remove-Item -Recurse -Force -LiteralPath `$ExtractDir
    }
    try {
        Expand-Archive -Path `$ArchivePath -DestinationPath `$ExtractDir -Force
    }
    catch {
        return `$false
    }
    `$node = Join-Path `$ExtractedRoot "node.exe"
    `$corepack = Join-Path `$ExtractedRoot "corepack.cmd"
    return (Test-Path -LiteralPath `$node) -and (Test-Path -LiteralPath `$corepack)
}

function Install-LocalNode {
    `$archiveName = "node-v`$NodeVersion-win-x64.zip"
    `$downloadDir = Join-Path `$Root ".codexio\download"
    `$archivePath = Join-Path `$downloadDir `$archiveName
    `$extractDir = Join-Path `$downloadDir "node-extract"
    New-Item -ItemType Directory -Force -Path `$downloadDir | Out-Null
    if (Test-Path -LiteralPath `$archivePath) {
        if (Test-ZipArchive -Path `$archivePath) {
            Write-Host "[codexio nodew] using cached Node.js archive"
        } else {
            Write-Host "[codexio nodew] cached Node.js archive is broken, deleting it"
            Remove-Item -Force -LiteralPath `$archivePath
        }
    }
    if (-not (Test-Path -LiteralPath `$archivePath)) {
        Write-Host "[codexio nodew] Node.js was not found, downloading v`$NodeVersion"
        Save-NodeArchive -ArchivePath `$archivePath -ArchiveName `$archiveName
    }
    Write-Host "[codexio nodew] extracting Node.js runtime"
    `$extractedRoot = Join-Path `$extractDir "node-v`$NodeVersion-win-x64"
    if (-not (Expand-NodeArchive -ArchivePath `$archivePath -ExtractDir `$extractDir -ExtractedRoot `$extractedRoot)) {
        Write-Host "[codexio nodew] Node.js archive content is invalid, downloading again"
        Remove-Item -Force -LiteralPath `$archivePath
        Save-NodeArchive -ArchivePath `$archivePath -ArchiveName `$archiveName
        if (-not (Expand-NodeArchive -ArchivePath `$archivePath -ExtractDir `$extractDir -ExtractedRoot `$extractedRoot)) {
            throw "Node.js archive extraction failed. Delete .codexio\download and retry."
        }
    }
    if (Test-Path -LiteralPath `$RuntimeRoot) {
        Remove-Item -Recurse -Force -LiteralPath `$RuntimeRoot
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent `$RuntimeRoot) | Out-Null
    Move-Item -LiteralPath `$extractedRoot -Destination `$RuntimeRoot
    Write-Host "[codexio nodew] Node.js installed locally"
}

function Use-LocalNodeEnvironment {
    `$localPath = [System.IO.Path]::GetFullPath(`$RuntimeRoot)
    `$pathItems = @(`$localPath)
    if (-not [string]::IsNullOrWhiteSpace(`$env:Path)) {
        foreach (`$pathItem in `$env:Path.Split([System.IO.Path]::PathSeparator)) {
            if ([string]::IsNullOrWhiteSpace(`$pathItem)) {
                continue
            }
            `$normalizedPathItem = `$pathItem.Trim('"')
            try {
                if ([System.IO.Path]::GetFullPath(`$normalizedPathItem) -eq `$localPath) {
                    continue
                }
            }
            catch {}
            `$pathItems += `$pathItem
        }
    }
    `$env:Path = (`$pathItems | Select-Object -Unique) -join [System.IO.Path]::PathSeparator
    Remove-Item -LiteralPath "Env:\NODE_OPTIONS" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:\NODE_PATH" -ErrorAction SilentlyContinue
    `$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
}

function Resolve-Node {
    if (-not (Test-Path -LiteralPath `$LocalNode)) {
        Install-LocalNode
    }
    Use-LocalNodeEnvironment
    Write-Host "[codexio nodew] using local Node.js"
    return `$LocalNode
}

function Resolve-Corepack {
    if (-not (Test-Path -LiteralPath `$LocalNode)) {
        Install-LocalNode
    }
    Use-LocalNodeEnvironment
    `$corepack = Join-Path `$RuntimeRoot "corepack.cmd"
    if (-not (Test-Path -LiteralPath `$corepack)) {
        throw "corepack not found"
    }
    Write-Host "[codexio nodew] using local Corepack"
    return `$corepack
}

function Resolve-Pnpm {
    if (-not (Test-Path -LiteralPath `$LocalNode)) {
        Install-LocalNode
    }
    Use-LocalNodeEnvironment
    if (-not (Test-Path -LiteralPath `$LocalPnpm)) {
        throw "bundled pnpm not found"
    }
    Write-Host "[codexio nodew] using bundled pnpm"
    return `$LocalPnpm
}

if (`$args.Count -gt 0 -and `$args[0] -eq "corepack") {
    Write-Host "[codexio nodew] launching Corepack"
    `$command = Resolve-Corepack
    & `$command @(`$args | Select-Object -Skip 1)
    exit `$LASTEXITCODE
}

if (`$args.Count -gt 0 -and `$args[0] -eq "pnpm") {
    Write-Host "[codexio nodew] launching pnpm"
    `$pnpm = Resolve-Pnpm
    `$node = Resolve-Node
    & `$node `$pnpm @(`$args | Select-Object -Skip 1)
    exit `$LASTEXITCODE
}

Write-Host "[codexio nodew] launching Node.js"
`$node = Resolve-Node
& `$node @args
exit `$LASTEXITCODE
"@
    Write-Utf8File -Path $Path -Text $script.Replace("`n", "`r`n")
}

function Copy-RuntimeFiles {
    param(
        [Parameter(Mandatory)] [string] $DestinationRoot,
        [Parameter(Mandatory)] [string] $Platform
    )
    Write-Step "copy runtime files: $DestinationRoot"
    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationRoot ".codexio") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $ProjectRoot "dist") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "package.json") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "pnpm-lock.yaml") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "instruction.md") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "README.md") $DestinationRoot
    Write-Utf8File -Path (Join-Path $DestinationRoot ".codexio\release.json") -Text (@{
        platform = $Platform
        version = $script:Version
    } | ConvertTo-Json -Compress)
}

function Copy-PackageConfig {
    param([Parameter(Mandatory)] [string] $DestinationRoot)
    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationRoot ".codexio") | Out-Null
    Copy-Item -Force (Join-Path $ProjectRoot "config.example.yaml") (Join-Path $DestinationRoot ".codexio\config.yaml")
}

function New-StandalonePackage {
    param([Parameter(Mandatory)] [string] $NodeRoot)
    New-Item -ItemType Directory -Force -Path $StandaloneRoot | Out-Null
    Copy-PackageConfig -DestinationRoot $StandaloneRoot
    Copy-RuntimeFiles -DestinationRoot $StandaloneRoot -Platform "windows-x64-standalone"
    Copy-ServiceWrapper -DestinationRoot $StandaloneRoot
    New-ServiceXml -Path (Join-Path $StandaloneRoot ".codexio\codexio-service.xml") -Executable "powershell.exe" -Arguments "-NoProfile -ExecutionPolicy Bypass -File ""%BASE%\..\nodew.ps1"" ""%BASE%\..\dist\Server.js"" --config ""%BASE%\config.yaml"""
    New-ServiceCommandFiles -DestinationRoot $StandaloneRoot -EnsureDependencies
    New-NodewFile -Path (Join-Path $StandaloneRoot "nodew.ps1")
    Write-Step "copy bundled Node.js runtime"
    Copy-Item -Recurse -Force $NodeRoot (Join-Path $StandaloneRoot ".codexio\node")
    Write-Step "copy production dependencies"
    Copy-Item -Recurse -Force (Join-Path $InstallRoot "node_modules") $StandaloneRoot
    Assert-PathExists (Join-Path $StandaloneRoot ".codexio\codexio-service.exe")
    Assert-PathExists (Join-Path $StandaloneRoot ".codexio\codexio-service.xml")
    Assert-PathExists (Join-Path $StandaloneRoot "service.ps1")
    Assert-PathExists (Join-Path $StandaloneRoot "nodew.ps1")
    Assert-PathExists (Join-Path $StandaloneRoot ".codexio\node\node.exe")
    Assert-PathExists (Join-Path $StandaloneRoot "node_modules\@openai\codex-win32-x64\package.json")
    Assert-PathExists (Join-Path $StandaloneRoot "node_modules\@anthropic-ai\claude-code-win32-x64\package.json")
}

function New-PnpmPackage {
    param([Parameter(Mandatory)] [string] $PnpmRuntimeRoot)
    New-Item -ItemType Directory -Force -Path $PnpmRoot | Out-Null
    Copy-PackageConfig -DestinationRoot $PnpmRoot
    Copy-RuntimeFiles -DestinationRoot $PnpmRoot -Platform "windows-x64-pnpm"
    Copy-ServiceWrapper -DestinationRoot $PnpmRoot
    New-ServiceXml -Path (Join-Path $PnpmRoot ".codexio\codexio-service.xml") -Executable "powershell.exe" -Arguments "-NoProfile -ExecutionPolicy Bypass -File ""%BASE%\..\nodew.ps1"" ""%BASE%\..\dist\Server.js"" --config ""%BASE%\config.yaml"""
    Write-Step "copy bundled pnpm runtime"
    Copy-Item -Recurse -Force $PnpmRuntimeRoot (Join-Path $PnpmRoot ".codexio\pnpm")
    Assert-PathExists (Join-Path $PnpmRoot ".codexio\pnpm\bin\pnpm.cjs")
    Write-Step "write pnpm package bootstrap scripts"
    New-NodewFile -Path (Join-Path $PnpmRoot "nodew.ps1")
    New-ServiceCommandFiles -DestinationRoot $PnpmRoot -EnsureDependencies
    Assert-PathExists (Join-Path $PnpmRoot ".codexio\codexio-service.exe")
    Assert-PathExists (Join-Path $PnpmRoot ".codexio\codexio-service.xml")
    Assert-PathExists (Join-Path $PnpmRoot "nodew.ps1")
    Assert-PathExists (Join-Path $PnpmRoot "service.ps1")
}

function Compress-Package {
    param(
        [Parameter(Mandatory)] [string] $SourceRoot,
        [Parameter(Mandatory)] [string] $ArchivePath,
        [Parameter(Mandatory)] [string[]] $Entries,
        [Parameter(Mandatory)] [System.IO.Compression.CompressionLevel] $CompressionLevel
    )
    if (Test-Path -Path $ArchivePath) {
        Remove-PathWithRetry -Path $ArchivePath
    }
    Write-Step "write archive: $ArchivePath"
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $sourceParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $SourceRoot))
    if (-not $sourceParent.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $sourceParent = $sourceParent + [System.IO.Path]::DirectorySeparatorChar
    }
    $zip = [System.IO.Compression.ZipFile]::Open($ArchivePath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = Get-ChildItem -Path $SourceRoot -Recurse -File
        foreach ($file in $files) {
            $fullPath = [System.IO.Path]::GetFullPath($file.FullName)
            if (-not $fullPath.StartsWith($sourceParent, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "File is outside source root: $fullPath"
            }
            $relativePath = $fullPath.Substring($sourceParent.Length).Replace("\", "/")
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relativePath, $CompressionLevel) | Out-Null
        }
    }
    finally {
        $zip.Dispose()
    }
    Write-Step "verify archive contents"
    Assert-ArchiveContains $ArchivePath $Entries
    $file = Get-Item -Path $ArchivePath
    Write-Step "created: $ArchivePath"
    Write-Step "size: $($file.Length) bytes"
}

function Publish-Package {
    param(
        [Parameter(Mandatory)] [string] $Platform,
        [Parameter(Mandatory)] [string] $ArchivePath,
        [Parameter(Mandatory)] [string] $Version,
        [Parameter(Mandatory)] [string] $BaseUrl,
        [Parameter(Mandatory)] [hashtable] $Headers
    )
    if (-not (Test-Path -Path $ArchivePath)) {
        throw "Release zip not found: $ArchivePath"
    }
    $file = Get-Item -Path $ArchivePath
    $sha256 = Get-ZipSha256 -Path $ArchivePath
    Write-Step "built: $ArchivePath"
    Write-Step "platform: $Platform"
    Write-Step "size: $($file.Length) bytes"
    Write-Step "SHA256: $sha256"
    $createBody = @{
        platform = $Platform
        version = $Version
        fileName = $file.Name
        fileSizeBytes = $file.Length
        sha256 = $sha256
        mimeType = "application/zip"
        access = "PUBLIC"
    }
    $createUri = "$BaseUrl/apim/download/release/codexio"
    $completeUri = "$BaseUrl/apim/download/release/codexio/$Version/complete"
    Write-Step "request upload URL: $Platform"
    $uploadData = Invoke-NfircoApi -Uri $createUri -Body $createBody -Headers $Headers
    if ($null -eq $uploadData -or [string]::IsNullOrWhiteSpace($uploadData.uploadUrl)) {
        throw "Nfirco API did not return uploadUrl"
    }
    Write-Step "upload package to OSS: $Platform"
    $requestOptions = New-HttpCommandOptions -CommandName "Invoke-WebRequest"
    Invoke-WebRequest -Uri $uploadData.uploadUrl -Method Put -InFile $ArchivePath -ContentType "application/zip" -UseBasicParsing -TimeoutSec 900 @requestOptions | Out-Null
    Write-Step "complete release record: $Platform"
    Invoke-NfircoApi -Uri $completeUri -Body @{ platform = $Platform } -Headers $Headers | Out-Null
    Write-Step "package published: $Platform"
}

Push-Location $ProjectRoot
try {
    $supportedPlatforms = @("windows-x64-pnpm", "windows-x64-standalone")
    $selectedPlatforms = @($supportedPlatforms | Where-Object { $Platforms -contains $_ })
    if ($selectedPlatforms.Count -ne $Platforms.Count) {
        throw "Unsupported platform. Supported platforms: $($supportedPlatforms -join ', ')"
    }
    $buildStandalone = $selectedPlatforms -contains "windows-x64-standalone"
    $buildPnpm = $selectedPlatforms -contains "windows-x64-pnpm"

    $script:Version = Read-ProjectVersion
    $standaloneArchive = Join-Path $ReleaseRoot "$PackageName-$script:Version-windows-x64-standalone.zip"
    $pnpmArchive = Join-Path $ReleaseRoot "$PackageName-$script:Version-windows-x64-pnpm.zip"
    $baseUrl = "https://$AppDomain"
    $adminApiHeaders = $null
    Write-Step "version: $script:Version"
    Write-Step "platforms: $($selectedPlatforms -join ', ')"
    if ($buildStandalone) {
        $nodeRoot = Resolve-NodeRoot
        Write-Step "Node: $nodeRoot"
    }
    if ($buildPnpm) {
        $pnpmRuntimeRoot = Resolve-PnpmRoot
        Write-Step "pnpm runtime: $pnpmRuntimeRoot"
    }

    $durations = @{}

    $durations["clean"] = Measure-Step -Name "clean previous build artifacts" -Action {
        if (Test-Path -Path $BuildRoot) {
            Remove-PathWithRetry -Path $BuildRoot
        }
        if (Test-Path -Path $ReleaseRoot) {
            Remove-PathWithRetry -Path $ReleaseRoot
        }
        if (Test-Path -Path (Join-Path $ProjectRoot "dist")) {
            Remove-PathWithRetry -Path (Join-Path $ProjectRoot "dist")
        }
    }

    Write-Step "create build directories"
    New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

    $durations["test"] = Measure-Step -Name "test" -Action {
        Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("test")
    }

    $durations["build"] = Measure-Step -Name "build" -Action {
        Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("build")
    }

    if ($buildPnpm) {
        $durations["assemble windows-x64-pnpm"] = Measure-Step -Name "assemble pnpm package" -Action {
            New-PnpmPackage -PnpmRuntimeRoot $pnpmRuntimeRoot
        }
    }

    if ($buildStandalone) {
        $durations["install production dependencies"] = Measure-Step -Name "install production dependencies" -Action {
            Copy-Item -Force (Join-Path $ProjectRoot "package.json") $InstallRoot
            Copy-Item -Force (Join-Path $ProjectRoot "pnpm-lock.yaml") $InstallRoot
            Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("install", "--prod", "--dir", $InstallRoot, "--config.node-linker=hoisted")
        }

        $durations["assemble windows-x64-standalone"] = Measure-Step -Name "assemble standalone package" -Action {
            New-StandalonePackage -NodeRoot $nodeRoot
        }
    }

    if ($buildPnpm) {
        $durations["compress windows-x64-pnpm"] = Measure-Step -Name "compress pnpm package" -Action {
            Compress-Package -SourceRoot $PnpmRoot -ArchivePath $pnpmArchive -CompressionLevel ([System.IO.Compression.CompressionLevel]::NoCompression) -Entries @(
                "codexio/.codexio/codexio-service.exe",
                "codexio/.codexio/codexio-service.xml",
                "codexio/install.cmd",
                "codexio/uninstall.cmd",
                "codexio/start.cmd",
                "codexio/stop.cmd",
                "codexio/restart.cmd",
                "codexio/service.ps1",
                "codexio/.codexio/config.yaml",
                "codexio/.codexio/release.json",
                "codexio/dist/Server.js",
                "codexio/package.json",
                "codexio/pnpm-lock.yaml",
                "codexio/nodew.ps1",
                "codexio/.codexio/pnpm/bin/pnpm.cjs"
            )
        }
        if (-not $BuildOnly) {
            if ($null -eq $adminApiHeaders) {
                $adminApiHeaders = Read-AdminApiHeaders
            }
            $durations["publish windows-x64-pnpm"] = Measure-Step -Name "publish windows-x64-pnpm" -Action {
                Publish-Package -Platform "windows-x64-pnpm" -ArchivePath $pnpmArchive -Version $script:Version -BaseUrl $baseUrl -Headers $adminApiHeaders
            }
        }
    }

    if ($buildStandalone) {
        $durations["compress windows-x64-standalone"] = Measure-Step -Name "compress standalone package" -Action {
            Compress-Package -SourceRoot $StandaloneRoot -ArchivePath $standaloneArchive -CompressionLevel ([System.IO.Compression.CompressionLevel]::Optimal) -Entries @(
                "codexio/.codexio/codexio-service.exe",
                "codexio/.codexio/codexio-service.xml",
                "codexio/install.cmd",
                "codexio/uninstall.cmd",
                "codexio/start.cmd",
                "codexio/stop.cmd",
                "codexio/restart.cmd",
                "codexio/service.ps1",
                "codexio/.codexio/config.yaml",
                "codexio/.codexio/release.json",
                "codexio/nodew.ps1",
                "codexio/.codexio/node/node.exe",
                "codexio/dist/Server.js",
                "codexio/node_modules/@openai/codex/bin/codex.js",
                "codexio/node_modules/@openai/codex-win32-x64/package.json",
                "codexio/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs",
                "codexio/node_modules/@anthropic-ai/claude-code-win32-x64/package.json"
            )
        }
        if (-not $BuildOnly) {
            if ($null -eq $adminApiHeaders) {
                $adminApiHeaders = Read-AdminApiHeaders
            }
            $durations["publish windows-x64-standalone"] = Measure-Step -Name "publish windows-x64-standalone" -Action {
                Publish-Package -Platform "windows-x64-standalone" -ArchivePath $standaloneArchive -Version $script:Version -BaseUrl $baseUrl -Headers $adminApiHeaders
            }
        }
    }

    Write-Step "summary"
    foreach ($name in $durations.Keys) {
        Write-Step "$name`: $(Format-Duration -Duration $durations[$name])"
    }

    if ($BuildOnly) {
        Write-Step "build only completed"
        return
    }

    Write-Step "release summary"
    foreach ($name in $durations.Keys) {
        Write-Step "$name`: $(Format-Duration -Duration $durations[$name])"
    }
    Write-Step "release page updated: $baseUrl/manage/nfirco/release"
}
finally {
    Pop-Location
}
