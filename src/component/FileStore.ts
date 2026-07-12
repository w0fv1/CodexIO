import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { fileTypeFromBuffer } from 'file-type'
import { inject, injectable } from 'inversify'
import { CodexioMetadata } from './CodexioMetadata.js'
import { MessageFile } from '../value/Message.js'

export type FileStoreBufferInput = {
  buffer: Buffer
  name: string
  mime?: string
}

export type FileStoreCleanupResult = {
  deleted: number
  bytes: number
}

export function isImageFile(file: Pick<MessageFile, 'mime'>): boolean {
  return file.mime.toLowerCase().startsWith('image/')
}

const imageMimeExtensions = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
])

const extensionMimes = new Map<string, string>([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
])

@injectable()
export class FileStore {
  private readonly rootPath: string
  private readonly files = new Map<string, MessageFile>()

  constructor(@inject(CodexioMetadata) metadata: CodexioMetadata) {
    this.rootPath = metadata.filePath
  }

  async importPath(path: string): Promise<MessageFile> {
    const resolvedPath = resolve(path)
    const metadata = await stat(resolvedPath)
    if (!metadata.isFile()) {
      throw new Error(`file is not a regular file: ${resolvedPath}`)
    }
    const buffer = await readFile(resolvedPath)
    return this.importBuffer({
      buffer,
      name: basename(resolvedPath)
    })
  }

  async importBuffer(input: FileStoreBufferInput): Promise<MessageFile> {
    const prepared = await this.prepare(input.buffer, input.name, input.mime)
    await mkdir(this.rootPath, {
      recursive: true
    })
    try {
      await stat(prepared.path)
      await utimes(prepared.path, new Date(), new Date())
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }
      const temporaryPath = join(this.rootPath, `.${prepared.id}.${randomUUID()}.tmp`)
      await writeFile(temporaryPath, input.buffer, {
        flag: 'wx'
      })
      try {
        await rename(temporaryPath, prepared.path)
      } catch (renameError) {
        await rm(temporaryPath, {
          force: true
        })
        try {
          await stat(prepared.path)
        } catch {
          throw renameError
        }
      }
    }
    this.files.set(prepared.id, prepared)
    return prepared
  }

  async cleanup(retentionDays = 30, now = new Date()): Promise<FileStoreCleanupResult> {
    await mkdir(this.rootPath, {
      recursive: true
    })
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000
    const activePaths = new Set([...this.files.values()].map((file) => file.path))
    let deleted = 0
    let bytes = 0
    for (const entry of await readdir(this.rootPath, {
      withFileTypes: true
    })) {
      if (!entry.isFile()) {
        continue
      }
      const path = join(this.rootPath, entry.name)
      if (activePaths.has(path)) {
        continue
      }
      const metadata = await stat(path)
      if (metadata.mtimeMs >= cutoff) {
        continue
      }
      await rm(path, {
        force: true
      })
      deleted += 1
      bytes += metadata.size
    }
    return {
      deleted,
      bytes
    }
  }

  async read(id: string): Promise<Buffer> {
    const file = this.resolve(id)
    return readFile(file.path)
  }

  resolve(id: string): MessageFile {
    const file = this.files.get(id)
    if (!file) {
      throw new Error(`file not found: ${id}`)
    }
    return file
  }

  resolveMany(ids: string[]): MessageFile[] {
    return ids.map((id) => this.resolve(id))
  }

  resolveUrl(url: string): MessageFile | undefined {
    const match = /^\/api\/files\/([^/?#]+)/.exec(url.trim())
    if (!match) {
      return undefined
    }
    return this.files.get(decodeURIComponent(match[1]))
  }

  private async prepare(buffer: Buffer, name: string, inputMime?: string): Promise<MessageFile> {
    const detected = await fileTypeFromBuffer(buffer)
    const providedMime = inputMime?.trim().toLowerCase()
    const baseName = basename(name)
    const inputExtension = extname(baseName).toLowerCase()
    const mime = detected?.mime ?? (providedMime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(providedMime) ? providedMime : extensionMimes.get(inputExtension) ?? 'application/octet-stream')
    const id = createHash('sha256').update(buffer).digest('hex')
    const extension = imageMimeExtensions.get(mime) ?? (detected?.ext ? `.${detected.ext}` : extname(baseName))
    const path = join(this.rootPath, id)
    return {
      id,
      mime,
      name: baseName || `${id}${extension}`,
      size: buffer.length,
      sha256: id,
      path,
      url: `/api/files/${id}`
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
