import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexioRootPath } from './AppMetadata.js'
import { ConfigSchema } from './ConfigService.js'
import { checkCodexioUpdate } from './UpdateChecker.js'

const releasePath = join(codexioRootPath, '.codexio', 'release.json')

describe('update checker', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(releasePath, {
      force: true
    })
  })

  it('prompts newer packaged release without download url', async () => {
    await writeFile(releasePath, JSON.stringify({
      platform: 'windows-x64-pnpm'
    }), 'utf8')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      isf: false,
      data: {
        version: '0.2.3',
        platform: 'windows-x64-pnpm',
        fileName: 'codexio-0.2.3-windows-x64-pnpm.zip',
        fileSizeBytes: 111580,
        sha256: 'hash',
        managePath: '/manage/nfirco/release'
      }
    })))
    vi.stubGlobal('fetch', fetchMock)

    const message = await checkCodexioUpdate(ConfigSchema.parse({
      update: {
        enabled: true,
        baseUrl: 'https://next.firco.cn'
      }
    }))

    expect(fetchMock).toHaveBeenCalledWith(new URL('https://next.firco.cn/api/download/release/codexio/latest?platform=windows-x64-pnpm'))
    expect(message).toContain('0.2.3')
    expect(message).toContain('https://next.firco.cn/manage/nfirco/release')
    expect(message).not.toContain('fileUrl')
  })

  it('skips source tree without packaged release metadata', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const message = await checkCodexioUpdate(ConfigSchema.parse({}))

    expect(message).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
