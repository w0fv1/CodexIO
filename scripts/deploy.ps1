param(
    [string] $AppDomain = "next.firco.cn",
    [string[]] $Platforms = @("windows-x64-standalone", "windows-x64-pnpm")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$scriptRoot = $PSScriptRoot
$projectRoot = Split-Path -Path $scriptRoot -Parent
$repoRoot = Split-Path -Path (Split-Path -Path $projectRoot -Parent) -Parent
. (Join-Path $repoRoot "script\NfircoBackendApiCredential.ps1")
$adminApiCredential = Read-NfircoBackendApiCredential -RepoRoot $repoRoot
$adminApiUsername = [string]$adminApiCredential.Username
$adminApiPassword = [string]$adminApiCredential.Password
$adminApiHeaders = @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${adminApiUsername}:${adminApiPassword}")) }

function Write-Step {
    param([Parameter(Mandatory)] [string] $Text)
    Write-Host "[codexio deploy] $Text"
}

function Read-ProjectVersion {
    $packageJsonPath = Join-Path $projectRoot "package.json"
    $package = Get-Content -Raw -Path $packageJsonPath | ConvertFrom-Json
    $version = [string]$package.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw "Project version must match x.y.z"
    }
    return $version
}

function Invoke-NfircoApi {
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [object] $Body
    )
    $json = $Body | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $adminApiHeaders -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec 60
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

Set-Location -Path $projectRoot

$version = Read-ProjectVersion
Write-Step "version: $version"

$supportedPlatforms = @("windows-x64-standalone", "windows-x64-pnpm")
$selectedPlatforms = @($supportedPlatforms | Where-Object { $Platforms -contains $_ })
if ($selectedPlatforms.Count -ne $Platforms.Count) {
    throw "Unsupported platform. Supported platforms: $($supportedPlatforms -join ', ')"
}
Write-Step "platforms: $($selectedPlatforms -join ', ')"

Write-Step "build release packages locally"
$buildScript = Join-Path $scriptRoot "build_windows_zip.ps1"
$buildArgs = @("-ExecutionPolicy", "Bypass", "-File", $buildScript, "-Platforms") + $selectedPlatforms
& powershell @buildArgs
if ($LASTEXITCODE -ne 0) {
    throw "codexio build failed with exit code $LASTEXITCODE"
}

$baseUrl = "https://$AppDomain"
$createUri = "$baseUrl/apim/download/release/codexio"
$completeUri = "$baseUrl/apim/download/release/codexio/$version/complete"

$packages = @(
    @{
        Platform = "windows-x64-standalone"
        Path = Join-Path $projectRoot "release\codexio-$version-windows-x64-standalone.zip"
    },
    @{
        Platform = "windows-x64-pnpm"
        Path = Join-Path $projectRoot "release\codexio-$version-windows-x64-pnpm.zip"
    }
)

$selectedPackages = @($packages | Where-Object { $selectedPlatforms -contains [string]$_.Platform })
foreach ($package in $selectedPackages) {
    $zipPath = [string]$package.Path
    $platform = [string]$package.Platform
    Write-Step "prepare package metadata: $platform"
    if (-not (Test-Path -Path $zipPath)) {
        throw "Release zip not found: $zipPath"
    }

    $file = Get-Item -Path $zipPath
    $sha256 = Get-ZipSha256 -Path $zipPath

    Write-Step "built: $zipPath"
    Write-Step "platform: $platform"
    Write-Step "size: $($file.Length) bytes"
    Write-Step "SHA256: $sha256"
    Write-Step "request upload URL: $platform"

    $createBody = @{
        platform = $platform
        version = $version
        fileName = $file.Name
        fileSizeBytes = $file.Length
        sha256 = $sha256
        mimeType = "application/zip"
    }
    $uploadData = Invoke-NfircoApi -Uri $createUri -Body $createBody
    if ($null -eq $uploadData -or [string]::IsNullOrWhiteSpace($uploadData.uploadUrl)) {
        throw "Nfirco API did not return uploadUrl"
    }

    Write-Step "upload package to OSS: $platform"
    Invoke-WebRequest -Uri $uploadData.uploadUrl -Method Put -InFile $zipPath -ContentType "application/zip" -UseBasicParsing -TimeoutSec 900 | Out-Null

    Write-Step "complete release record: $platform"
    $completeBody = @{
        platform = $platform
    }
    Invoke-NfircoApi -Uri $completeUri -Body $completeBody | Out-Null
    Write-Step "package published: $platform"
}

Write-Step "release page updated: $baseUrl/manage/nfirco/release"
