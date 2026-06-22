import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import YAML from 'yaml'

export class YamlFile {
  static async read(path: string): Promise<unknown> {
    return this.parse(await readFile(path, 'utf8'))
  }

  static async write(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), {
      recursive: true
    })
    const tempPath = join(dirname(path), `.yaml-${Date.now()}-${process.pid}.tmp`)
    try {
      await writeFile(tempPath, this.stringify(value), 'utf8')
      await rename(tempPath, path)
    } catch (error) {
      await rm(tempPath, {
        force: true
      })
      throw error
    }
  }

  static parse(text: string): unknown {
    return YAML.parse(text)
  }

  static stringify(value: unknown): string {
    return YAML.stringify(value)
  }
}
