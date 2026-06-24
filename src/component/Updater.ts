import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { inject, injectable } from 'inversify'
import { ChannelOutputManager } from '../channel/ChannelOutputManager.js'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Result } from '../value/Result.js'
import { Logger } from './Logger.js'
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

type LatestReleaseContext = {
  currentVersion: string
  updateBaseUrl: string
  latest: LatestRelease
}

type UpdateManifest = {
  platform: string
  fromVersion: string
  toVersion: string
  installRoot: string
  stageRoot: string
  backupRoot: string
  configPath: string
  serverStatePath: string
  serviceCommand: string
  updateRoot: string
}

@injectable()
export class Updater {
  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager
  ) {}

  start(): void {
    void this.check()
      .then(async (message) => {
        if (message) {
          await this.outputManager.sendSystem(message)
        }
      })
      .catch((error) => {
        Logger.error('update check failed', error)
      })
  }

  async check(): Promise<string | undefined> {
    if (!await this.configer.get('update.enabled')) {
      return undefined
    }
    const context = await this.findLatestRelease()
    if (!context) {
      return undefined
    }
    const { currentVersion, updateBaseUrl, latest } = context
    if (compareVersion(latest.version, currentVersion) <= 0) {
      return undefined
    }
    const baseUrl = updateBaseUrl.replace(/\/+$/, '')
    const manageUrl = new URL(latest.managePath, `${baseUrl}/`).toString()
    return [
      `Codexio 有新版本 ${latest.version}，当前版本 ${currentVersion}。`,
      `平台：${latest.platform}`,
      `文件：${latest.fileName}`,
      '发送 $update 或 ￥update 自动升级。',
      `后台发布页面：${manageUrl}`
    ].join('\n')
  }

  async update(): Promise<Result<string>> {
    try {
      if (!await this.configer.get('update.enabled')) {
        return Result.fail('update is disabled')
      }
      const context = await this.findLatestRelease()
      if (!context) {
        return Result.fail('当前是源码模式，不支持自动安装更新。')
      }
      const { currentVersion, updateBaseUrl, latest } = context
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
      const installRoot = this.metadata.rootPath
      const updateRoot = join(installRoot, '.codexio', 'update', `${currentVersion}-${latest.version}-${formatTimestamp(new Date())}`)
      const downloadRoot = join(updateRoot, 'download')
      const stageParent = join(updateRoot, 'stage')
      const updaterRoot = join(updateRoot, 'updater')
      const backupRoot = join(updateRoot, 'backup')
      await rm(updateRoot, {
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
      await this.downloadRelease(latest, archivePath, updateBaseUrl)
      const actualSha256 = await sha256File(archivePath)
      if (actualSha256.toLowerCase() !== latest.sha256.toLowerCase()) {
        await rm(archivePath, {
          force: true
        })
        return Result.fail(`更新包校验失败：${actualSha256}`)
      }
      await expandZip(archivePath, stageParent)
      const stageRoot = join(stageParent, 'codexio')
      await validateStage(stageRoot, latest.platform)
      const manifest: UpdateManifest = {
        platform: latest.platform,
        fromVersion: currentVersion,
        toVersion: latest.version,
        installRoot,
        stageRoot,
        backupRoot,
        configPath: this.configer.path,
        serverStatePath: this.metadata.serverStatePath,
        serviceCommand: join(installRoot, 'service.ps1'),
        updateRoot
      }
      const manifestPath = join(updaterRoot, 'update-manifest.json')
      const updaterPath = join(updaterRoot, 'update.ps1')
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
      await writeFile(updaterPath, createUpdaterScript(), 'utf8')
      await startUpdater(updaterPath, manifestPath)
      return Result.success(`Codexio ${latest.version} 更新包已准备完成，正在安装并重启。日志：${join(updaterRoot, 'update.log')}`)
    } catch (error) {
      Logger.error('codexio update failed', error)
      const failed = Result.fromError(error)
      return Result.fail(failed.message, failed.code)
    }
  }

  private async findLatestRelease(): Promise<LatestReleaseContext | undefined> {
    const releaseMetadata = this.metadata.readReleaseMetadata()
    if (!releaseMetadata.platform) {
      return undefined
    }
    const updateBaseUrl = await this.configer.get('update.baseUrl')
    return {
      currentVersion: this.metadata.readVersion(),
      updateBaseUrl,
      latest: await this.fetchLatestRelease(releaseMetadata.platform, updateBaseUrl)
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
    '.codexio/codexio-service.exe',
    '.codexio/codexio-service.xml',
    'install.cmd',
    'uninstall.cmd',
    'start.cmd',
    'stop.cmd',
    'restart.cmd',
    'service.ps1',
    'nodew.ps1',
    'dist/Server.js',
    '.codexio/config.yaml',
    '.codexio/release.json'
  ]
  if (platform === 'windows-x64-pnpm') {
    required.push('.codexio/pnpm/bin/pnpm.cjs')
  }
  if (platform === 'windows-x64-standalone') {
    required.push('.codexio/node/node.exe')
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
    Add-Content -LiteralPath $logPath -Value "[$([DateTimeOffset]::Now.ToString("u"))] $Text"
}

function Assert-UpdatePath {
    param([Parameter(Mandatory = $true)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "required path is missing: $Path"
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
}

function Assert-InstallLayout {
    param([Parameter(Mandatory = $true)] [string] $Root)
    foreach ($item in @(".codexio\\codexio-service.exe", ".codexio\\codexio-service.xml", "install.cmd", "uninstall.cmd", "start.cmd", "stop.cmd", "restart.cmd", "service.ps1", "nodew.ps1", "dist\\Server.js", ".codexio\\config.yaml", ".codexio\\release.json")) {
        Assert-UpdatePath (Join-Path $Root $item)
    }
}

function Copy-CodexioPackageItems {
    param(
        [Parameter(Mandatory = $true)] [string] $SourceRoot,
        [Parameter(Mandatory = $true)] [string] $TargetRoot
    )
    $sourceCodexio = Join-Path $SourceRoot ".codexio"
    $targetCodexio = Join-Path $TargetRoot ".codexio"
    New-Item -ItemType Directory -Force -Path $targetCodexio | Out-Null
    foreach ($item in @("codexio-service.exe", "codexio-service.xml", "node", "pnpm", "release.json")) {
        $source = Join-Path $sourceCodexio $item
        $target = Join-Path $targetCodexio $item
        if (Test-Path -LiteralPath $target) {
            Remove-UpdateItem -Path $target
        }
        if (Test-Path -LiteralPath $source) {
            Copy-Item -Recurse -Force -LiteralPath $source -Destination $target
        }
    }
    if (-not (Test-Path -LiteralPath $manifestData.configPath)) {
        $configSource = Join-Path $sourceCodexio "config.yaml"
        if (Test-Path -LiteralPath $configSource) {
            Copy-Item -Force -LiteralPath $configSource -Destination $manifestData.configPath
        }
    }
}

function Stop-Codexio {
    Assert-UpdatePath $manifestData.serviceCommand
    Write-UpdateLog "stop codexio service"
    Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $manifestData.serviceCommand, "-Action", "stop") -WorkingDirectory $manifestData.installRoot -Wait
    Stop-InstallRootProcess
}

function Start-Codexio {
    Assert-UpdatePath $manifestData.serviceCommand
    Write-UpdateLog "start codexio service"
    Start-Process -FilePath "powershell" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $manifestData.serviceCommand, "-Action", "start") -WorkingDirectory $manifestData.installRoot -Wait
}

function Backup-Current {
    Write-UpdateLog "backup current started"
    if (Test-Path -LiteralPath $manifestData.backupRoot) {
        Remove-UpdateItem -Path $manifestData.backupRoot
    }
    New-Item -ItemType Directory -Force -Path $manifestData.backupRoot | Out-Null
    foreach ($item in Get-ChildItem -Force -LiteralPath $manifestData.installRoot) {
        if ($item.Name -eq ".codexio") {
            Copy-CodexioPackageItems -SourceRoot $manifestData.installRoot -TargetRoot $manifestData.backupRoot
            continue
        }
        Copy-Item -Recurse -Force -LiteralPath $item.FullName -Destination (Join-Path $manifestData.backupRoot $item.Name)
    }
}

function Replace-Current {
    Write-UpdateLog "replace current started"
    foreach ($item in Get-ChildItem -Force -LiteralPath $manifestData.installRoot) {
        if ($item.Name -eq ".codexio") {
            continue
        }
        Remove-UpdateItem -Path $item.FullName
    }
    foreach ($item in Get-ChildItem -Force -LiteralPath $manifestData.stageRoot) {
        if ($item.Name -eq ".codexio") {
            Copy-CodexioPackageItems -SourceRoot $manifestData.stageRoot -TargetRoot $manifestData.installRoot
            continue
        }
        Copy-Item -Recurse -Force -LiteralPath $item.FullName -Destination (Join-Path $manifestData.installRoot $item.Name)
    }
    Assert-InstallLayout -Root $manifestData.installRoot
}

function Restore-Backup {
    Write-UpdateLog "restore backup started"
    foreach ($item in Get-ChildItem -Force -LiteralPath $manifestData.installRoot) {
        if ($item.Name -eq ".codexio") {
            continue
        }
        Remove-UpdateItem -Path $item.FullName
    }
    foreach ($item in Get-ChildItem -Force -LiteralPath $manifestData.backupRoot) {
        if ($item.Name -eq ".codexio") {
            Copy-CodexioPackageItems -SourceRoot $manifestData.backupRoot -TargetRoot $manifestData.installRoot
            continue
        }
        Copy-Item -Recurse -Force -LiteralPath $item.FullName -Destination (Join-Path $manifestData.installRoot $item.Name)
    }
    Assert-InstallLayout -Root $manifestData.installRoot
}

function Wait-CodexioStarted {
    Write-UpdateLog "wait codexio started"
    $deadline = [DateTimeOffset]::Now.AddSeconds(60)
    while ([DateTimeOffset]::Now -lt $deadline) {
        if (Test-Path -LiteralPath $manifestData.serverStatePath) {
            try {
                $serverState = Get-Content -Raw -LiteralPath $manifestData.serverStatePath | ConvertFrom-Json
                $serverResponse = Invoke-RestMethod -Method Get -Uri "http://$($serverState.host):$($serverState.port)/api/status" -TimeoutSec 5
                if ($serverResponse.isFailed -eq $false -and $serverResponse.data.pid -eq $serverState.pid) {
                    Write-UpdateLog "codexio started: server=$($serverState.pid)"
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
    Assert-InstallLayout -Root $manifestData.installRoot
    Assert-InstallLayout -Root $manifestData.stageRoot
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
