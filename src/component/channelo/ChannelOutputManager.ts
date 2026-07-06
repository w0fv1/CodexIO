import { inject, injectable } from 'inversify'
import { basename, isAbsolute, join } from 'node:path'
import { Result } from '../../value/Result.js'
import { Message, MessageFile } from '../../value/Message.js'
import { AppEvent, ChannelMessageSendRequestedEvent } from '../../value/Event.js'
import { parseMarkdownAttachmentReferences } from '../../util/Markdown.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { FileStore } from '../FileStore.js'
import { Logger } from '../Logger.js'
import { Configer } from '../Configer.js'
import { EventBus } from '../EventBus.js'
import { IoThreadIdManager } from '../IoThreadIdManager.js'
import { ThreadWorkspaceResolver } from '../ThreadWorkspaceResolver.js'
import { EmailChannelOutput } from './EmailChannelOutput.js'
import { FeishuChannelOutput } from './FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from './FeishuWebhookChannelOutput.js'
import { NfircoThreadOutput } from './NfircoThreadOutput.js'
import { WebChannelOutput } from './WebChannelOutput.js'

const inputOutputTypes = new Set<string>([
  'web',
  'feishu',
  'email',
  'nfirco'
])

@injectable()
export class ChannelOutputManager {
  private readonly listener = (event: ChannelMessageSendRequestedEvent) => this.send(event.message, event.inputType)
  private readonly availableOutputs: ChannelOutput[]
  private readonly outputs = new Map<string, ChannelOutput>()
  private readonly outputQueues = new Map<string, Promise<void>>()
  private started = false

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager,
    @inject(WebChannelOutput) web: WebChannelOutput,
    @inject(FeishuChannelOutput) feishu: FeishuChannelOutput,
    @inject(FeishuWebhookChannelOutput) feishuWebhook: FeishuWebhookChannelOutput,
    @inject(EmailChannelOutput) email: EmailChannelOutput,
    @inject(NfircoThreadOutput) nfirco: NfircoThreadOutput,
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
    if (!this.started) {
      this.started = true
      this.eventBus.on(AppEvent.ChannelMessageSendRequested, this.listener)
    }
    this.configer.subscribe('channelo', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.sendSystem(`通道输出配置应用失败：${applied.message}`)
      }
    })
    await this.applyConfig()
  }

  async send(message: Message, inputType?: ChannelOutputContext['inputType']): Promise<Result<void>> {
    if (message.role === 'user') {
      return this.sendUser(message, inputType)
    }
    if (message.role === 'agent') {
      return this.sendAgent(message, inputType)
    }
    return this.sendSystem(message.text, message.ioThreadId)
  }

  async sendUser(message: Message, inputType?: ChannelOutputContext['inputType']): Promise<Result<void>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    Logger.info('user message received', {
      inputType: inputType ?? null,
      ioThreadId: message.ioThreadId,
      text: message.text,
      files: message.files?.length ?? 0
    })
    const stored: Message = {
      ...message,
      role: 'user'
    }
    return this.broadcast(stored, {
      inputType
    })
  }

  async sendAgent(message: Message, inputType?: ChannelOutputContext['inputType']): Promise<Result<void>> {
    const prepared = await this.prepareAgentMessage(message)
    if (prepared.text.trim().length === 0 && (!prepared.files || prepared.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const stored: Message = {
      ...prepared,
      role: 'agent'
    }
    return this.broadcast(stored, {
      inputType
    })
  }

  async sendSystem(text: string, ioThreadId?: string): Promise<Result<void>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    const targetIoThreadId = ioThreadId?.trim() || this.ioThreadIdManager.getLastActiveIoThreadId()
    if (!targetIoThreadId) {
      return Result.fail('active ioThreadId not found')
    }
    const message = {
      ioThreadId: targetIoThreadId,
      role: 'system',
      text
    } satisfies Message
    return this.broadcast(message)
  }

  async stop(): Promise<Result<void>> {
    const failures: string[] = []
    if (this.started) {
      this.started = false
      this.eventBus.off(AppEvent.ChannelMessageSendRequested, this.listener)
    }
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
    return Result.successVoid()
  }

  async applyConfig(): Promise<Result<void>> {
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
    return Result.successVoid()
  }

  private async broadcast(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (this.outputs.size === 0) {
      return Result.fail('channel output not found')
    }
    const outputs = [...this.outputs.values()].filter((output) => {
      if (!context?.inputType) {
        return true
      }
      return output.type === 'web' || output.type === context.inputType || !inputOutputTypes.has(output.type)
    })
    if (outputs.length === 0) {
      return Result.fail('channel output not found')
    }
    for (const output of outputs) {
      this.enqueueOutput(output, message, context)
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
    const workspacePath = await this.workspaceResolver.resolve(message.ioThreadId)
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

  private enqueueOutput(output: ChannelOutput, message: Message, context?: ChannelOutputContext): void {
    const previous = this.outputQueues.get(output.type) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      try {
        const result = await output.send(message, context)
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
