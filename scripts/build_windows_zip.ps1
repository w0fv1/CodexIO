param(
    [string[]] $Platforms = @("windows-x64-standalone", "windows-x64-pnpm")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BuildRoot = Join-Path $ProjectRoot "build"
$InstallRoot = Join-Path $BuildRoot "production-install"
$ReleaseRoot = Join-Path $ProjectRoot "release"
$PackageJsonPath = Join-Path $ProjectRoot "package.json"
$PackageName = "codexio"
$StandaloneRoot = Join-Path $BuildRoot "standalone\codexio"
$PnpmRoot = Join-Path $BuildRoot "pnpm\codexio"
$SmokeRoot = Join-Path $BuildRoot "release-smoke"
$NodeRuntimeVersion = "22.20.0"
$PnpmRuntimeVersion = "10.33.4"

function Write-Step {
    param([Parameter(Mandatory)] [string] $Text)
    Write-Host "[codexio package] $Text"
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
        [Parameter(Mandatory)] [string] $CmdPath,
        [Parameter(Mandatory)] [string] $PsPath
    )
    $cmd = "@echo off`r`necho [codexio nodew] preparing Node.js runtime`r`npowershell -ExecutionPolicy Bypass -File ""%~dp0nodew.ps1"" %*`r`nexit /b %ERRORLEVEL%`r`n"
    Write-Utf8File -Path $CmdPath -Text $cmd
    $text = @"
`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

`$Root = Split-Path -Parent `$MyInvocation.MyCommand.Path
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
    Write-Utf8File -Path $PsPath -Text $text.Replace("`n", "`r`n")
}

function New-PnpmCommandFile {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $Commands,
        [Parameter(Mandatory)] [string] $Title
    )
    $body = ($Commands | ForEach-Object {
        "echo [codexio] running step`r`ncall $_`r`nif errorlevel 1 goto failed"
    }) -join "`r`n"
    $text = @"
@echo off
echo [codexio] $Title
cd /d %~dp0
echo [codexio] working directory: %CD%
$body
echo [codexio] done
goto end
:failed
echo [codexio] command failed
:end
pause
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function New-PnpmStartFile {
    param([Parameter(Mandatory)] [string] $Path)
    $text = @"
@echo off
echo [codexio] start Codexio
cd /d %~dp0
echo [codexio] working directory: %CD%
echo [codexio] checking production dependencies
if not exist node_modules\@openai\codex\bin\codex.js goto install
if not exist node_modules\@openai\codex-win32-x64\package.json goto install
if not exist node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs goto install
if not exist node_modules\@anthropic-ai\claude-code-win32-x64\package.json goto install
echo [codexio] dependencies are ready
goto start
:install
echo [codexio] dependencies are missing, installing production dependencies
call "%~dp0nodew.cmd" pnpm install --prod --config.node-linker=hoisted
if errorlevel 1 goto failed
echo [codexio] dependencies installed
:start
echo [codexio] launching local server
call "%~dp0nodew.cmd" dist\index.js serve
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
    Copy-Item -Recurse -Force (Join-Path $ProjectRoot "examples") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "package.json") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "pnpm-lock.yaml") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "instruction.md") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "README.md") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "examples\config.yaml") (Join-Path $DestinationRoot ".codexio\config.yaml")
    Write-Utf8File -Path (Join-Path $DestinationRoot "VERSION") -Text "$script:Version`n"
    Write-Utf8File -Path (Join-Path $DestinationRoot ".codexio\release.json") -Text (@{
        platform = $Platform
    } | ConvertTo-Json -Compress)
}

function New-StandalonePackage {
    param([Parameter(Mandatory)] [string] $NodeRoot)
    New-Item -ItemType Directory -Force -Path $StandaloneRoot | Out-Null
    Copy-RuntimeFiles -DestinationRoot $StandaloneRoot -Platform "windows-x64-standalone"
    Write-Step "copy bundled Node.js runtime"
    New-Item -ItemType Directory -Force -Path (Join-Path $StandaloneRoot "runtime") | Out-Null
    Copy-Item -Recurse -Force $NodeRoot (Join-Path $StandaloneRoot "runtime\node")
    Write-Step "copy production dependencies"
    Copy-Item -Recurse -Force (Join-Path $InstallRoot "node_modules") $StandaloneRoot
    New-CommandFile -Path (Join-Path $StandaloneRoot "start.cmd") -Command "runtime\node\node.exe dist\index.js serve" -Title "start Codexio with bundled Node.js"
    New-CommandFile -Path (Join-Path $StandaloneRoot "login.cmd") -Command "runtime\node\node.exe dist\index.js login" -Title "start Codex login with bundled Node.js"
    Assert-PathExists (Join-Path $StandaloneRoot "runtime\node\node.exe")
    Assert-PathExists (Join-Path $StandaloneRoot "node_modules\@openai\codex-win32-x64\package.json")
    Assert-PathExists (Join-Path $StandaloneRoot "node_modules\@anthropic-ai\claude-code-win32-x64\package.json")
}

