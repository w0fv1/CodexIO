import { inject, injectable } from 'inversify'
import { randomUUID } from 'node:crypto'
import { Result } from '../../value/Result.js'
import { createMessage, Message } from '../../value/Message.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'
import { Logger } from '../Logger.js'
import { Configer, ConfigSubscription } from '../Configer.js'
import { ThreadRegistry } from '../ThreadRegistry.js'
import { KeyedSerialQueue } from '../KeyedSerialQueue.js'
import { MessageInbox } from '../MessageInbox.js'
import { EmailChannelOutput } from './EmailChannelOutput.js'
import { FeishuChannelOutput } from './FeishuChannelOutput.js'
import { FeishuWebhookChannelOutput } from './FeishuWebhookChannelOutput.js'
import { WebChannelOutput } from './WebChannelOutput.js'

@injectable()
export class ChannelOutputManager {
  private readonly availableOutputs: readonly ChannelOutput[]
  private activeOutputs: readonly ChannelOutput[] = []
  private readonly deliveryQueue = new KeyedSerialQueue()
  private deliveryInbox = new MessageInbox<void>()
  private started = false
  private subscription?: ConfigSubscription

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry,
    @inject(WebChannelOutput) web: ChannelOutput,
    @inject(FeishuChannelOutput) feishu: ChannelOutput,
    @inject(FeishuWebhookChannelOutput) feishuWebhook: ChannelOutput,
    @inject(EmailChannelOutput) email: ChannelOutput
  ) {
    this.availableOutputs = [
      web,
      feishu,
      feishuWebhook,
      email
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
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.broadcast(message, context)
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
    const outputs = this.activeOutputs
    this.activeOutputs = []
    await this.flushOutputs()
    for (const output of outputs) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    this.deliveryInbox = new MessageInbox<void>()
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.successVoid()
  }

  private async applyConfig(): Promise<Result<void>> {
    const failures: string[] = []
    const previousOutputs = this.activeOutputs
    this.activeOutputs = []
    await this.flushOutputs()
    for (const output of previousOutputs) {
      const result = await output.stop()
      if (result.isFailed) {
        failures.push(`${output.type}: ${result.message}`)
      }
    }
    const activeOutputs: ChannelOutput[] = []
    for (const output of this.availableOutputs) {
      try {
        if (await output.start()) {
          activeOutputs.push(output)
        }
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${output.type}: ${failed.message}`)
      }
    }
    this.activeOutputs = activeOutputs
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    Logger.info('channel output config applied')
    return Result.successVoid()
  }

  private async broadcast(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    const outputs = this.activeOutputs
    if (outputs.length === 0) {
      return Result.fail('channel output not found')
    }
    Logger.info('channel output dispatch started', {
      messageId: message.id,
      ioThreadId: message.thread.id,
      role: message.role,
      source: context?.source ?? null,
      sourceMessageId: context?.sourceMessageId ?? null,
      outputs: outputs.map((output) => output.type)
    })
    const results = await Promise.all(outputs.map((output) => this.enqueueOutput(output, message, context)))
    const failures = results.flatMap((result, index) => result.isFailed
      ? [`${outputs[index].type}: ${result.message}`]
      : [])
    if (failures.length > 0) {
      Logger.warn('channel output dispatch failed', {
        messageId: message.id,
        ioThreadId: message.thread.id,
        failures
      })
      return Result.fail(failures.join('\n'))
    }
    Logger.info('channel output dispatch completed', {
      messageId: message.id,
      ioThreadId: message.thread.id,
      outputs: outputs.map((output) => output.type)
    })
    return Result.successVoid()
  }

  private enqueueOutput(output: ChannelOutput, message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    const key = `${output.type}\u0000${message.thread.id}`
    const deliveryId = `${output.type}\u0000${message.id}`
    return this.deliveryQueue.run(key, () => this.deliveryInbox.run(deliveryId, async () => {
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
