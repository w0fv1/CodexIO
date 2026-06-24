import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { allIoThreadId, Message, MessageFile } from '../value/Message.js'
import { ChannelOutput } from './Channel.js'
import { Logger } from '../component/Logger.js'
import { Configer } from '../component/Configer.js'
import { FileStore } from '../component/FileStore.js'
import { EmailChannelOutput } from './EmailChannel.js'
import { FeishuChannelOutput } from './FeishuChannel.js'
import { FeishuWebhookChannelOutput } from './FeishuWebhookChannel.js'
import { WebChannelOutput } from './WebChannel.js'
import { parseMarkdownFileReferences } from '../util/Markdown.js'

@injectable()
export class ChannelOutputManager {
  private readonly availableOutputs: ChannelOutput[]
  private readonly outputs = new Map<string, ChannelOutput>()
  private readonly outputQueues = new Map<string, Promise<void>>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(WebChannelOutput) web: WebChannelOutput,
    @inject(FeishuChannelOutput) feishu: FeishuChannelOutput,
    @inject(FeishuWebhookChannelOutput) feishuWebhook: FeishuWebhookChannelOutput,
    @inject(EmailChannelOutput) email: EmailChannelOutput
  ) {
    this.availableOutputs = [
      web,
      feishu,
      feishuWebhook,
      email
    ]
  }

  async start(): Promise<void> {
    this.configer.subscribe('channels', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.sendSystem(`通道输出配置应用失败：${applied.message}`)
      }
    })
    await this.applyConfig()
  }

  async sendUser(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    Logger.info('user message received', {
      source: message.source ?? null,
      ioThreadId: message.ioThreadId,
      text: message.text,
      files: message.files?.length ?? 0
    })
    return this.send({
      ...message,
      role: 'user'
    })
  }

  async sendAgent(message: Message): Promise<Result<null>> {
    return this.send(await this.prepareAgentMessage({
      ...message,
      role: 'agent'
    }))
  }

  async sendSystem(text: string, source = 'unknown', ioThreadId?: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return this.send({
      ioThreadId: ioThreadId ?? allIoThreadId,
      role: 'system',
      text,
      createdAt: Date.now(),
      source
    })
  }

  async clear(ioThreadId: string, source = 'unknown'): Promise<Result<null>> {
    return this.broadcast({
      ioThreadId,
      role: 'system',
      text: 'clear',
      createdAt: Date.now(),
      source
    })
  }

  async stop(): Promise<Result<null>> {
    const failures: string[] = []
    await this.flushOutputs()
    for (const output of this.outputs.values()) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.success(null)
  }

  async applyConfig(): Promise<Result<null>> {
    const failures: string[] = []
    await this.flushOutputs()
    for (const output of this.outputs.values()) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(`${output.type}: ${result.message}`)
      }
    }
    this.outputs.clear()
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
    return Result.success(null)
  }

  private async send(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.broadcast(message)
  }

  private async prepareAgentMessage(message: Message): Promise<Message> {
    const parsed = parseMarkdownFileReferences(message.text)
    if (parsed.files.length === 0) {
      return message
    }
    const files = new Map<string, MessageFile>()
    for (const file of message.files ?? []) {
      files.set(file.id, file)
    }
    for (const reference of parsed.files) {
      const file = await this.resolveFileReference(reference.path)
      if (file) {
        files.set(file.id, file)
      }
    }
    return {
      ...message,
      text: parsed.text,
      files: files.size > 0 ? [...files.values()] : undefined
    }
  }

  private async resolveFileReference(path: string): Promise<MessageFile | undefined> {
    try {
      if (path.startsWith('/api/files/')) {
        return this.fileStore.resolveUrl(path)
      }
      return await this.fileStore.importPath(path.replaceAll('/', '\\'))
    } catch (error) {
      Logger.warn('agent markdown file reference ignored', {
        path,
        message: error instanceof Error ? error.message : String(error)
      })
      return undefined
    }
  }

  private async broadcast(message: Message): Promise<Result<null>> {
    if (this.outputs.size === 0) {
      return Result.fail('channel output not found')
    }
    for (const output of this.outputs.values()) {
      this.enqueueOutput(output, message)
    }
    return Result.success(null)
  }

  private enqueueOutput(output: ChannelOutput, message: Message): void {
    const previous = this.outputQueues.get(output.type) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      try {
        const result = await output.send(message)
        if (result.isFailed) {
          Logger.warn('channel output failed', {
            type: output.type,
            message: result.message
          })
        }
      } catch (error) {
        const failed = Result.fromError(error)
        Logger.warn('channel output failed', {
          type: output.type,
          message: failed.message
        })
      }
    })
    this.outputQueues.set(output.type, task)
    void task.finally(() => {
      if (this.outputQueues.get(output.type) === task) {
        this.outputQueues.delete(output.type)
      }
    })
  }

  private async flushOutputs(): Promise<void> {
    await Promise.allSettled(this.outputQueues.values())
  }
}
