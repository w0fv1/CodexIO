import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { inject, injectable } from 'inversify'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Result } from '../value/Result.js'
import { Logger } from './Logger.js'
import { runtimeServerStatePath, supervisorStatePath } from './ServerLifecycle.js'
import { Configer } from './Configer.js'

type LatestReleaseResponse = {
  isf?: unknown
  data?: unknown
}

type LatestRelease = {
  version: string
  platform: string
  fileName: string
  fileSizeBytes: number
  sha256: string
  managePath: string
}

type UpdateManifest = {
  platform: string
  fromVersion: string
  toVersion: string
  installRoot: string
  stageRoot: string
  backupRoot: string
  configPath: string
  supervisorStatePath: string
  serverStatePath: string
  startCommand: string
  updateRoot: string
}

@injectable()
export class UpdateInstaller {
  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata
  ) {}

  async update(): Promise<Result<string>> {
    try {
      if (!await this.configer.get('update.enabled')) {
        return Result.fail('update is disabled')
      }
      const releaseMetadata = this.metadata.readReleaseMetadata()
      if (!releaseMetadata.platform) {
        return Result.fail('当前是源码模式，不支持自动安装更新。')
      }
      const updateBaseUrl = await this.configer.get('update.baseUrl')
      const latest = await this.fetchLatestRelease(releaseMetadata.platform, updateBaseUrl)
      const currentVersion = this.metadata.readVersion()
      if (compareVersion(latest.version, currentVersion) <= 0) {
        return Result.success(`Codexio 已是最新版本 ${currentVersion}。`)
      }
      Logger.info('codexio update release found', {
        fromVersion: currentVersion,
        toVersion: latest.version,
        platform: latest.platform,
        fileName: latest.fileName,
        fileSizeBytes: latest.fileSizeBytes
      })
      const installRoot = dirname(this.metadata.rootPath)
      const updateRoot = join(tmpdir(), 'codexio-update', shortHash(installRoot), `${currentVersion}-${latest.version}-${formatTimestamp(new Date())}`)
      const downloadRoot = join(updateRoot, 'download')
      const stageParent = join(updateRoot, 'stage')
      const updaterRoot = join(updateRoot, 'updater')
      const backupRoot = join(updateRoot, 'backup', `${currentVersion}-${formatTimestamp(new Date())}`)
      await rm(stageParent, {
        recursive: true,
        force: true
      })
      await mkdir(downloadRoot, {
        recursive: true
      })
      await mkdir(stageParent, {
        recursive: true
      })
      await mkdir(updaterRoot, {
        recursive: true
      })
      const archivePath = join(downloadRoot, latest.fileName)
      Logger.info('codexio update download started', {
        archivePath
      })
      await this.downloadRelease(latest, archivePath, updateBaseUrl)
      const actualSha256 = await sha256File(archivePath)
      if (actualSha256.toLowerCase() !== latest.sha256.toLowerCase()) {
        await rm(archivePath, {
          force: true
        })
        return Result.fail(`更新包校验失败：${actualSha256}`)
      }
      Logger.info('codexio update archive verified', {
        archivePath,
        sha256: actualSha256
      })
      await expandZip(archivePath, stageParent)
      const stageRoot = join(stageParent, 'codexio')
      await validateStage(stageRoot, latest.platform)
      Logger.info('codexio update stage validated', {
        stageRoot
      })
      const manifest: UpdateManifest = {
        platform: latest.platform,
        fromVersion: currentVersion,
        toVersion: latest.version,
        installRoot,
        stageRoot,
        backupRoot,
        configPath: this.configer.path,
        supervisorStatePath: supervisorStatePath(this.configer.path),
        serverStatePath: runtimeServerStatePath(this.configer.path),
        startCommand: join(installRoot, 'start.cmd'),
        updateRoot
      }
      const manifestPath = join(updaterRoot, 'update-manifest.json')
      const updaterPath = join(updaterRoot, 'update.ps1')
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
      await writeFile(updaterPath, createUpdaterScript(), 'utf8')
      Logger.info('codexio update updater prepared', {
        manifestPath,
        updaterPath,
        installRoot,
        updateRoot
      })
      await startUpdater(updaterPath, manifestPath)
      Logger.info('codexio update installer started', {
        fromVersion: currentVersion,
        toVersion: latest.version,
        platform: latest.platform,
        logPath: join(updaterRoot, 'update.log')
      })
      return Result.success(`Codexio ${latest.version} 更新包已准备完成，正在安装并重启。日志：${join(updaterRoot, 'update.log')}`)
    } catch (error) {
      Logger.error('codexio update failed', error)
      const failed = Result.fromError(error)
      return Result.fail(failed.message, failed.code)
    }
  }

  private async fetchLatestRelease(platform: string, updateBaseUrl: string): Promise<LatestRelease> {
    const baseUrl = updateBaseUrl.replace(/\/+$/, '')
    const url = new URL('/api/download/release/codexio/latest', `${baseUrl}/`)
    url.searchParams.set('platform', platform)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`update check failed: ${response.status}`)
    }
    const body = await response.json() as LatestReleaseResponse
    if (body.isf || !body.data || typeof body.data !== 'object') {
      throw new Error('update metadata not found')
    }
    return parseLatestRelease(body.data)
  }

  private async downloadRelease(latest: LatestRelease, archivePath: string, updateBaseUrl: string): Promise<void> {
    const baseUrl = updateBaseUrl.replace(/\/+$/, '')
    const url = new URL('/api/download/release/codexio/latest/file', `${baseUrl}/`)
    url.searchParams.set('platform', latest.platform)
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`update download failed: ${response.status}`)
    }
    const writer = createWriteStream(archivePath)
    const reader = response.body.getReader()
    const finished = new Promise<void>((resolveFinish, reject) => {
      writer.once('finish', resolveFinish)
      writer.once('error', reject)
    })
    try {
      while (true) {
        const read = await reader.read()
        if (read.done) {
          break
        }
        if (!writer.write(Buffer.from(read.value))) {
          await new Promise<void>((resolveDrain) => {
            writer.once('drain', resolveDrain)
          })
        }
      }
    } finally {
      reader.releaseLock()
      writer.end()
    }
    await finished
  }
}

