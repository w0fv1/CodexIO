import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopLogExporter } from '../src/component/desktop/DesktopLogExporter.js'

describe('desktop log exporter', () => {
  it('writes one log snapshot to the download and clipboard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codexio-log-export-'))
    const sourcePath = join(root, '2026-07-13.log')
    const targetPath = join(root, 'Downloads', '2026-07-13.log')
    const writeText = vi.fn()
    await writeFile(sourcePath, 'first line\nsecond line\n', 'utf8')

    await new DesktopLogExporter({ writeText }).export(sourcePath, targetPath)

    expect(await readFile(targetPath, 'utf8')).toBe('first line\nsecond line\n')
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith('first line\nsecond line\n')
  })
})
