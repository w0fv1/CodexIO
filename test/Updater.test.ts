import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelOutputManager } from '../src/channel/ChannelOutputManager.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { Updater } from '../src/component/Updater.js'
import { Configer } from '../src/component/Configer.js'
import { Result } from '../src/value/Result.js'

const testMetadata = new CodexioMetadata()
const releasePath = join(testMetadata.rootPath, '.codexio', 'release.json')

describe('updater', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(releasePath, {
      force: true
    })
  })

  it('prompts newer packaged release without download url', async () => {
    const currentVersionParts = testMetadata.readVersion().split('.').map((value) => Number.parseInt(value, 10))
    const nextVersion = [
      currentVersionParts[0],
      currentVersionParts[1],
      currentVersionParts[2] + 1
    ].join('.')
    await writeFile(releasePath, JSON.stringify({
      platform: 'windows-x64-pnpm'
    }), 'utf8')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      isf: false,
      data: {
        version: nextVersion,
        platform: 'windows-x64-pnpm',
        fileName: `codexio-${nextVersion}-windows-x64-pnpm.zip`,
        fileSizeBytes: 111580,
        sha256: 'hash',
        managePath: '/manage/nfirco/release'
      }
    })))
    vi.stubGlobal('fetch', fetchMock)

    const { updater } = createUpdater(true, 'https://next.firco.cn')
    const message = await updater.check()

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://next.firco.cn/api/download/release/codexio/latest?platform=windows-x64-pnpm'))
    expect(message).toContain(nextVersion)
    expect(message).toContain('https://next.firco.cn/manage/nfirco/release')
    expect(message).toContain('$update')
    expect(message).toContain('￥update')
    expect(message).not.toContain('fileUrl')
  })

  it('skips source tree without packaged release metadata', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { updater } = createUpdater(true, 'https://next.firco.cn')
    const message = await updater.check()

    expect(message).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends newer release message from start', async () => {
    const currentVersionParts = testMetadata.readVersion().split('.').map((value) => Number.parseInt(value, 10))
    const nextVersion = [
      currentVersionParts[0],
      currentVersionParts[1],
      currentVersionParts[2] + 1
    ].join('.')
    await writeFile(releasePath, JSON.stringify({
      platform: 'windows-x64-pnpm'
    }), 'utf8')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      isf: false,
      data: {
        version: nextVersion,
        platform: 'windows-x64-pnpm',
        fileName: `codexio-${nextVersion}-windows-x64-pnpm.zip`,
        fileSizeBytes: 111580,
        sha256: 'hash',
        managePath: '/manage/nfirco/release'
      }
    }))))
    const { updater, sendSystem } = createUpdater(true, 'https://next.firco.cn')

    updater.start()

    await vi.waitFor(() => {
      expect(sendSystem).toHaveBeenCalledWith(expect.stringContaining(nextVersion))
    })
  })
})

function createUpdater(enabled: boolean, baseUrl: string): {
  updater: Updater
  sendSystem: ReturnType<typeof vi.fn>
} {
  const configer = {
    get: async (path: string) => {
      if (path === 'update.enabled') {
        return enabled
      }
      if (path === 'update.baseUrl') {
        return baseUrl
      }
      throw new Error(`unexpected config path: ${path}`)
    }
  } as unknown as Configer
  const sendSystem = vi.fn(async () => Result.success(null))
  const outputManager = {
    sendSystem
  } as unknown as ChannelOutputManager
  return {
    updater: new Updater(configer, testMetadata, outputManager),
    sendSystem
  }
}
