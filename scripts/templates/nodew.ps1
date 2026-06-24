$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$RuntimeRoot = Join-Path $Root ".codexio\node"
$LocalNode = Join-Path $RuntimeRoot "node.exe"
$PnpmRoot = Join-Path $Root ".codexio\pnpm"
$LocalPnpm = Join-Path $PnpmRoot "bin\pnpm.cjs"
$NodeVersion = "__NODE_RUNTIME_VERSION__"

function Test-ZipArchive {
    param([Parameter(Mandatory)] [string] $Path)
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
        try {
            return $zip.Entries.Count -gt 0
        }
        finally {
            $zip.Dispose()
        }
    }
    catch {
        return $false
    }
}

function Save-NodeArchive {
    param(
        [Parameter(Mandatory)] [string] $ArchivePath,
        [Parameter(Mandatory)] [string] $ArchiveName
    )
    $tempPath = "$ArchivePath.tmp"
    $baseUrls = @()
    if (-not [string]::IsNullOrWhiteSpace($env:CODEXIO_NODE_DIST_BASE_URL)) {
        $baseUrls += $env:CODEXIO_NODE_DIST_BASE_URL.TrimEnd("/")
    }
    $baseUrls += "https://npmmirror.com/mirrors/node"
    $baseUrls += "https://nodejs.org/dist"
    foreach ($baseUrl in $baseUrls) {
        $archiveUrl = "$baseUrl/v$NodeVersion/$ArchiveName"
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -Force -LiteralPath $tempPath
        }
        Write-Host "[codexio nodew] downloading Node.js from $baseUrl"
        try {
            Invoke-WebRequest -Uri $archiveUrl -OutFile $tempPath -TimeoutSec 600
            if (Test-ZipArchive -Path $tempPath) {
                Move-Item -Force -LiteralPath $tempPath -Destination $ArchivePath
                return
            }
        }
        catch {
            Write-Host "[codexio nodew] download failed from $baseUrl"
        }
    }
    $fallbackUrl = "https://next.firco.cn/api/download/release/nodejs/latest/file?platform=windows-x64"
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -Force -LiteralPath $tempPath
    }
    Write-Host "[codexio nodew] downloading Node.js from Nfirco mirror"
    try {
        Invoke-WebRequest -Uri $fallbackUrl -OutFile $tempPath -TimeoutSec 600
        if (Test-ZipArchive -Path $tempPath) {
            Move-Item -Force -LiteralPath $tempPath -Destination $ArchivePath
            return
        }
    }
    catch {
        Write-Host "[codexio nodew] download failed from Nfirco mirror"
    }
    if (Test-Path -LiteralPath $tempPath) {
        Remove-Item -Force -LiteralPath $tempPath
    }
    throw "Node.js download failed. Delete .codexio\download and retry, or manually extract node-v$NodeVersion-win-x64.zip to .codexio\node."
}

function Expand-NodeArchive {
    param(
        [Parameter(Mandatory)] [string] $ArchivePath,
        [Parameter(Mandatory)] [string] $ExtractDir,
        [Parameter(Mandatory)] [string] $ExtractedRoot
    )
    if (Test-Path -LiteralPath $ExtractDir) {
        Remove-Item -Recurse -Force -LiteralPath $ExtractDir
    }
    try {
        Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force
    }
    catch {
        return $false
    }
    $node = Join-Path $ExtractedRoot "node.exe"
    $corepack = Join-Path $ExtractedRoot "corepack.cmd"
    return (Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $corepack)
}

