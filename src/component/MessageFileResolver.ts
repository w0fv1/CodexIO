import { basename, isAbsolute, join } from 'node:path'
import { inject, injectable } from 'inversify'
import { parseMarkdownAttachmentReferences } from '../util/Markdown.js'
import { createMessage, Message, MessageFile } from '../value/Message.js'
import { FileStore } from './FileStore.js'
import { Logger } from './Logger.js'

const remoteImageMaxBytes = 10 * 1024 * 1024
const remoteImageTimeoutMs = 30_000

@injectable()
export class MessageFileResolver {
  constructor(@inject(FileStore) private readonly fileStore: FileStore) {}

  async resolve(message: Message, workspacePath: string): Promise<Message> {
    const parsed = parseMarkdownAttachmentReferences(message.text)
    if (parsed.files.length === 0) {
      return message
    }
    const files = new Map<string, MessageFile>()
    for (const file of message.files ?? []) {
      files.set(file.sha256, file)
    }
    for (const reference of parsed.files) {
      try {
        const resolved = this.fileStore.resolveUrl(reference.path)
        if (resolved) {
          files.set(resolved.sha256, resolved)
          continue
        }
        if (/^https?:\/\//i.test(reference.path)) {
          const response = await fetch(reference.path, {
            signal: AbortSignal.timeout(remoteImageTimeoutMs)
          })
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }
          const declaredSize = Number(response.headers.get('content-length'))
          if (Number.isFinite(declaredSize) && declaredSize > remoteImageMaxBytes) {
            throw new Error(`remote image exceeds ${remoteImageMaxBytes} bytes`)
          }
          if (!response.body) {
            throw new Error('remote image response body is missing')
          }
          const chunks: Buffer[] = []
          let size = 0
          const reader = response.body.getReader()
          while (true) {
            const chunk = await reader.read()
            if (chunk.done) {
              break
            }
            size += chunk.value.byteLength
            if (size > remoteImageMaxBytes) {
              await reader.cancel()
              throw new Error(`remote image exceeds ${remoteImageMaxBytes} bytes`)
            }
            chunks.push(Buffer.from(chunk.value))
          }
          const imported = await this.fileStore.importBuffer({
            buffer: Buffer.concat(chunks, size),
            name: basename(new URL(reference.path).pathname) || reference.label,
            mime: response.headers.get('content-type') ?? undefined
          })
          files.set(imported.sha256, imported)
          continue
        }
        const localPath = isAbsolute(reference.path) ? reference.path : join(workspacePath, reference.path)
        const imported = await this.fileStore.importPath(localPath)
        files.set(imported.sha256, imported)
      } catch (error) {
        Logger.warn('agent file reference import failed', {
          path: reference.path,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return createMessage({
      id: message.id,
      occurredAt: message.occurredAt,
      thread: message.thread,
      role: message.role,
      text: parsed.text,
      files: files.size > 0 ? [...files.values()] : message.files
    })
  }
}