function New-PnpmPackage {
    param([Parameter(Mandatory)] [string] $PnpmRuntimeRoot)
    New-Item -ItemType Directory -Force -Path $PnpmRoot | Out-Null
    Copy-RuntimeFiles -DestinationRoot $PnpmRoot -Platform "windows-x64-pnpm"
    Write-Step "copy bundled pnpm runtime"
    New-Item -ItemType Directory -Force -Path (Join-Path $PnpmRoot "runtime") | Out-Null
    Copy-Item -Recurse -Force $PnpmRuntimeRoot (Join-Path $PnpmRoot "runtime\pnpm")
    Assert-PathExists (Join-Path $PnpmRoot "runtime\pnpm\bin\pnpm.cjs")
    Write-Step "write pnpm package bootstrap scripts"
    New-PnpmNodewFile -CmdPath (Join-Path $PnpmRoot "nodew.cmd") -PsPath (Join-Path $PnpmRoot "nodew.ps1")
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "install.cmd") -Commands @('"%~dp0nodew.cmd" pnpm install --prod --config.node-linker=hoisted') -Title "install Codexio production dependencies"
    New-PnpmStartFile -Path (Join-Path $PnpmRoot "start.cmd")
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "login.cmd") -Commands @('"%~dp0nodew.cmd" dist\index.js login') -Title "start Codex login"
}

function Compress-Package {
    param(
        [Parameter(Mandatory)] [string] $SourceRoot,
        [Parameter(Mandatory)] [string] $ArchivePath,
        [Parameter(Mandatory)] [string[]] $Entries
    )
    if (Test-Path -Path $ArchivePath) {
        Remove-Item -Force $ArchivePath
    }
    Write-Step "write archive: $ArchivePath"
    Compress-Archive -Path $SourceRoot -DestinationPath $ArchivePath -CompressionLevel Optimal
    Write-Step "verify archive contents"
    Assert-ArchiveContains $ArchivePath $Entries
    $file = Get-Item -Path $ArchivePath
    Write-Step "created: $ArchivePath"
    Write-Step "size: $($file.Length) bytes"
}

function Invoke-StandaloneSmoke {
    param([Parameter(Mandatory)] [string] $ArchivePath)
    $extractRoot = Join-Path $SmokeRoot "standalone"
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Write-Step "extract standalone package for smoke test"
    Expand-Archive -Path $ArchivePath -DestinationPath $extractRoot -Force
    $root = Join-Path $extractRoot "codexio"
    $nodeExe = Join-Path $root "runtime\node\node.exe"
    Write-Step "check Codexio CLI version"
    Invoke-CheckedCommand -FilePath $nodeExe -ArgumentList @("dist\index.js", "--version") -WorkingDirectory $root
    Write-Step "check Codex CLI version"
    Invoke-CheckedCommand -FilePath $nodeExe -ArgumentList @("node_modules\@openai\codex\bin\codex.js", "--version") -WorkingDirectory $root
    Write-Step "check Claude CLI version"
    Invoke-CheckedCommand -FilePath $nodeExe -ArgumentList @("node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs", "--version") -WorkingDirectory $root
}

