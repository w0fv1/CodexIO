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
$NodeRuntimeVersion = "22.21.1"
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
        [Parameter(Mandatory)] [string] $Command
    )
    $text = "@echo off`r`ncd /d %~dp0`r`n$Command`r`npause`r`n"
    Write-Utf8File -Path $Path -Text $text
}

function New-PnpmNodewFile {
    param(
        [Parameter(Mandatory)] [string] $CmdPath,
        [Parameter(Mandatory)] [string] $PsPath
    )
    $cmd = "@echo off`r`npowershell -ExecutionPolicy Bypass -File ""%~dp0nodew.ps1"" %*`r`nexit /b %ERRORLEVEL%`r`n"
    Write-Utf8File -Path $CmdPath -Text $cmd
    $text = @"
`$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

`$Root = Split-Path -Parent `$MyInvocation.MyCommand.Path
`$RuntimeRoot = Join-Path `$Root "runtime\node"
`$LocalNode = Join-Path `$RuntimeRoot "node.exe"
`$NodeVersion = "$NodeRuntimeVersion"

function Resolve-SystemCommand {
    param([Parameter(Mandatory)] [string] `$Name)
    `$command = Get-Command `$Name -ErrorAction SilentlyContinue
    if (`$null -eq `$command) {
        return `$null
    }
    return `$command.Source
}

function Install-LocalNode {
    `$archiveName = "node-v`$NodeVersion-win-x64.zip"
    `$archiveUrl = "https://nodejs.org/dist/v`$NodeVersion/`$archiveName"
    `$downloadDir = Join-Path `$Root ".codexio\download"
    `$archivePath = Join-Path `$downloadDir `$archiveName
    `$extractDir = Join-Path `$downloadDir "node-extract"
    New-Item -ItemType Directory -Force -Path `$downloadDir | Out-Null
    if (-not (Test-Path -LiteralPath `$archivePath)) {
        Write-Host "downloading Node.js v`$NodeVersion"
        Invoke-WebRequest -Uri `$archiveUrl -OutFile `$archivePath
    }
    if (Test-Path -LiteralPath `$extractDir) {
        Remove-Item -Recurse -Force -LiteralPath `$extractDir
    }
    Expand-Archive -Path `$archivePath -DestinationPath `$extractDir -Force
    `$extractedRoot = Join-Path `$extractDir "node-v`$NodeVersion-win-x64"
    if (Test-Path -LiteralPath `$RuntimeRoot) {
        Remove-Item -Recurse -Force -LiteralPath `$RuntimeRoot
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent `$RuntimeRoot) | Out-Null
    Move-Item -LiteralPath `$extractedRoot -Destination `$RuntimeRoot
}

function Resolve-Node {
    if (Test-Path -LiteralPath `$LocalNode) {
        return `$LocalNode
    }
    `$systemNode = Resolve-SystemCommand -Name "node"
    if (-not [string]::IsNullOrWhiteSpace(`$systemNode)) {
        return `$systemNode
    }
    Install-LocalNode
    return `$LocalNode
}

function Resolve-Corepack {
    if (Test-Path -LiteralPath `$LocalNode) {
        `$localCorepack = Join-Path `$RuntimeRoot "corepack.cmd"
        if (Test-Path -LiteralPath `$localCorepack) {
            return `$localCorepack
        }
    }
    `$systemNode = Resolve-SystemCommand -Name "node"
    if (-not [string]::IsNullOrWhiteSpace(`$systemNode)) {
        `$systemCorepack = Join-Path (Split-Path -Parent `$systemNode) "corepack.cmd"
        if (Test-Path -LiteralPath `$systemCorepack) {
            return `$systemCorepack
        }
    }
    Install-LocalNode
    `$corepack = Join-Path `$RuntimeRoot "corepack.cmd"
    if (-not (Test-Path -LiteralPath `$corepack)) {
        throw "corepack not found"
    }
    return `$corepack
}

if (`$args.Count -gt 0 -and `$args[0] -eq "corepack") {
    `$command = Resolve-Corepack
    & `$command @(`$args | Select-Object -Skip 1)
    exit `$LASTEXITCODE
}

`$node = Resolve-Node
& `$node @args
exit `$LASTEXITCODE
"@
    Write-Utf8File -Path $PsPath -Text $text.Replace("`n", "`r`n")
}

function New-PnpmCommandFile {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string[]] $Commands
    )
    $body = ($Commands | ForEach-Object {
        "$_`r`nif errorlevel 1 goto failed"
    }) -join "`r`n"
    $text = @"
