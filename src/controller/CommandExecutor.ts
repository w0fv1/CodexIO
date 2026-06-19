import { AgentManager } from '../agent/AgentManager.js'
import { ChannelReceiveResult } from '../channel/Channel.js'
import { ChannelManager } from '../channel/ChannelManager.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'

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

export type CommandExecutorInput = {
  text: string
  source: string
}

const commandPrefixes = [
  '$',
  '￥'
]

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

export class CommandExecutor {
  constructor(
    private readonly channelManager: ChannelManager,
    private readonly agentManager: AgentManager
  ) {}

  async receive(input: CommandExecutorInput): Promise<Result<ChannelReceiveResult>> {
    const parsed = parseCommandInput(input.text)
    if (parsed.type === 'message') {
      Logger.info('command executor received message', {
        source: input.source,
        length: parsed.text.length
      })
      const displayed = await this.channelManager.displayUser(parsed.text, input.source)
      if (displayed.isFailed) {
        return Result.fail<ChannelReceiveResult>(displayed.message)
      }
      return this.agentManager.receiveMessage(parsed.text)
    }
    Logger.info('command executor received command', {
      source: input.source,
      command: parsed.name,
      args: parsed.args
    })
    if (parsed.name === 'clear') {
      const cleared = await this.agentManager.clear()
      if (cleared.isFailed) {
        return Result.fail<ChannelReceiveResult>(cleared.message)
      }
      await this.channelManager.clear(input.source)
      Logger.info('command executor cleared conversation', {
        source: input.source
      })
      return Result.success({
        action: 'clear'
      })
    }
    if (parsed.name === 'restart') {
      const restarted = await this.agentManager.restart()
      if (restarted.isFailed) {
        return Result.fail<ChannelReceiveResult>(restarted.message)
      }
      Logger.info('command executor restarted agent', {
        source: input.source
      })
      return Result.success({
        action: 'restart'
      })
    }
    const name = parsed.name.length > 0 ? parsed.name : '(empty)'
    Logger.warn('command executor unknown command', {
      source: input.source,
      command: name
    })
    const sent = await this.channelManager.sendSystem(`unknown command: ${name}`, input.source)
    if (sent.isFailed) {
      return Result.fail<ChannelReceiveResult>(sent.message)
    }
    return Result.success({})
  }
}
