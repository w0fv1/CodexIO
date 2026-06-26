import { inject, injectable } from 'inversify'
import { AgentManager } from '../agent/AgentManager.js'
import { ChannelReceiveResult } from '../channel/Channel.js'
import { ChannelOutputManager } from '../channel/ChannelOutputManager.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { Message } from '../value/Message.js'
import { Updater } from '../component/Updater.js'

type ParsedInput =
  | {
    type: 'message'
    text: string
  }
  | {
    type: 'command'
    name: string
    args: string[]
  }

export type CommandExecutorInput = Message

const commandPrefixes = [
  '$',
  '￥'
]

const commandHelpText = [
  '可用命令：',
  '$update / ￥update：自动下载并安装最新版本，然后重启 Codexio。',
  '$help / ￥help / $? / ￥?：显示这份命令说明。'
].join('\n')

export function parseCommandInput(text: string): ParsedInput {
  const trimmed = text.trim()
  const prefix = commandPrefixes.find((item) => trimmed.startsWith(item))
  if (!prefix) {
    return {
      type: 'message',
      text
    }
  }
  const content = trimmed.slice(prefix.length).trim()
  if (content.length === 0) {
    return {
      type: 'command',
      name: '',
      args: []
    }
  }
  const parts = content.split(/\s+/)
  const [name, ...args] = parts
  return {
    type: 'command',
    name: name.toLowerCase(),
    args
  }
}

@injectable()
export class CommandExecutor {
  constructor(
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(AgentManager) private readonly agentManager: AgentManager,
    @inject(Updater) private readonly updater: Updater
  ) {}

  async receive(input: CommandExecutorInput): Promise<Result<ChannelReceiveResult>> {
    const parsed = parseCommandInput(input.text)
    if (parsed.type === 'message') {
      Logger.info('command executor received message', {
        ioThreadId: input.ioThreadId,
        length: parsed.text.length
      })
      const received = await this.agentManager.receiveMessage({
        ioThreadId: input.ioThreadId,
        role: 'user',
        text: parsed.text,
        files: input.files
      })
      if (received.isFailed) {
        return Result.fail<ChannelReceiveResult>(received.message)
      }
      return Result.success({
        ioThreadId: input.ioThreadId
      })
    }
    Logger.info('command executor received command', {
      ioThreadId: input.ioThreadId,
      command: parsed.name,
      args: parsed.args
    })
    if (parsed.name === 'update') {
      const started = await this.outputManager.sendSystem('正在执行：$update\n正在检查更新；如果发现新版本会自动安装并重启，如果已是最新版本会直接提示。', input.ioThreadId)
      if (started.isFailed) {
        return Result.fail<ChannelReceiveResult>(started.message)
      }
      const updated = await this.updater.update()
      if (updated.isFailed) {
        return this.sendCommandFailure('$update', updated.message, input.ioThreadId)
      }
      const sent = await this.outputManager.sendSystem(`已执行：$update\n${updated.data ?? updated.message}`, input.ioThreadId)
      if (sent.isFailed) {
        return Result.fail<ChannelReceiveResult>(sent.message)
      }
      Logger.info('command executor started update')
      return Result.success({
        action: 'update'
      })
    }
    if (parsed.name === 'help' || parsed.name === '?') {
      const sent = await this.outputManager.sendSystem(commandHelpText, input.ioThreadId)
      if (sent.isFailed) {
        return Result.fail<ChannelReceiveResult>(sent.message)
      }
      return Result.success({})
    }
    const name = parsed.name.length > 0 ? parsed.name : '(empty)'
    Logger.warn('command executor unknown command', {
      command: name
    })
    const sent = await this.outputManager.sendSystem(`unknown command: ${name}`, input.ioThreadId)
    if (sent.isFailed) {
      return Result.fail<ChannelReceiveResult>(sent.message)
    }
    return Result.success({})
  }

  private async sendCommandFailure(command: string, message: string, ioThreadId: string): Promise<Result<ChannelReceiveResult>> {
    const sent = await this.outputManager.sendSystem(`执行失败：${command}\n${message}`, ioThreadId)
    if (sent.isFailed) {
      return Result.fail<ChannelReceiveResult>(sent.message)
    }
    return Result.success({})
  }
}