@echo off
cd /d %~dp0
$body
goto end
:failed
echo command failed
:end
pause
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function New-PnpmStartFile {
    param([Parameter(Mandatory)] [string] $Path)
    $text = @"
@echo off
cd /d %~dp0
if not exist node_modules\@openai\codex\bin\codex.js goto install
if not exist node_modules\@openai\codex-win32-x64\package.json goto install
if not exist node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs goto install
if not exist node_modules\@anthropic-ai\claude-code-win32-x64\package.json goto install
goto start
:install
nodew.cmd corepack pnpm@$PnpmRuntimeVersion install --prod --config.node-linker=hoisted
if errorlevel 1 goto failed
:start
nodew.cmd dist\index.js serve
goto end
:failed
echo command failed
:end
pause
"@
    Write-Utf8File -Path $Path -Text $text.Replace("`n", "`r`n")
}

function Copy-RuntimeFiles {
    param([Parameter(Mandatory)] [string] $DestinationRoot)
    New-Item -ItemType Directory -Force -Path (Join-Path $DestinationRoot ".codexio") | Out-Null
    Copy-Item -Recurse -Force (Join-Path $ProjectRoot "dist") $DestinationRoot
    Copy-Item -Recurse -Force (Join-Path $ProjectRoot "examples") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "package.json") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "pnpm-lock.yaml") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "instruction.md") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "README.md") $DestinationRoot
    Copy-Item -Force (Join-Path $ProjectRoot "examples\config.yaml") (Join-Path $DestinationRoot ".codexio\config.yaml")
    Write-Utf8File -Path (Join-Path $DestinationRoot "VERSION") -Text "$script:Version`n"
}

function New-StandalonePackage {
    param([Parameter(Mandatory)] [string] $NodeRoot)
    New-Item -ItemType Directory -Force -Path $StandaloneRoot | Out-Null
    Copy-RuntimeFiles -DestinationRoot $StandaloneRoot
    New-Item -ItemType Directory -Force -Path (Join-Path $StandaloneRoot "runtime") | Out-Null
    Copy-Item -Recurse -Force $NodeRoot (Join-Path $StandaloneRoot "runtime\node")
    Copy-Item -Recurse -Force (Join-Path $InstallRoot "node_modules") $StandaloneRoot
    New-CommandFile -Path (Join-Path $StandaloneRoot "start.cmd") -Command "runtime\node\node.exe dist\index.js serve"
    New-CommandFile -Path (Join-Path $StandaloneRoot "login.cmd") -Command "runtime\node\node.exe dist\index.js login"
    Assert-PathExists (Join-Path $StandaloneRoot "runtime\node\node.exe")
    Assert-PathExists (Join-Path $StandaloneRoot "node_modules\@openai\codex-win32-x64\package.json")
    Assert-PathExists (Join-Path $StandaloneRoot "node_modules\@anthropic-ai\claude-code-win32-x64\package.json")
}

function New-PnpmPackage {
    New-Item -ItemType Directory -Force -Path $PnpmRoot | Out-Null
    Copy-RuntimeFiles -DestinationRoot $PnpmRoot
    New-PnpmNodewFile -CmdPath (Join-Path $PnpmRoot "nodew.cmd") -PsPath (Join-Path $PnpmRoot "nodew.ps1")
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "install.cmd") -Commands @("nodew.cmd corepack pnpm@$PnpmRuntimeVersion install --prod --config.node-linker=hoisted")
    New-PnpmStartFile -Path (Join-Path $PnpmRoot "start.cmd")
    New-PnpmCommandFile -Path (Join-Path $PnpmRoot "login.cmd") -Commands @("nodew.cmd dist\index.js login")
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
    Compress-Archive -Path $SourceRoot -DestinationPath $ArchivePath -CompressionLevel Optimal
    Assert-ArchiveContains $ArchivePath $Entries
    $file = Get-Item -Path $ArchivePath
    Write-Step "created: $ArchivePath"
    Write-Step "size: $($file.Length) bytes"
}

