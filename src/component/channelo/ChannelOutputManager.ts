import { inject, injectable } from 'inversify'
import { basename, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Result } from '../../value/Result.js'
import { createMessage, Message, MessageFile } from '../../value/Message.js'
import { parseMarkdownAttachmentReferences } from '../../util/Markdown.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { FileStore } from '../FileStore.js'
import { Logger } from '../Logger.js'
import { Configer, ConfigSubscription } from '../Configer.js'
import { ThreadRegistry } from '../ThreadRegistry.js'
import { ThreadWorkspaceResolver } from '../ThreadWorkspaceResolver.js'
import { KeyedSerialQueue } from '../KeyedSerialQueue.js'
import { MessageInbox } from '../MessageInbox.js'
import { EmailChannelOutput } from './EmailChannelOutput.js'
import { FeishuChannelOutput } from './FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from './FeishuWebhookChannelOutput.js'
import { NfircoThreadOutput } from './NfircoThreadOutput.js'
import { WebChannelOutput } from './WebChannelOutput.js'

@injectable()
export class ChannelOutputManager {
  private readonly availableOutputs: ChannelOutput[]
  private readonly outputs = new Map<string, ChannelOutput>()
  private readonly deliveryQueue = new KeyedSerialQueue()
  private deliveryInbox = new MessageInbox<void>()
  private started = false
  private subscription?: ConfigSubscription

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry,
    @inject(WebChannelOutput) web: ChannelOutput,
    @inject(FeishuChannelOutput) feishu: ChannelOutput,
    @inject(FeishuWebhookChannelOutput) feishuWebhook: ChannelOutput,
    @inject(EmailChannelOutput) email: ChannelOutput,
    @inject(NfircoThreadOutput) nfirco: ChannelOutput,
    @inject(ThreadWorkspaceResolver) private readonly workspaceResolver: ThreadWorkspaceResolver
  ) {
    this.availableOutputs = [
      web,
      feishu,
      feishuWebhook,
      email,
      nfirco
    ]
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }
    this.started = true
    this.subscription = this.configer.subscribe('channelo', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.sendSystem(`通道输出配置应用失败：${applied.message}`)
      }
    })
    await this.applyConfig()
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>>
  async send(message: Message, source?: ChannelOutputContext['source']): Promise<Result<void>>
  async send(message: Message, contextOrSource?: ChannelOutputContext | ChannelOutputContext['source']): Promise<Result<void>> {
    const context = typeof contextOrSource === 'string' ? { source: contextOrSource } : contextOrSource
    if (message.role === 'user') {
      return this.sendUser(message, context)
    }
    if (message.role === 'agent') {
      return this.sendAgent(message, context)
    }
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.broadcast(createMessage({
      id: message.id,
      occurredAt: message.occurredAt,
      sequence: message.sequence,
      status: message.status,
      thread: message.thread,
      role: 'system',
      text: message.text,
      files: message.files
    }), context)
  }

  async sendUser(message: Message, context?: ChannelOutputContext): Promise<Result<void>>
  async sendUser(message: Message, source?: ChannelOutputContext['source']): Promise<Result<void>>
  async sendUser(message: Message, contextOrSource?: ChannelOutputContext | ChannelOutputContext['source']): Promise<Result<void>> {
    const context = typeof contextOrSource === 'string' ? { source: contextOrSource } : contextOrSource
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    Logger.info('user message received', {
      source: context?.source ?? null,
      ioThreadId: message.thread.id,
      text: message.text,
      files: message.files?.length ?? 0
    })
    const stored = createMessage({
      id: message.id,
      occurredAt: message.occurredAt,
      sequence: message.sequence,
      status: message.status,
      thread: message.thread,
      role: 'user',
      text: message.text,
      files: message.files
    })
    return this.broadcast(stored, {
      source: context?.source,
      sourceMessageId: context?.sourceMessageId
    })
  }

  async sendAgent(message: Message, context?: ChannelOutputContext): Promise<Result<void>>
  async sendAgent(message: Message, source?: ChannelOutputContext['source']): Promise<Result<void>>
  async sendAgent(message: Message, contextOrSource?: ChannelOutputContext | ChannelOutputContext['source']): Promise<Result<void>> {
    const context = typeof contextOrSource === 'string' ? { source: contextOrSource } : contextOrSource
    const prepared = await this.prepareAgentMessage(message)
    if (prepared.text.trim().length === 0 && (!prepared.files || prepared.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const stored = createMessage({
      id: prepared.id,
      occurredAt: prepared.occurredAt,
      sequence: prepared.sequence,
      status: prepared.status,
      thread: prepared.thread,
      role: 'agent',
      text: prepared.text,
      files: prepared.files
    })
    return this.broadcast(stored, {
      source: context?.source,
      sourceMessageId: context?.sourceMessageId
    })
  }

  async sendSystem(text: string, ioThreadId?: string): Promise<Result<void>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    const targetThread = ioThreadId?.trim()
      ? this.threadRegistry.get(ioThreadId)
      : this.threadRegistry.getLastActive()
    if (!targetThread) {
      return Result.fail('active ioThreadId not found')
    }
    const message = createMessage({
      id: randomUUID(),
      thread: targetThread,
      role: 'system',
      text
    })
    return this.send(message)
  }

  async stop(): Promise<Result<void>> {
    const failures: string[] = []
    if (this.started) {
      this.started = false
    }
    this.subscription?.dispose()
    this.subscription = undefined
    await this.flushOutputs()
    for (const output of this.outputs.values()) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    this.outputs.clear()
    this.deliveryInbox = new MessageInbox<void>()
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.successVoid()
  }

  private async applyConfig(): Promise<Result<void>> {
    const failures: string[] = []
    await this.flushOutputs()
    for (const output of this.outputs.values()) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(`${output.type}: ${result.message}`)
      }
    }
    this.outputs.clear()
    this.deliveryInbox = new MessageInbox<void>()
    for (const output of this.availableOutputs) {
      try {
        if (await output.start()) {
          this.outputs.set(output.type, output)
        }
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${output.type}: ${failed.message}`)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    Logger.info('channel output config applied')
    return Result.successVoid()
  }

  private async broadcast(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (this.outputs.size === 0) {
      return Result.fail('channel output not found')
    }
    const targetTypes = message.status === 'streaming' ? ['web'] : undefined
    const outputs = [...this.outputs.values()].filter((output) => !targetTypes || targetTypes.includes(output.type))
    if (outputs.length === 0) {
      return Result.fail(targetTypes
        ? `channel output not found: ${targetTypes.join(', ')}`
        : 'channel output not found')
    }
    const results = await Promise.all(outputs.map((output) => this.enqueueOutput(output, message, context)))
    const failures = results.flatMap((result, index) => result.isFailed
      ? [`${outputs[index].type}: ${result.message}`]
      : [])
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.successVoid()
  }

  private async prepareAgentMessage(message: Message): Promise<Message> {
    const parsed = parseMarkdownAttachmentReferences(message.text)
    if (parsed.files.length === 0) {
      return message
    }
    const files = new Map<string, MessageFile>()
    for (const file of message.files ?? []) {
      files.set(file.id, file)
    }
    const workspacePath = await this.workspaceResolver.resolve(message.thread.id)
    for (const reference of parsed.files) {
      try {
        const resolved = this.fileStore.resolveUrl(reference.path)
        if (resolved) {
          files.set(resolved.id, resolved)
          continue
        }
        if (/^https?:\/\//i.test(reference.path)) {
          const response = await fetch(reference.path)
          if (!response.ok) {
            Logger.warn('agent remote file reference ignored', {
              path: reference.path,
              status: response.status
            })
            continue
          }
          const buffer = Buffer.from(await response.arrayBuffer())
          const imported = await this.fileStore.importBuffer({
            buffer,
            name: reference.label || basename(new URL(reference.path).pathname),
            mime: response.headers.get('content-type') ?? undefined
          })
          files.set(imported.id, imported)
          continue
        }
        const localPath = isAbsolute(reference.path) ? reference.path : join(workspacePath, reference.path)
        const imported = await this.fileStore.importPath(localPath)
        files.set(imported.id, imported)
      } catch (error) {
        Logger.warn('agent markdown file reference ignored', {
          path: reference.path,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return {
      ...message,
      text: parsed.text,
      files: files.size > 0 ? [...files.values()] : message.files
    }
  }

  private enqueueOutput(output: ChannelOutput, message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    const key = `${output.type}\u0000${message.thread.id}`
    const deliveryId = `${output.type}\u0000${message.id}`
    return this.deliveryQueue.run(key, () => this.deliveryInbox.run(deliveryId, message.revision, async () => {
      try {
        const result = await output.send(message, context)
        if (result.isFailed) {
          Logger.warn('channel output failed', {
            type: output.type,
            message: result.message
          })
        }
        return result
      } catch (error) {
        const failed = Result.fromError(error)
        Logger.warn('channel output failed', {
          type: output.type,
          message: failed.message
        })
        return failed
      }
    }))
  }

  private async flushOutputs(): Promise<void> {
    await this.deliveryQueue.drain()
  }
}
