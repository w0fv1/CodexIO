import { inject, injectable } from 'inversify'
import { CommandExecutor } from '../controller/CommandExecutor.js'
import { Configer } from '../component/Configer.js'
import { Logger } from '../component/Logger.js'
import { Message } from '../value/Message.js'
import { Result } from '../value/Result.js'
import { ChannelInput, ChannelReceiveResult, ChannelType } from './Channel.js'
import { ChannelOutputManager } from './ChannelOutputManager.js'
import { EmailChannelInput } from './EmailChannel.js'
import { FeishuChannelInput } from './FeishuChannel.js'
import { WebChannelInput } from './WebChannel.js'

@injectable()
export class ChannelInputManager {
  private readonly availableInputs: ChannelInput[]
  private readonly inputs = new Map<string, ChannelInput>()

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(CommandExecutor) private readonly commandExecutor: CommandExecutor,
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
    this.configer.subscribe('channels', async () => {
      const applied = await this.applyConfig()
      if (applied.isFailed) {
        await this.outputManager.sendSystem(`通道输入配置应用失败：${applied.message}`)
      }
    })
    await this.applyConfig()
  }

  async receive(inputType: ChannelType, message: Message): Promise<Result<ChannelReceiveResult>> {
    const displayed = await this.outputManager.sendUser(message, inputType)
    if (displayed.isFailed) {
      return Result.fail<ChannelReceiveResult>(displayed.message)
    }
    return this.commandExecutor.receive(message)
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
        if (await input.start((message) => this.receive(input.type, message))) {
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
