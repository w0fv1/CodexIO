import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type DesktopClipboard = {
  writeText: (text: string) => void
}

export class DesktopLogExporter {
  constructor(private readonly clipboard: DesktopClipboard) {}

  async export(sourcePath: string, targetPath: string): Promise<void> {
    const content = await readFile(sourcePath, 'utf8')
    await mkdir(dirname(targetPath), {
      recursive: true
    })
    await writeFile(targetPath, content, 'utf8')
    this.clipboard.writeText(content)
  }
}
