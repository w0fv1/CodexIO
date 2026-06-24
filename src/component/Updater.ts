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

const electronPlatform = 'windows-x64-electron'

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
    const currentVersion = this.metadata.readVersion()
    const updateBaseUrl = await this.configer.get('update.baseUrl')
    const latest = await this.fetchLatestRelease(updateBaseUrl)
    if (!latest) {
      return undefined
    }
    if (compareVersion(latest.version, currentVersion) <= 0) {
      return undefined
    }
    const baseUrl = updateBaseUrl.replace(/\/+$/, '')
    const manageUrl = new URL(latest.managePath, `${baseUrl}/`).toString()
    return [
      `Codexio 有新版本 ${latest.version}，当前版本 ${currentVersion}。`,
      `平台：${latest.platform}`,
      `文件：${latest.fileName}`,
      '请在系统托盘右键 Codexio，点击“更新”。',
      `后台发布页面：${manageUrl}`
    ].join('\n')
  }

  async update(): Promise<Result<string>> {
    return Result.success('Codexio 桌面版更新由系统托盘执行。请右键托盘图标，点击“更新”。')
  }

  private async fetchLatestRelease(updateBaseUrl: string): Promise<LatestRelease | undefined> {
    const baseUrl = updateBaseUrl.replace(/\/+$/, '')
    const url = new URL('/api/download/release/codexio/latest', `${baseUrl}/`)
    url.searchParams.set('platform', electronPlatform)
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`update check failed: ${response.status}`)
    }
    const body = await response.json() as LatestReleaseResponse
    if (body.isf || !body.data || typeof body.data !== 'object') {
      return undefined
    }
    return parseLatestRelease(body.data)
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
