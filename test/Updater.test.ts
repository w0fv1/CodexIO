import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelOutputManager } from '../src/channel/ChannelOutputManager.js'
import { CodexioMetadata } from '../src/component/CodexioMetadata.js'
import { Updater } from '../src/component/Updater.js'
import { Configer } from '../src/component/Configer.js'
import { Result } from '../src/value/Result.js'

const testMetadata = new CodexioMetadata()

describe('updater', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
  })

  it('prompts newer Electron release without download url', async () => {
    const currentVersionParts = testMetadata.readVersion().split('.').map((value) => Number.parseInt(value, 10))
    const nextVersion = [
      currentVersionParts[0],
      currentVersionParts[1],
      currentVersionParts[2] + 1
    ].join('.')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      isf: false,
      data: {
        version: nextVersion,
        platform: 'windows-x64-electron',
        fileName: `codexio-${nextVersion}-windows-x64-electron.exe`,
        fileSizeBytes: 111580,
        sha256: 'hash',
        managePath: '/manage/nfirco/release'
      }
    })))
    vi.stubGlobal('fetch', fetchMock)

    const { updater } = createUpdater(true, 'https://next.firco.cn')
    const message = await updater.check()

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://next.firco.cn/api/download/release/codexio/latest?platform=windows-x64-electron'))
    expect(message).toContain(nextVersion)
    expect(message).toContain('https://next.firco.cn/manage/nfirco/release')
    expect(message).toContain('系统托盘')
    expect(message).not.toContain('fileUrl')
  })

  it('skips disabled update checks', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { updater } = createUpdater(false, 'https://next.firco.cn')
    const message = await updater.check()

    expect(message).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats missing Electron release metadata as no update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      isf: true,
      data: null
    }))))

    const { updater } = createUpdater(true, 'https://next.firco.cn')
    const message = await updater.check()

    expect(message).toBeUndefined()
  })

  it('sends newer release message from start', async () => {
    const currentVersionParts = testMetadata.readVersion().split('.').map((value) => Number.parseInt(value, 10))
    const nextVersion = [
      currentVersionParts[0],
      currentVersionParts[1],
      currentVersionParts[2] + 1
    ].join('.')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      isf: false,
      data: {
        version: nextVersion,
        platform: 'windows-x64-electron',
        fileName: `codexio-${nextVersion}-windows-x64-electron.exe`,
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

  it('delegates install update to the Electron tray', async () => {
    const { updater } = createUpdater(true, 'https://next.firco.cn')

    const result = await updater.update()

    expect(result.isFailed).toBe(false)
    expect(result.data).toContain('系统托盘')
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
