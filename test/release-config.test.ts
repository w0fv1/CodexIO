import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release configuration', () => {
  it('uses the canonical release routes', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
    const releaseScript = await readFile('release.ps1', 'utf8')

    expect(packageJson.build.publish).toContainEqual({
      provider: 'generic',
      url: 'https://next.firco.cn/api/release/codexio'
    })
    expect(releaseScript).toContain('/apim/release/$($releaseInfo.appKey)')
    expect(releaseScript).toContain('/api/release/$AppKey/latest')
    expect(releaseScript).not.toContain('/download/release/')
  })
})
