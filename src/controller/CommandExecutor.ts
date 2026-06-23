import { inject, injectable } from 'inversify'
import { AgentManager } from '../agent/AgentManager.js'
import { ChannelReceiveResult } from '../channel/Channel.js'
import { ChannelManager } from '../channel/ChannelManager.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { Message } from '../value/Message.js'
import { UpdateService } from '../component/UpdateService.js'
import { SupervisorClient } from '../component/ServerLifecycle.js'

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
  '$restart / ￥restart：重启 Codexio 应用，使已更新或已修改的应用代码生效。',
  '$clear / ￥clear：清空当前会话显示并重置 agent 会话。',
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
    @inject(ChannelManager) private readonly channelManager: ChannelManager,
    @inject(AgentManager) private readonly agentManager: AgentManager,
    @inject(UpdateService) private readonly updateService: UpdateService,
    @inject(SupervisorClient) private readonly supervisorClient: SupervisorClient
  ) {}

  async receive(input: CommandExecutorInput): Promise<Result<ChannelReceiveResult>> {
    const parsed = parseCommandInput(input.text)
    if (parsed.type === 'message') {
      Logger.info('command executor received message', {
        source: input.source,
        ioThreadId: input.ioThreadId,
        length: parsed.text.length
      })
      const displayed = await this.channelManager.displayUser({
        role: 'user',
        ioThreadId: input.ioThreadId,
        text: parsed.text,
        createdAt: input.createdAt,
        source: input.source,
        files: input.files
      })
      if (displayed.isFailed) {
        return Result.fail<ChannelReceiveResult>(displayed.message)
      }
      const received = await this.agentManager.receiveMessage({
        ioThreadId: input.ioThreadId,
        role: 'user',
        text: parsed.text,
        createdAt: input.createdAt,
        source: input.source,
        files: input.files
      })
      if (received.isFailed) {
        return Result.fail<ChannelReceiveResult>(received.message)
      }
      return Result.success({
        ...received.data,
        ioThreadId: input.ioThreadId
      })
    }
    Logger.info('command executor received command', {
      source: input.source,
      ioThreadId: input.ioThreadId,
      command: parsed.name,
      args: parsed.args
    })
    if (parsed.name !== 'clear') {
      const displayed = await this.channelManager.displayUser({
        role: 'user',
        ioThreadId: input.ioThreadId,
        text: input.text,
        createdAt: input.createdAt,
        source: input.source,
        files: input.files
      })
      if (displayed.isFailed) {
        return Result.fail<ChannelReceiveResult>(displayed.message)
      }
    }
    if (parsed.name === 'clear') {
      const cleared = await this.agentManager.clear(input.ioThreadId)
      if (cleared.isFailed) {
        return this.sendCommandFailure('$clear', cleared.message, input.source ?? 'unknown', input.ioThreadId)
      }
      await this.channelManager.clear(input.ioThreadId, input.source ?? 'unknown')
      Logger.info('command executor cleared conversation', {
        source: input.source,
        ioThreadId: input.ioThreadId
      })
      return Result.success({
        action: 'clear'
      })
    }
    if (parsed.name === 'restart') {
      const started = await this.channelManager.sendSystem('正在重启 Codexio，页面会自动重连。', input.source ?? 'unknown', input.ioThreadId)
      if (started.isFailed) {
        return Result.fail<ChannelReceiveResult>(started.message)
      }
      try {
        await this.supervisorClient.restart()
      } catch (error) {
        const failed = Result.fromError(error)
        return this.sendCommandFailure('$restart', failed.message, input.source ?? 'unknown', input.ioThreadId)
      }
      Logger.info('command executor requested application restart', {
        source: input.source
      })
      return Result.success({
        action: 'restart'
      })
    }
    if (parsed.name === 'update') {
      const started = await this.channelManager.sendSystem('正在执行：$update\n正在检查更新；如果发现新版本会自动安装并重启，如果已是最新版本会直接提示。', input.source ?? 'unknown', input.ioThreadId)
      if (started.isFailed) {
        return Result.fail<ChannelReceiveResult>(started.message)
      }
      const updated = await this.updateService.update()
      if (updated.isFailed) {
        return this.sendCommandFailure('$update', updated.message, input.source ?? 'unknown', input.ioThreadId)
      }
      const sent = await this.channelManager.sendSystem(`已执行：$update\n${updated.data ?? updated.message}`, input.source ?? 'unknown', input.ioThreadId)
      if (sent.isFailed) {
        return Result.fail<ChannelReceiveResult>(sent.message)
      }
      Logger.info('command executor started update', {
        source: input.source
      })
      return Result.success({
        action: 'update'
      })
    }
    if (parsed.name === 'help' || parsed.name === '?') {
      const sent = await this.channelManager.sendSystem(commandHelpText, input.source ?? 'unknown', input.ioThreadId)
      if (sent.isFailed) {
        return Result.fail<ChannelReceiveResult>(sent.message)
      }
      return Result.success({})
    }
    const name = parsed.name.length > 0 ? parsed.name : '(empty)'
    Logger.warn('command executor unknown command', {
      source: input.source ?? 'unknown',
      command: name
    })
    const sent = await this.channelManager.sendSystem(`unknown command: ${name}`, input.source ?? 'unknown', input.ioThreadId)
    if (sent.isFailed) {
      return Result.fail<ChannelReceiveResult>(sent.message)
    }
    return Result.success({})
  }

  private async sendCommandFailure(command: string, message: string, source: string, ioThreadId: string): Promise<Result<ChannelReceiveResult>> {
    const sent = await this.channelManager.sendSystem(`执行失败：${command}\n${message}`, source, ioThreadId)
    if (sent.isFailed) {
      return Result.fail<ChannelReceiveResult>(sent.message)
    }
    return Result.success({})
  }
}