function parseLatestRelease(value: object): LatestRelease {
  const data = value as Record<string, unknown>
  if (
    typeof data.version !== 'string' ||
    typeof data.platform !== 'string' ||
    typeof data.fileName !== 'string' ||
    typeof data.fileSizeBytes !== 'number' ||
    typeof data.sha256 !== 'string' ||
    typeof data.managePath !== 'string'
  ) {
    throw new Error('update metadata invalid')
  }
  return {
    version: data.version,
    platform: data.platform,
    fileName: data.fileName,
    fileSizeBytes: data.fileSizeBytes,
    sha256: data.sha256,
    managePath: data.managePath
  }
}

function compareVersion(left: string, right: string): number {
  const leftParts = left.split('.').map((value) => Number.parseInt(value, 10))
  const rightParts = right.split('.').map((value) => Number.parseInt(value, 10))
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const leftValue = Number.isFinite(leftParts[index]) ? leftParts[index] : 0
    const rightValue = Number.isFinite(rightParts[index]) ? rightParts[index] : 0
    if (leftValue > rightValue) {
      return 1
    }
    if (leftValue < rightValue) {
      return -1
    }
  }
  return 0
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

async function expandZip(archivePath: string, destinationPath: string): Promise<void> {
  await new Promise<void>((resolveExpand, reject) => {
    const child = spawn(powershellPath(), [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '& { param([string] $ArchivePath, [string] $DestinationPath) Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -Force }',
      archivePath,
      destinationPath
    ], {
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolveExpand()
        return
      }
      reject(new Error(`update archive extraction failed: ${code}`))
    })
  })
}

async function startUpdater(updaterPath: string, manifestPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(`update platform is not supported: ${process.platform}`)
  }
  const launcher = '& { param([string] $PowerShellPath, [string] $UpdaterPath, [string] $ManifestPath) Start-Process -FilePath $PowerShellPath -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $UpdaterPath, "-Manifest", $ManifestPath) -WindowStyle Hidden }'
  await new Promise<void>((resolveStart, reject) => {
    const child = spawn(powershellPath(), [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      launcher,
      powershellPath(),
      updaterPath,
      manifestPath
    ], {
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolveStart()
        return
      }
      reject(new Error(`update installer launch failed: ${code}`))
    })
  })
}