function Invoke-StandaloneSmoke {
    param([Parameter(Mandatory)] [string] $ArchivePath)
    $extractRoot = Join-Path $SmokeRoot "standalone"
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -Path $ArchivePath -DestinationPath $extractRoot -Force
    $root = Join-Path $extractRoot "codexio"
    $nodeExe = Join-Path $root "runtime\node\node.exe"
    Invoke-CheckedCommand -FilePath $nodeExe -ArgumentList @("dist\index.js", "--version") -WorkingDirectory $root
    Invoke-CheckedCommand -FilePath $nodeExe -ArgumentList @("node_modules\@openai\codex\bin\codex.js", "--version") -WorkingDirectory $root
    Invoke-CheckedCommand -FilePath $nodeExe -ArgumentList @("node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs", "--version") -WorkingDirectory $root
}

function Invoke-PnpmSmoke {
    param([Parameter(Mandatory)] [string] $ArchivePath)
    $extractRoot = Join-Path $SmokeRoot "pnpm"
    New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
    Expand-Archive -Path $ArchivePath -DestinationPath $extractRoot -Force
    $root = Join-Path $extractRoot "codexio"
    Assert-PathExists (Join-Path $root "nodew.cmd")
    Assert-PathExists (Join-Path $root "nodew.ps1")
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", "nodew.cmd", "--version") -WorkingDirectory $root
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", "nodew.cmd", "corepack", "pnpm@$PnpmRuntimeVersion", "install", "--prod", "--config.node-linker=hoisted") -WorkingDirectory $root
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", "nodew.cmd", "dist\index.js", "--version") -WorkingDirectory $root
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", "nodew.cmd", "node_modules\@openai\codex\bin\codex.js", "--version") -WorkingDirectory $root
    Invoke-CheckedCommand -FilePath "cmd" -ArgumentList @("/c", "nodew.cmd", "node_modules\@anthropic-ai\claude-code\cli-wrapper.cjs", "--version") -WorkingDirectory $root
}

Push-Location $ProjectRoot
try {
    $script:Version = Read-ProjectVersion
    $nodeRoot = Resolve-NodeRoot
    $standaloneArchive = Join-Path $ReleaseRoot "$PackageName-$script:Version-windows-x64-standalone.zip"
    $pnpmArchive = Join-Path $ReleaseRoot "$PackageName-$script:Version-windows-x64-pnpm.zip"
    Write-Step "version: $script:Version"
    Write-Step "Node: $nodeRoot"

    if (Test-Path -Path $BuildRoot) {
        Remove-Item -Recurse -Force $BuildRoot
    }
    if (Test-Path -Path $ReleaseRoot) {
        Remove-Item -Recurse -Force $ReleaseRoot
    }
    if (Test-Path -Path (Join-Path $ProjectRoot "dist")) {
        Remove-Item -Recurse -Force (Join-Path $ProjectRoot "dist")
    }

    New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

    Write-Step "test"
    Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("test")

    Write-Step "build"
    Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("build")

    Write-Step "install production dependencies"
    Copy-Item -Force (Join-Path $ProjectRoot "package.json") $InstallRoot
    Copy-Item -Force (Join-Path $ProjectRoot "pnpm-lock.yaml") $InstallRoot
    Invoke-CheckedCommand -FilePath "pnpm" -ArgumentList @("install", "--prod", "--dir", $InstallRoot, "--config.node-linker=hoisted")

    Write-Step "assemble standalone package"
    New-StandalonePackage -NodeRoot $nodeRoot

    Write-Step "assemble pnpm package"
    New-PnpmPackage

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
        "codexio/VERSION"
    )

    Write-Step "compress pnpm package"
    Compress-Package -SourceRoot $PnpmRoot -ArchivePath $pnpmArchive -Entries @(
        "codexio/dist/index.js",
        "codexio/package.json",
        "codexio/pnpm-lock.yaml",
        "codexio/.codexio/config.yaml",
        "codexio/nodew.cmd",
        "codexio/nodew.ps1",
        "codexio/install.cmd",
        "codexio/start.cmd",
        "codexio/VERSION"
    )

    Write-Step "smoke standalone package"
    Invoke-StandaloneSmoke -ArchivePath $standaloneArchive

    Write-Step "smoke pnpm package"
    Invoke-PnpmSmoke -ArchivePath $pnpmArchive
}
finally {
    Pop-Location
}