function Install-LocalNode {
    $archiveName = "node-v$NodeVersion-win-x64.zip"
    $downloadDir = Join-Path $Root ".codexio\download"
    $archivePath = Join-Path $downloadDir $archiveName
    $extractDir = Join-Path $downloadDir "node-extract"
    New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
    if (Test-Path -LiteralPath $archivePath) {
        if (Test-ZipArchive -Path $archivePath) {
            Write-Host "[codexio nodew] using cached Node.js archive"
        } else {
            Write-Host "[codexio nodew] cached Node.js archive is broken, deleting it"
            Remove-Item -Force -LiteralPath $archivePath
        }
    }
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Write-Host "[codexio nodew] Node.js was not found, downloading v$NodeVersion"
        Save-NodeArchive -ArchivePath $archivePath -ArchiveName $archiveName
    }
    Write-Host "[codexio nodew] extracting Node.js runtime"
    $extractedRoot = Join-Path $extractDir "node-v$NodeVersion-win-x64"
    if (-not (Expand-NodeArchive -ArchivePath $archivePath -ExtractDir $extractDir -ExtractedRoot $extractedRoot)) {
        Write-Host "[codexio nodew] Node.js archive content is invalid, downloading again"
        Remove-Item -Force -LiteralPath $archivePath
        Save-NodeArchive -ArchivePath $archivePath -ArchiveName $archiveName
        if (-not (Expand-NodeArchive -ArchivePath $archivePath -ExtractDir $extractDir -ExtractedRoot $extractedRoot)) {
            throw "Node.js archive extraction failed. Delete .codexio\download and retry."
        }
    }
    if (Test-Path -LiteralPath $RuntimeRoot) {
        Remove-Item -Recurse -Force -LiteralPath $RuntimeRoot
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $RuntimeRoot) | Out-Null
    Move-Item -LiteralPath $extractedRoot -Destination $RuntimeRoot
    Write-Host "[codexio nodew] Node.js installed locally"
}

function Use-LocalNodeEnvironment {
    $localPath = [System.IO.Path]::GetFullPath($RuntimeRoot)
    $pathItems = @($localPath)
    if (-not [string]::IsNullOrWhiteSpace($env:Path)) {
        foreach ($pathItem in $env:Path.Split([System.IO.Path]::PathSeparator)) {
            if ([string]::IsNullOrWhiteSpace($pathItem)) {
                continue
            }
            $normalizedPathItem = $pathItem.Trim('"')
            try {
                if ([System.IO.Path]::GetFullPath($normalizedPathItem) -eq $localPath) {
                    continue
                }
            }
            catch {}
            $pathItems += $pathItem
        }
    }
    $env:Path = ($pathItems | Select-Object -Unique) -join [System.IO.Path]::PathSeparator
    Remove-Item -LiteralPath "Env:\NODE_OPTIONS" -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "Env:\NODE_PATH" -ErrorAction SilentlyContinue
    $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = "0"
}

function Resolve-Node {
    if (-not (Test-Path -LiteralPath $LocalNode)) {
        Install-LocalNode
    }
    Use-LocalNodeEnvironment
    Write-Host "[codexio nodew] using local Node.js"
    return $LocalNode
}

function Resolve-Corepack {
    if (-not (Test-Path -LiteralPath $LocalNode)) {
        Install-LocalNode
    }
    Use-LocalNodeEnvironment
    $corepack = Join-Path $RuntimeRoot "corepack.cmd"
    if (-not (Test-Path -LiteralPath $corepack)) {
        throw "corepack not found"
    }
    Write-Host "[codexio nodew] using local Corepack"
    return $corepack
}

function Resolve-Pnpm {
    if (-not (Test-Path -LiteralPath $LocalNode)) {
        Install-LocalNode
    }
    Use-LocalNodeEnvironment
    if (-not (Test-Path -LiteralPath $LocalPnpm)) {
        throw "bundled pnpm not found"
    }
    Write-Host "[codexio nodew] using bundled pnpm"
    return $LocalPnpm
}

if ($args.Count -gt 0 -and $args[0] -eq "corepack") {
    Write-Host "[codexio nodew] launching Corepack"
    $command = Resolve-Corepack
    & $command @($args | Select-Object -Skip 1)
    exit $LASTEXITCODE
}

if ($args.Count -gt 0 -and $args[0] -eq "pnpm") {
    Write-Host "[codexio nodew] launching pnpm"
    $pnpm = Resolve-Pnpm
    $node = Resolve-Node
    & $node $pnpm @($args | Select-Object -Skip 1)
    exit $LASTEXITCODE
}

Write-Host "[codexio nodew] launching Node.js"
$node = Resolve-Node
& $node @args
exit $LASTEXITCODE
