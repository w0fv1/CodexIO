import { inject, injectable } from 'inversify'
import { Configer } from '../../component/Configer.js'
import { EventBus } from '../../component/EventBus.js'
import { Logger } from '../../component/Logger.js'
import { IoThreadIdManager } from '../../component/IoThreadIdManager.js'
import { AppEvent, ChannelInputReceiveResult } from '../../value/Event.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { ChannelInput, ChannelInputMessage, ChannelInputReceiver, ChannelType } from './ChannelInput.js'
import { EmailChannelInput } from './EmailChannelInput.js'
import { FeishuChannelInput } from './FeishuChannelInput.js'
import { WebChannelInput } from './WebChannelInput.js'

@injectable()
export class ChannelInputManager implements ChannelInputReceiver {
  private readonly availableInputs: ChannelInput[]
  private readonly inputs = new Map<string, ChannelInput>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager,
    @inject(WebChannelInput) web: WebChannelInput,
    @inject(FeishuChannelInput) feishu: FeishuChannelInput,
    @inject(EmailChannelInput) email: EmailChannelInput
  ) {
    this.availableInputs = [
      web,
      feishu,
      email
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

  async receive(inputType: ChannelType, input: ChannelInputMessage): Promise<Result<ChannelInputReceiveResult>> {
    const [primaryPlatformThreadId, ...secondaryPlatformThreadIds] = input.platformThreadIds
    const ioThreadId = this.ioThreadIdManager.getIoThreadId(primaryPlatformThreadId)
    for (const platformThreadId of secondaryPlatformThreadIds) {
      this.ioThreadIdManager.bind(ioThreadId, platformThreadId)
    }
    const message: Message = {
      ioThreadId,
      role: 'user',
      text: input.text,
      files: input.files
    }
    const sendResultList = await this.eventBus.emitAsync(AppEvent.ChannelMessageSendRequested, {
      inputType,
      message
    })
    const sendFailures = sendResultList.filter((item) => item.isFailed)
    if (sendFailures.length > 0) {
      return Result.fail(sendFailures.map((item) => item.message).join('\n'))
    }
    const resultList = await this.eventBus.emitAsync(AppEvent.ChannelMessageReceived, {
      inputType,
      message
    })
    const failures = resultList.filter((item) => item.isFailed)
    if (failures.length > 0) {
      return Result.fail(failures.map((item) => item.message).join('\n'))
    }
    return Result.success({
      ioThreadId: message.ioThreadId
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