function Invoke-PnpmSmoke {
    param([Parameter(Mandatory)] [string] $ArchivePath)
    $extractRoot = Join-Path $SmokeRoot "pnpm"
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Write-Step "extract pnpm package for smoke test"
    Expand-Archive -Path $ArchivePath -DestinationPath $extractRoot -Force
    $root = Join-Path $extractRoot "codexio"
    Assert-PathExists (Join-Path $root "nodew.cmd")
    Assert-PathExists (Join-Path $root "nodew.ps1")
    $startText = Get-Content -Raw -Path (Join-Path $root "start.cmd")
    $installText = Get-Content -Raw -Path (Join-Path $root "install.cmd")
    $loginText = Get-Content -Raw -Path (Join-Path $root "login.cmd")
    if (-not $startText.Contains('"%~dp0nodew.cmd"') -or -not $installText.Contains('"%~dp0nodew.cmd"') -or -not $loginText.Contains('"%~dp0nodew.cmd"')) {
        throw "pnpm command files must call nodew.cmd from script directory"
    }
    Write-Step "check nodew bootstrap"
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", ".\nodew.cmd", "--version") -WorkingDirectory $root
    Write-Step "install pnpm package dependencies"
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", ".\nodew.cmd", "pnpm", "install", "--prod", "--config.node-linker=hoisted") -WorkingDirectory $root
    Write-Step "check Codexio CLI version"
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", ".\nodew.cmd", "dist\index.js", "--version") -WorkingDirectory $root
    Write-Step "check Codex CLI version"
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", ".\nodew.cmd", "node_modules\@openai\codex\bin\codex.js", "--version") -WorkingDirectory $root
    Write-Step "check Claude CLI version"
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", ".\nodew.cmd", "node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs", "--version") -WorkingDirectory $root
}
Push-Location $ProjectRoot
try {
    $supportedPlatforms = @("windows-x64-standalone", "windows-x64-pnpm")
    $selectedPlatforms = @($supportedPlatforms | Where-Object { $Platforms -contains $_ })
    if ($selectedPlatforms.Count -ne $Platforms.Count) {
        throw "Unsupported platform. Supported platforms: $($supportedPlatforms -join ', ')"
    }
    $buildStandalone = $selectedPlatforms -contains "windows-x64-standalone"
    $buildPnpm = $selectedPlatforms -contains "windows-x64-pnpm"

    $script:Version = Read-ProjectVersion
    $standaloneArchive = Join-Path $ReleaseRoot "$PackageName-$script:Version-windows-x64-standalone.zip"
    $pnpmArchive = Join-Path $ReleaseRoot "$PackageName-$script:Version-windows-x64-pnpm.zip"
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

    Write-Step "clean previous build artifacts"
    if (Test-Path -Path $BuildRoot) {
        Remove-Item -Recurse -Force $BuildRoot
    }
    if (Test-Path -Path $ReleaseRoot) {
        Remove-Item -Recurse -Force $ReleaseRoot
    }
    if (Test-Path -Path (Join-Path $ProjectRoot "dist")) {
        Remove-Item -Recurse -Force (Join-Path $ProjectRoot "dist")
    }

    Write-Step "create build directories"
    New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

    Write-Step "test"
    Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("test")

    Write-Step "build"
    Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("build")

    if ($buildStandalone) {
        Write-Step "install production dependencies"
        Copy-Item -Force (Join-Path $ProjectRoot "package.json") $InstallRoot
        Copy-Item -Force (Join-Path $ProjectRoot "pnpm-lock.yaml") $InstallRoot
        Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("install", "--prod", "--dir", $InstallRoot, "--config.node-linker=hoisted")

        Write-Step "assemble standalone package"
        New-StandalonePackage -NodeRoot $nodeRoot
    }

    if ($buildPnpm) {
        Write-Step "assemble pnpm package"
        New-PnpmPackage -PnpmRuntimeRoot $pnpmRuntimeRoot
    }

    if ($buildStandalone) {
        Write-Step "compress standalone package"
        Compress-Package -SourceRoot $StandaloneRoot -ArchivePath $standaloneArchive -Entries @(
            "codexio/runtime/node/node.exe",
            "codexio/dist/index.js",
            "codexio/node_modules/@openai/codex/bin/codex.js",
            "codexio/node_modules/@openai/codex-win32-x64/package.json",
            "codexio/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs",
            "codexio/node_modules/@anthropic-ai/claude-code-win32-x64/package.json",
            "codexio/.codexio/config.yaml",
            "codexio/start.cmd",
            "codexio/.codexio/release.json",
            "codexio/VERSION"
        )

        Write-Step "smoke standalone package"
        Invoke-StandaloneSmoke -ArchivePath $standaloneArchive
    }

    if ($buildPnpm) {
        Write-Step "compress pnpm package"
        Compress-Package -SourceRoot $PnpmRoot -ArchivePath $pnpmArchive -Entries @(
            "codexio/dist/index.js",
            "codexio/package.json",
            "codexio/pnpm-lock.yaml",
            "codexio/.codexio/config.yaml",
            "codexio/nodew.cmd",
            "codexio/nodew.ps1",
            "codexio/runtime/pnpm/bin/pnpm.cjs",
            "codexio/install.cmd",
            "codexio/start.cmd",
            "codexio/.codexio/release.json",
            "codexio/VERSION"
        )

        Write-Step "smoke pnpm package"
        Invoke-PnpmSmoke -ArchivePath $pnpmArchive
    }
}
finally {
    Pop-Location
}