function powershellPath(): string {
  if (process.platform !== 'win32') {
    return 'pwsh'
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function validateStage(stageRoot: string, platform: string): Promise<void> {
  const required = [
    'start.cmd',
    'restart.cmd',
    'update.cmd',
    'codexio/dist/index.js',
    'codexio/.codexio/release.json'
  ]
  if (platform === 'windows-x64-pnpm') {
    required.push('codexio/nodew.cmd')
    required.push('codexio/runtime/pnpm/bin/pnpm.cjs')
  }
  if (platform === 'windows-x64-standalone') {
    required.push('codexio/runtime/node/node.exe')
  }
  for (const item of required) {
    await readFile(join(stageRoot, item))
  }
}

function formatTimestamp(value: Date): string {
  const pad = (item: number) => item.toString().padStart(2, '0')
  return [
    value.getFullYear(),
    pad(value.getMonth() + 1),
    pad(value.getDate()),
    '-',
    pad(value.getHours()),
    pad(value.getMinutes()),
    pad(value.getSeconds())
  ].join('')
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function createUpdaterScript(): string {
  return `
param(
    [Parameter(Mandatory = $true)] [string] $Manifest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$manifestData = Get-Content -Raw -LiteralPath $Manifest | ConvertFrom-Json
$logPath = Join-Path $manifestData.updateRoot "updater\\update.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
Set-Location -LiteralPath $manifestData.updateRoot

function Write-UpdateLog {
    param([Parameter(Mandatory = $true)] [string] $Text)
    $line = "[$([DateTimeOffset]::Now.ToString("u"))] $Text"
    Add-Content -LiteralPath $logPath -Value $line
}

function Assert-UpdatePath {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "required path is missing: $Path"
    }
}

function Write-UpdateSnapshot {
    param(
        [Parameter(Mandatory = $true)] [string] $Label,
        [Parameter(Mandatory = $true)] [string] $Root
    )
    if (-not (Test-Path -LiteralPath $Root)) {
        Write-UpdateLog "$Label missing: $Root"
        return
    }
    $items = @(Get-ChildItem -Force -LiteralPath $Root | ForEach-Object {
        if ($_.PSIsContainer) {
            "$($_.Name)/"
        } else {
            "$($_.Name)"
        }
    })
    Write-UpdateLog "$Label $Root => $($items -join ', ')"
}

function Stop-InstallRootProcess {
    $installRoot = [System.IO.Path]::GetFullPath([string]$manifestData.installRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $currentProcessId = $PID
    $processes = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $currentProcessId -and (
            ($null -ne $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)) -or
            ($null -ne $_.CommandLine -and $_.CommandLine.Contains($installRoot))
        )
    })
    foreach ($process in $processes) {
        Write-UpdateLog "force stop install-root process pid=$($process.ProcessId) name=$($process.Name)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($processes.Count -eq 0) {
        return
    }
    $deadline = [DateTimeOffset]::Now.AddSeconds(10)
    while ([DateTimeOffset]::Now -lt $deadline) {
        $alive = @(foreach ($process in $processes) {
            Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        })
        if ($alive.Count -eq 0) {
            return
        }
        Start-Sleep -Milliseconds 250
    }
}

function Assert-InstallLayout {
    param(
        [Parameter(Mandatory = $true)] [string] $Root,
        [Parameter(Mandatory = $true)] [string] $Platform
    )
    foreach ($item in @("start.cmd", "restart.cmd", "update.cmd", "config.yaml", "codexio\\dist\\index.js", "codexio\\.codexio\\release.json")) {
        Assert-UpdatePath (Join-Path $Root $item)
    }
    if ($Platform -eq "windows-x64-pnpm") {
        Assert-UpdatePath (Join-Path $Root "codexio\\nodew.cmd")
        Assert-UpdatePath (Join-Path $Root "codexio\\runtime\\pnpm\\bin\\pnpm.cjs")
    }
    if ($Platform -eq "windows-x64-standalone") {
        Assert-UpdatePath (Join-Path $Root "codexio\\runtime\\node\\node.exe")
    }
}

function Copy-UpdateItem {
    param(
        [Parameter(Mandatory = $true)] [string] $Source,
        [Parameter(Mandatory = $true)] [string] $Destination
    )
    Assert-UpdatePath $Source
    Write-UpdateLog "copy $Source -> $Destination"
    Copy-Item -Recurse -Force -LiteralPath $Source -Destination $Destination
    Assert-UpdatePath $Destination
}

function Copy-UpdateDirectoryContent {
    param(
        [Parameter(Mandatory = $true)] [string] $Source,
        [Parameter(Mandatory = $true)] [string] $Destination
    )
    Assert-UpdatePath $Source
    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    }
    foreach ($item in Get-ChildItem -Force -LiteralPath $Destination) {
        Remove-UpdateItem -Path $item.FullName
    }
    foreach ($item in Get-ChildItem -Force -LiteralPath $Source) {
        $target = Join-Path $Destination $item.Name
        Write-UpdateLog "copy $($item.FullName) -> $target"
        Copy-Item -Recurse -Force -LiteralPath $item.FullName -Destination $target
        Assert-UpdatePath $target
    }
}

function Copy-CodexioAppContent {
    param(
        [Parameter(Mandatory = $true)] [string] $Source,
        [Parameter(Mandatory = $true)] [string] $Destination
    )
    Assert-UpdatePath $Source
    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    }
    foreach ($item in Get-ChildItem -Force -LiteralPath $Destination) {
        if ($item.Name -eq ".codexio") {
            continue
        }
        Remove-UpdateItem -Path $item.FullName
    }
    foreach ($item in Get-ChildItem -Force -LiteralPath $Source) {
        if ($item.Name -eq ".codexio") {
            $targetData = Join-Path $Destination ".codexio"
            New-Item -ItemType Directory -Force -Path $targetData | Out-Null
            Copy-UpdateItem -Source (Join-Path $item.FullName "release.json") -Destination (Join-Path $targetData "release.json")
            continue
        }
        $target = Join-Path $Destination $item.Name
        Write-UpdateLog "copy $($item.FullName) -> $target"
        Copy-Item -Recurse -Force -LiteralPath $item.FullName -Destination $target
        Assert-UpdatePath $target
    }
}

function Remove-UpdateItem {
    param([Parameter(Mandatory = $true)] [string] $Path)
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path)) {
            return
        }
        try {
            Write-UpdateLog "remove $Path attempt=$attempt"
            Remove-Item -Recurse -Force -LiteralPath $Path
            return
        } catch {
            Write-UpdateLog "remove failed attempt=$attempt path=$Path error=$($_.Exception.Message)"
            Stop-InstallRootProcess
            Start-Sleep -Milliseconds (250 * $attempt)
        }
    }
    if (Test-Path -LiteralPath $Path) {
        throw "remove failed: $Path"
    }
}

function Stop-Codexio {
    Write-UpdateLog "stop codexio started"
    if (Test-Path -LiteralPath $manifestData.supervisorStatePath) {
        $state = Get-Content -Raw -LiteralPath $manifestData.supervisorStatePath | ConvertFrom-Json
        Write-UpdateLog "request supervisor stop: $($state.host):$($state.port) pid=$($state.pid)"
        try {
            Invoke-RestMethod -Method Post -Uri "http://$($state.host):$($state.port)/stop" -Headers @{ Authorization = "Bearer $($state.token)" } -TimeoutSec 10 | Out-Null
        } catch {
            Write-UpdateLog "supervisor stop request failed: $($_.Exception.Message)"
        }
        $deadline = [DateTimeOffset]::Now.AddSeconds(30)
        while ([DateTimeOffset]::Now -lt $deadline) {
            $process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
            if ($null -eq $process) {
                break
            }
            Start-Sleep -Milliseconds 500
        }
        $remaining = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
        if ($null -ne $remaining) {
            Write-UpdateLog "force stop supervisor pid=$($state.pid)"
            Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-UpdateLog "supervisor state not found"
    }
    if (Test-Path -LiteralPath $manifestData.serverStatePath) {
        Remove-Item -Force -LiteralPath $manifestData.serverStatePath -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $manifestData.supervisorStatePath) {
        Remove-Item -Force -LiteralPath $manifestData.supervisorStatePath -ErrorAction SilentlyContinue
    }
    Stop-InstallRootProcess
    Write-UpdateLog "stop codexio completed"
}

function Remove-LegacyRootState {
    foreach ($item in @(
        (Join-Path $manifestData.installRoot "server.json"),
        (Join-Path $manifestData.installRoot "supervisor.json")
    )) {
        if (Test-Path -LiteralPath $item) {
            Write-UpdateLog "remove legacy root state: $item"
            Remove-Item -Force -LiteralPath $item -ErrorAction SilentlyContinue
        }
    }
}

function Remove-LegacyInstallDataRoot {
    $legacyRoot = Join-Path $manifestData.installRoot ".codexio"
    if (-not (Test-Path -LiteralPath $legacyRoot)) {
        return
    }
    foreach ($item in @("log", "update", "state")) {
        $target = Join-Path $legacyRoot $item
        if (Test-Path -LiteralPath $target) {
            Write-UpdateLog "remove legacy install data item: $target"
            Remove-UpdateItem -Path $target
        }
    }
    $remaining = @(Get-ChildItem -Force -LiteralPath $legacyRoot)
    if ($remaining.Count -eq 0) {
        Write-UpdateLog "remove legacy install data root: $legacyRoot"
        Remove-UpdateItem -Path $legacyRoot
    }
}

function Remove-TransientAppData {
    $appDataRoot = Join-Path $manifestData.installRoot "codexio\\.codexio"
    if (-not (Test-Path -LiteralPath $appDataRoot)) {
        return
    }
    foreach ($item in @("download", "update")) {
        $target = Join-Path $appDataRoot $item
        if (Test-Path -LiteralPath $target) {
            Write-UpdateLog "remove transient app data: $target"
            Remove-UpdateItem -Path $target
        }
    }
}

function Backup-Current {
    Write-UpdateLog "backup current started"
    New-Item -ItemType Directory -Force -Path $manifestData.backupRoot | Out-Null
    foreach ($item in @("start.cmd", "restart.cmd", "update.cmd", "config.yaml", "codexio")) {
        $source = Join-Path $manifestData.installRoot $item
        Copy-UpdateItem -Source $source -Destination (Join-Path $manifestData.backupRoot $item)
    }
    Write-UpdateSnapshot -Label "backup snapshot" -Root $manifestData.backupRoot
    Write-UpdateLog "backup current completed"
}

function Replace-Current {
    Write-UpdateLog "replace current started"
    $preservedNode = Join-Path $manifestData.updateRoot "preserved-node"
    $currentNode = Join-Path $manifestData.installRoot "codexio\\runtime\\node"
    if ($manifestData.platform -eq "windows-x64-pnpm" -and (Test-Path -LiteralPath $currentNode)) {
        if (Test-Path -LiteralPath $preservedNode) {
            Remove-Item -Recurse -Force -LiteralPath $preservedNode
        }
        Write-UpdateLog "preserve node runtime: $currentNode"
        Copy-Item -Recurse -Force -LiteralPath $currentNode -Destination $preservedNode
    }
    foreach ($item in @("start.cmd", "restart.cmd", "update.cmd")) {
        $target = Join-Path $manifestData.installRoot $item
        Remove-UpdateItem -Path $target
    }
    foreach ($item in @("start.cmd", "restart.cmd", "update.cmd")) {
        $source = Join-Path $manifestData.stageRoot $item
        Copy-UpdateItem -Source $source -Destination (Join-Path $manifestData.installRoot $item)
    }
    Copy-CodexioAppContent -Source (Join-Path $manifestData.stageRoot "codexio") -Destination (Join-Path $manifestData.installRoot "codexio")
    if (-not (Test-Path -LiteralPath $manifestData.configPath)) {
        Copy-UpdateItem -Source (Join-Path $manifestData.stageRoot "config.yaml") -Destination $manifestData.configPath
    }
    $newNode = Join-Path $manifestData.installRoot "codexio\\runtime\\node"
    if ($manifestData.platform -eq "windows-x64-pnpm" -and (Test-Path -LiteralPath $preservedNode) -and -not (Test-Path -LiteralPath $newNode)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $newNode) | Out-Null
        Write-UpdateLog "restore preserved node runtime: $newNode"
        Copy-Item -Recurse -Force -LiteralPath $preservedNode -Destination $newNode
    }
    Remove-TransientAppData
    Remove-LegacyRootState
    Remove-LegacyInstallDataRoot
    Assert-InstallLayout -Root $manifestData.installRoot -Platform $manifestData.platform
    Write-UpdateSnapshot -Label "install snapshot after replace" -Root $manifestData.installRoot
    Write-UpdateLog "replace current completed"
}

function Restore-Backup {
    Write-UpdateLog "restore backup started"
    foreach ($item in @("start.cmd", "restart.cmd", "update.cmd", "config.yaml")) {
        $target = Join-Path $manifestData.installRoot $item
        Remove-UpdateItem -Path $target
    }
    foreach ($item in @("start.cmd", "restart.cmd", "update.cmd", "config.yaml")) {
        $source = Join-Path $manifestData.backupRoot $item
        Copy-UpdateItem -Source $source -Destination (Join-Path $manifestData.installRoot $item)
    }
    Copy-UpdateDirectoryContent -Source (Join-Path $manifestData.backupRoot "codexio") -Destination (Join-Path $manifestData.installRoot "codexio")
    Assert-InstallLayout -Root $manifestData.installRoot -Platform $manifestData.platform
    Write-UpdateSnapshot -Label "install snapshot after rollback" -Root $manifestData.installRoot
    Write-UpdateLog "restore backup completed"
}

function Start-Codexio {
    Assert-UpdatePath $manifestData.startCommand
    Write-UpdateLog "start codexio: $($manifestData.startCommand)"
    Start-Process -FilePath $manifestData.startCommand -WorkingDirectory $manifestData.installRoot
}

function Wait-CodexioStarted {
    Write-UpdateLog "wait codexio started"
    $deadline = [DateTimeOffset]::Now.AddSeconds(60)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if ((Test-Path -LiteralPath $manifestData.supervisorStatePath) -and (Test-Path -LiteralPath $manifestData.serverStatePath)) {
            try {
                $state = Get-Content -Raw -LiteralPath $manifestData.supervisorStatePath | ConvertFrom-Json
                $serverState = Get-Content -Raw -LiteralPath $manifestData.serverStatePath | ConvertFrom-Json
                $supervisorResponse = Invoke-RestMethod -Method Get -Uri "http://$($state.host):$($state.port)/status" -Headers @{ Authorization = "Bearer $($state.token)" } -TimeoutSec 5
                $serverResponse = Invoke-RestMethod -Method Get -Uri "http://$($serverState.host):$($serverState.port)/api/status" -TimeoutSec 5
                if ($supervisorResponse.isFailed -eq $false -and $supervisorResponse.data.pid -eq $state.pid -and $serverResponse.isFailed -eq $false -and $serverResponse.data.pid -eq $serverState.pid) {
                    Write-UpdateLog "codexio started: supervisor=$($state.pid) server=$($serverState.pid)"
                    return
                }
            } catch {
                Write-UpdateLog "codexio health check failed: $($_.Exception.Message)"
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "codexio did not become ready after start"
}

try {
    Write-UpdateLog "update started: $($manifestData.fromVersion) -> $($manifestData.toVersion)"
    Write-UpdateLog "installRoot=$($manifestData.installRoot)"
    Write-UpdateLog "stageRoot=$($manifestData.stageRoot)"
    Write-UpdateSnapshot -Label "install snapshot before update" -Root $manifestData.installRoot
    Write-UpdateSnapshot -Label "stage snapshot before update" -Root $manifestData.stageRoot
    Assert-InstallLayout -Root $manifestData.installRoot -Platform $manifestData.platform
    Assert-InstallLayout -Root $manifestData.stageRoot -Platform $manifestData.platform
    Start-Sleep -Seconds 2
    Stop-Codexio
    Backup-Current
    Replace-Current
    Start-Codexio
    Wait-CodexioStarted
    Write-UpdateLog "update completed"
} catch {
    Write-UpdateLog "update failed: $($_.Exception.Message)"
    try {
        Stop-Codexio
        Restore-Backup
        Start-Codexio
        Wait-CodexioStarted
        Write-UpdateLog "rollback completed"
    } catch {
        Write-UpdateLog "rollback failed: $($_.Exception.Message)"
    }
}
`
}
