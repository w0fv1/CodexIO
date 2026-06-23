import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileTypeFromBuffer } from 'file-type'
import { inject, injectable } from 'inversify'
import { CodexioMetadata } from './CodexioMetadata.js'
import { MessageFile } from '../value/Message.js'

export type FileStoreBufferInput = {
  buffer: Buffer
  name: string
  mime?: string
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

@injectable()
export class FileStore {
  private readonly rootPath: string
  private readonly maxFileSizeBytes: number
  private readonly files = new Map<string, MessageFile>()

  constructor(@inject(CodexioMetadata) metadata: CodexioMetadata) {
    this.rootPath = resolve(join(metadata.rootPath, '.codexio', 'file'))
    this.maxFileSizeBytes = 20 * 1024 * 1024
  }

  async importPath(path: string): Promise<MessageFile> {
    const resolvedPath = resolve(path)
    const metadata = await stat(resolvedPath)
    if (!metadata.isFile()) {
      throw new Error(`file is not a regular file: ${resolvedPath}`)
    }
    if (metadata.size > this.maxFileSizeBytes) {
      throw new Error(`file is too large: ${resolvedPath}`)
    }
    const buffer = await readFile(resolvedPath)
    const prepared = await this.prepare(buffer, basename(resolvedPath))
    await mkdir(this.rootPath, {
      recursive: true
    })
    await copyFile(resolvedPath, prepared.path)
    this.files.set(prepared.id, prepared)
    return prepared
  }

  async importBuffer(input: FileStoreBufferInput): Promise<MessageFile> {
    if (input.buffer.length > this.maxFileSizeBytes) {
      throw new Error('file is too large')
    }
    const prepared = await this.prepare(input.buffer, input.name, input.mime)
    await mkdir(this.rootPath, {
      recursive: true
    })
    await writeFile(prepared.path, input.buffer)
    this.files.set(prepared.id, prepared)
    return prepared
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
    const mime = detected?.mime ?? (providedMime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(providedMime) ? providedMime : 'application/octet-stream')
    const id = randomUUID()
    const baseName = basename(name)
    const extension = imageMimeExtensions.get(mime) ?? (detected?.ext ? `.${detected.ext}` : extname(baseName))
    const path = join(this.rootPath, `${id}${extension}`)
    return {
      id,
      mime,
      name: baseName || `${id}${extension}`,
      size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      path,
      url: `/api/files/${id}`
    }
  }
}
