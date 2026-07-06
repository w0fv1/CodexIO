param(
    [string] $AppDomain = "next.firco.cn",
    [string] $ReleaseInfoPath = ""
)

$ErrorActionPreference = "Stop"
$scriptRoot = $PSScriptRoot
$repoRoot = Split-Path -Path (Split-Path -Path $scriptRoot -Parent) -Parent
Import-Module (Join-Path $repoRoot "script\NfircoBackendApiCredential.psm1") -Force
$adminApiCredential = Read-NfircoBackendApiCredential -RepoRoot $repoRoot
$adminApiUsername = [string]$adminApiCredential.Username
$adminApiPassword = [string]$adminApiCredential.Password
$adminApiHeaders = @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${adminApiUsername}:${adminApiPassword}")) }

function Write-Step {
    param([Parameter(Mandatory)] [string] $Text)
    Write-Host "[codexio release] $Text"
}

function Invoke-NfircoApi {
    param(
        [Parameter(Mandatory)] [string] $Uri,
        [Parameter(Mandatory)] [object] $Body
    )
    $json = $Body | ConvertTo-Json -Depth 8
    $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $adminApiHeaders -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec 60 -NoProxy
    if ($null -eq $response) {
        throw "Nfirco API returned empty response"
    }
    if ($response.isf) {
        throw "Nfirco API failed: $($response.msg)"
    }
    return $response.data
}

if ([string]::IsNullOrWhiteSpace($ReleaseInfoPath)) {
    $ReleaseInfoPath = Join-Path $scriptRoot "release-portable\release-info.json"
}

$releaseInfo = Get-Content -Raw -Path $ReleaseInfoPath | ConvertFrom-Json
$artifactPath = Join-Path (Split-Path -Path $ReleaseInfoPath -Parent) $releaseInfo.fileName
if (-not (Test-Path -Path $artifactPath)) {
    throw "Release artifact not found: $artifactPath"
}

$baseUrl = "https://$AppDomain"
$createUri = "$baseUrl/apim/download/release/$($releaseInfo.appKey)"
$completeUri = "$baseUrl/apim/download/release/$($releaseInfo.appKey)/$($releaseInfo.version)/complete"

Write-Step "读取版本: $($releaseInfo.version)"
Write-Step "发布文件: $artifactPath"
Write-Step "文件大小: $($releaseInfo.fileSizeBytes) bytes"
Write-Step "SHA256: $($releaseInfo.sha256)"
Write-Step "SHA512: $($releaseInfo.sha512)"
Write-Step "请求发布上传地址"

$createBody = @{
    platform = $releaseInfo.platform
    version = $releaseInfo.version
    fileName = $releaseInfo.fileName
    fileSizeBytes = $releaseInfo.fileSizeBytes
    sha256 = $releaseInfo.sha256
    sha512 = $releaseInfo.sha512
    mimeType = $releaseInfo.mimeType
    access = "PUBLIC"
}
$uploadData = Invoke-NfircoApi -Uri $createUri -Body $createBody
if ($null -eq $uploadData -or [string]::IsNullOrWhiteSpace($uploadData.uploadUrl)) {
    throw "Nfirco API did not return uploadUrl"
}

Write-Step "上传到 OSS"
& curl.exe --fail --show-error --location --noproxy "*" --http1.1 --request PUT --header "Content-Type: $($releaseInfo.mimeType)" --upload-file $artifactPath $uploadData.uploadUrl
if ($LASTEXITCODE -ne 0) {
    throw "OSS upload failed: curl exit code $LASTEXITCODE"
}

Write-Step "登记发布完成"
$completeBody = @{
    platform = $releaseInfo.platform
}
Invoke-NfircoApi -Uri $completeUri -Body $completeBody | Out-Null

Write-Step "发布完成: $baseUrl/download/release/$($releaseInfo.appKey)"
