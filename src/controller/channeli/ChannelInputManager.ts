import { inject, injectable } from 'inversify'
import { Configer } from '../../component/Configer.js'
import { EventBus } from '../../component/EventBus.js'
import { Logger } from '../../component/Logger.js'
import { MessageInbox } from '../../component/MessageInbox.js'
import { ThreadRegistry } from '../../component/ThreadRegistry.js'
import { AppEvent, ChannelInputReceiveResult } from '../../value/Event.js'
import { createMessage, deriveMessageId, deriveMessageRevision } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { CommandExecutor } from '../CommandExecutor.js'
import { ChannelInput, ChannelInputMessage, ChannelInputReceiver, ChannelType } from './ChannelInput.js'
import { EmailChannelInput } from './EmailChannelInput.js'
import { FeishuChannelInput } from './FeishuChannelInput.js'
import { NfircoThreadInput } from './NfircoThreadInput.js'
import { WebChannelInput } from './WebChannelInput.js'

@injectable()
export class ChannelInputManager implements ChannelInputReceiver {
  private readonly availableInputs: ChannelInput[]
  private readonly inputs = new Map<string, ChannelInput>()
  private readonly inbox = new MessageInbox<ChannelInputReceiveResult>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry,
    @inject(CommandExecutor) private readonly commandExecutor: CommandExecutor,
    @inject(WebChannelInput) web: ChannelInput,
    @inject(FeishuChannelInput) feishu: ChannelInput,
    @inject(EmailChannelInput) email: ChannelInput,
    @inject(NfircoThreadInput) nfirco: ChannelInput
  ) {
    this.availableInputs = [
      web,
      feishu,
      email,
      nfirco
    ]
  }

  async start(): Promise<void> {
    this.configer.subscribe('channeli', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        Logger.error('channel input config apply failed', new Error(applied.message))
      }
    })
    await this.applyConfig()
  }

  async receive(source: ChannelType, input: ChannelInputMessage): Promise<Result<ChannelInputReceiveResult>> {
    const sourceMessageId = input.sourceMessageId.trim()
    if (!sourceMessageId) {
      return Result.fail('sourceMessageId is required')
    }
    const channelThreadId = {
      ...input.channelThreadId,
      id: input.channelThreadId.id.trim()
    }
    const normalizedInput = {
      ...input,
      channelThreadId,
      sourceMessageId
    }
    const messageId = deriveMessageId('channel', source, channelThreadId.source, channelThreadId.id, sourceMessageId)
    const revision = deriveMessageRevision({
      status: 'completed',
      role: 'user',
      text: input.text,
      files: input.files
    })
    return this.inbox.run(messageId, revision, async () => {
      const thread = this.threadRegistry.resolve(channelThreadId, input.threadName, input.text)
      const message = createMessage({
        id: messageId,
        thread,
        role: 'user',
        text: input.text,
        files: input.files
      })
      const sendResultList = await this.eventBus.emitAsync(AppEvent.ChannelMessageDisplayRequested, {
        source,
        message,
        sourceMessageId
      })
      const sendFailures = sendResultList.filter((item) => item.isFailed)
      if (sendFailures.length > 0) {
        return Result.fail(sendFailures.map((item) => item.message).join('\n'))
      }
      const command = await this.commandExecutor.receive({
        source,
        message,
        input: normalizedInput
      })
      if (command.isFailed || command.data?.consumed) {
        return command
      }
      const resultList = await this.eventBus.emitAsync(AppEvent.ChannelMessageReceived, {
        source,
        message,
        sourceMessageId
      })
      const failures = resultList.filter((item) => item.isFailed)
      if (failures.length > 0) {
        return Result.fail(failures.map((item) => item.message).join('\n'))
      }
      return Result.success({
        ioThreadId: message.thread.id
      })
    })
  }

  async stop(): Promise<Result<void>> {
    const failures: string[] = []
    for (const input of this.inputs.values()) {
      const result = await input.stop()
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
    for (const input of this.inputs.values()) {
      const result = await input.stop()
      if (result.isFailed) {
        failures.push(`${input.type}: ${result.message}`)
      }
    }
    this.inputs.clear()
    for (const input of this.availableInputs) {
      try {
        if (await input.start(this)) {
          this.inputs.set(input.type, input)
        }
      } catch (error) {
        const failed = Result.fromError(error)
        failures.push(`${input.type}: ${failed.message}`)
      }
    }
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    Logger.info('channel input config applied')
    return Result.successVoid()
  }
}
