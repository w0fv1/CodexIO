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

function Read-AdminApiHeaders {
    . (Join-Path $RepoRoot "script\NfircoBackendApiCredential.ps1")
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
    $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec 60
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

function New-CommandFile {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Command,
        [Parameter(Mandatory)] [string] $Title
    )
    $text = @"
@echo off
echo [codexio] $Title
cd /d %~dp0
echo [codexio] working directory: %CD%
$Command
if errorlevel 1 goto failed
echo [codexio] done
goto end
:failed
echo [codexio] command failed
:end
pause
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function New-PnpmNodewFile {
    param(
        [Parameter(Mandatory)] [string] $CmdPath
    )
    $text = @"
@echo off
echo [codexio nodew] preparing Node.js runtime
set "CODEXIO_NODEW_SCRIPT=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "`$marker = '# POWERSHELL'; `$scriptPath = `$env:CODEXIO_NODEW_SCRIPT; `$text = [System.IO.File]::ReadAllText(`$scriptPath); `$index = `$text.LastIndexOf(`$marker); if (`$index -lt 0) { throw 'nodew PowerShell marker not found' }; `$script = `$text.Substring(`$index + `$marker.Length); & ([scriptblock]::Create(`$script)) @args" -- %*
exit /b %ERRORLEVEL%
# POWERSHELL
`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

`$Root = Split-Path -Parent `$env:CODEXIO_NODEW_SCRIPT
`$RuntimeRoot = Join-Path `$Root "runtime\node"
`$LocalNode = Join-Path `$RuntimeRoot "node.exe"
`$PnpmRoot = Join-Path `$Root "runtime\pnpm"
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
    throw "Node.js download failed. Delete .codexio\download and retry, or manually extract node-v`$NodeVersion-win-x64.zip to runtime\node."
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
    Write-Utf8File -Path $CmdPath -Text $text.Replace("`n", "`r`n")
}

function New-PnpmCommandFile {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Action,
        [Parameter(Mandatory)] [string] $Command
    )
    $text = @"
@echo off
echo [codexio] $Action Codexio
cd /d %~dp0
echo [codexio] working directory: %CD%
echo [codexio] checking production dependencies
if not exist codexio\node_modules\@openai\codex\bin\codex.js goto install
if not exist codexio\node_modules\@openai\codex-win32-x64\package.json goto install
if not exist codexio\node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs goto install
if not exist codexio\node_modules\@anthropic-ai\claude-code-win32-x64\package.json goto install
echo [codexio] dependencies are ready
goto start
:install
echo [codexio] dependencies are missing, installing production dependencies
call "%~dp0codexio\nodew.cmd" pnpm install --prod --dir "%~dp0codexio" --config.node-linker=hoisted
if errorlevel 1 goto failed
echo [codexio] dependencies installed
:start
echo [codexio] running $Action
call "%~dp0codexio\nodew.cmd" codexio\dist\index.js $Command --config "%~dp0config.yaml"
if errorlevel 1 goto failed
echo [codexio] $Action done
goto end
:failed
echo [codexio] command failed
:end
pause
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
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
    Copy-Item -Force (Join-Path $ProjectRoot "config.example.yaml") (Join-Path $DestinationRoot "config.yaml")
}

function New-StandalonePackage {
    param([Parameter(Mandatory)] [string] $NodeRoot)
    New-Item -ItemType Directory -Force -Path $StandaloneRoot | Out-Null
    $appRoot = Join-Path $StandaloneRoot "codexio"
    New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
    Copy-PackageConfig -DestinationRoot $StandaloneRoot
    Copy-RuntimeFiles -DestinationRoot $appRoot -Platform "windows-x64-standalone"
    Write-Step "copy bundled Node.js runtime"
    New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "runtime") | Out-Null
    Copy-Item -Recurse -Force $NodeRoot (Join-Path $appRoot "runtime\node")
    Write-Step "copy production dependencies"
    Copy-Item -Recurse -Force (Join-Path $InstallRoot "node_modules") $appRoot
    New-CommandFile -Path (Join-Path $StandaloneRoot "start.cmd") -Command "codexio\runtime\node\node.exe codexio\dist\index.js start --config ""%~dp0config.yaml""" -Title "start Codexio with bundled Node.js"
    New-CommandFile -Path (Join-Path $StandaloneRoot "restart.cmd") -Command "codexio\runtime\node\node.exe codexio\dist\index.js restart --config ""%~dp0config.yaml""" -Title "restart Codexio with bundled Node.js"
    New-CommandFile -Path (Join-Path $StandaloneRoot "update.cmd") -Command "codexio\runtime\node\node.exe codexio\dist\index.js update --config ""%~dp0config.yaml""" -Title "update Codexio with bundled Node.js"
    Assert-PathExists (Join-Path $appRoot "runtime\node\node.exe")
    Assert-PathExists (Join-Path $appRoot "node_modules\@openai\codex-win32-x64\package.json")
    Assert-PathExists (Join-Path $appRoot "node_modules\@anthropic-ai\claude-code-win32-x64\package.json")
}

function New-PnpmPackage {
    param([Parameter(Mandatory)] [string] $PnpmRuntimeRoot)
    New-Item -ItemType Directory -Force -Path $PnpmRoot | Out-Null
    $appRoot = Join-Path $PnpmRoot "codexio"
    New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
    Copy-PackageConfig -DestinationRoot $PnpmRoot
    Copy-RuntimeFiles -DestinationRoot $appRoot -Platform "windows-x64-pnpm"
    Write-Step "copy bundled pnpm runtime"
    New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "runtime") | Out-Null
    Copy-Item -Recurse -Force $PnpmRuntimeRoot (Join-Path $appRoot "runtime\pnpm")
    Assert-PathExists (Join-Path $appRoot "runtime\pnpm\bin\pnpm.cjs")
    Write-Step "write pnpm package bootstrap scripts"
    New-PnpmNodewFile -CmdPath (Join-Path $appRoot "nodew.cmd")
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "start.cmd") -Action "start" -Command "start"
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "restart.cmd") -Action "restart" -Command "restart"
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "update.cmd") -Action "update" -Command "update"
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
    Invoke-WebRequest -Uri $uploadData.uploadUrl -Method Put -InFile $ArchivePath -ContentType "application/zip" -UseBasicParsing -TimeoutSec 900 | Out-Null
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
                "codexio/start.cmd",
                "codexio/restart.cmd",
                "codexio/update.cmd",
                "codexio/config.yaml",
                "codexio/codexio/dist/index.js",
                "codexio/codexio/package.json",
                "codexio/codexio/pnpm-lock.yaml",
                "codexio/codexio/nodew.cmd",
                "codexio/codexio/runtime/pnpm/bin/pnpm.cjs",
                "codexio/codexio/.codexio/release.json"
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
                "codexio/start.cmd",
                "codexio/restart.cmd",
                "codexio/update.cmd",
                "codexio/config.yaml",
                "codexio/codexio/runtime/node/node.exe",
                "codexio/codexio/dist/index.js",
                "codexio/codexio/node_modules/@openai/codex/bin/codex.js",
                "codexio/codexio/node_modules/@openai/codex-win32-x64/package.json",
                "codexio/codexio/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs",
                "codexio/codexio/node_modules/@anthropic-ai/claude-code-win32-x64/package.json",
                "codexio/codexio/.codexio/release.json"
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
