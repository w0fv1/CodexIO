import { inject, injectable } from 'inversify'
import { Configer, ConfigSubscription } from '../../component/Configer.js'
import { Logger } from '../../component/Logger.js'
import { MessageInbox } from '../../component/MessageInbox.js'
import { ThreadRegistry } from '../../component/ThreadRegistry.js'
import { ChannelOutputManager } from '../../component/channelo/ChannelOutputManager.js'
import { AgentManager } from '../../component/agent/AgentManager.js'
import { ChannelInputReceiveResult } from '../../value/Event.js'
import { createMessage, deriveMessageId } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { CommandExecutor } from '../CommandExecutor.js'
import { ChannelInput, ChannelInputMessage, ChannelInputReceiver, ChannelType } from './ChannelInput.js'
import { EmailChannelInput } from './EmailChannelInput.js'
import { FeishuChannelInput } from './FeishuChannelInput.js'
import { UserverThreadInput } from './UserverThreadInput.js'
import { WebChannelInput } from './WebChannelInput.js'

@injectable()
export class ChannelInputManager implements ChannelInputReceiver {
  private readonly availableInputs: ChannelInput[]
  private readonly inputs = new Map<string, ChannelInput>()
  private readonly inbox = new MessageInbox<ChannelInputReceiveResult>()
  private subscription?: ConfigSubscription
  private started = false

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ThreadRegistry) private readonly threadRegistry: ThreadRegistry,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(AgentManager) private readonly agentManager: AgentManager,
    @inject(CommandExecutor) private readonly commandExecutor: CommandExecutor,
    @inject(WebChannelInput) web: ChannelInput,
    @inject(FeishuChannelInput) feishu: ChannelInput,
    @inject(EmailChannelInput) email: ChannelInput,
    @inject(UserverThreadInput) userver: ChannelInput
  ) {
    this.availableInputs = [
      web,
      feishu,
      email,
      userver
    ]
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }
    this.started = true
    this.subscription = this.configer.subscribe('channeli', async () => {
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
    const process = async (): Promise<Result<ChannelInputReceiveResult>> => {
      const thread = this.threadRegistry.resolve(channelThreadId, input.text)
      Logger.info('channel input resolved thread', {
        source,
        channelSource: channelThreadId.source,
        channelThreadId: channelThreadId.id,
        sourceMessageId,
        messageId,
        ioThreadId: thread.id,
        bindings: this.threadRegistry.getChannelThreadIds(thread.id)
      })
      const message = createMessage({
        id: messageId,
        thread,
        role: 'user',
        text: input.text,
        files: input.files
      })
      const displayed = await this.outputManager.send(message, {
        source,
        sourceMessageId
      })
      if (displayed.isFailed) {
        Logger.warn('channel input display failed', {
          source,
          sourceMessageId,
          message: displayed.message
        })
      }
      const command = await this.commandExecutor.receive({
        source,
        message,
        input: normalizedInput
      })
      if (command.isFailed || command.data?.consumed) {
        return command
      }
      const received = await this.agentManager.receive(message)
      if (received.isFailed) {
        Logger.warn('agent input failed', {
          source,
          sourceMessageId,
          ioThreadId: message.thread.id,
          message: received.message
        })
        const reported = await this.outputManager.send(createMessage({
          id: deriveMessageId('agent-input-error', message.id),
          occurredAt: Math.max(Date.now(), message.occurredAt + 1),
          thread: message.thread,
          role: 'agent',
          text: received.message
        }), {
          source,
          sourceMessageId
        })
        if (reported.isFailed) {
          return Result.fail(`${received.message}\n${reported.message}`)
        }
        return Result.fail(received.message)
      }
      return Result.success({
        ioThreadId: message.thread.id
      })
    }
    return source === 'userver' ? process() : this.inbox.run(messageId, process)
  }

  async stop(): Promise<Result<void>> {
    this.started = false
    this.subscription?.dispose()
    this.subscription = undefined
    const failures: string[] = []
    for (const input of this.inputs.values()) {
      const result = await input.stop()
      if (result.isFailed) {
        failures.push(result.message)
      }
    }
    this.inputs.clear()
    if (failures.length > 0) {
      return Result.fail(failures.join('\n'))
    }
    return Result.successVoid()
  }

  private async applyConfig(): Promise<Result<void>> {
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
