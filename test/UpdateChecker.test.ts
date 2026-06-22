import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexioRootPath, readCodexioVersion } from '../src/AppMetadata.js'
import { ConfigSchema } from '../src/config/ConfigDefinition.js'
import { checkCodexioUpdate } from '../src/component/UpdateChecker.js'

const releasePath = join(codexioRootPath, '.codexio', 'release.json')

describe('update checker', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(releasePath, {
      force: true
    })
  })

  it('prompts newer packaged release without download url', async () => {
    const currentVersionParts = readCodexioVersion().split('.').map((value) => Number.parseInt(value, 10))
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

    const message = await checkCodexioUpdate(ConfigSchema.parse({
      update: {
        enabled: true,
        baseUrl: 'https://next.firco.cn'
      }
    }))

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

    const message = await checkCodexioUpdate(ConfigSchema.parse({}))

    expect(message).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
