import { CodexioConfig } from '../config/ConfigDefinition.js'
import { readCodexioReleaseMetadata, readCodexioVersion } from '../AppMetadata.js'

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

export async function checkCodexioUpdate(config: CodexioConfig): Promise<string | undefined> {
  if (!config.update.enabled) {
    return undefined
  }
  const localVersion = readCodexioVersion()
  const releaseMetadata = readCodexioReleaseMetadata()
  if (!releaseMetadata.platform) {
    return undefined
  }
  const baseUrl = config.update.baseUrl.replace(/\/+$/, '')
  const url = new URL(`/api/download/release/codexio/latest`, `${baseUrl}/`)
  url.searchParams.set('platform', releaseMetadata.platform)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`update check failed: ${response.status}`)
  }
  const body = await response.json() as LatestReleaseResponse
  if (body.isf || !body.data || typeof body.data !== 'object') {
    return undefined
  }
  const latest = parseLatestRelease(body.data)
  if (compareVersion(latest.version, localVersion) <= 0) {
    return undefined
  }
  const manageUrl = new URL(latest.managePath, `${baseUrl}/`).toString()
  return [
    `Codexio 有新版本 ${latest.version}，当前版本 ${localVersion}。`,
    `平台：${latest.platform}`,
    `文件：${latest.fileName}`,
    '发送 $update 或 ￥update 自动升级。',
    `后台发布页面：${manageUrl}`
  ].join('\n')
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
