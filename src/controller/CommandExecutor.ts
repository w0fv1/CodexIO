import { inject, injectable } from 'inversify'
import { ChannelOutputManager } from '../component/channelo/ChannelOutputManager.js'
import { Logger } from '../component/Logger.js'
import type { ChannelType, ChannelInputMessage } from './channeli/ChannelInput.js'
import { ChannelInputReceiveResult } from '../value/Event.js'
import { createMessage, deriveMessageId, Message, MessageThread } from '../value/Message.js'
import { Result } from '../value/Result.js'

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
  source: ChannelType
  message: Message
  input: ChannelInputMessage
}

const commandPrefixes = [
  '$',
  '￥'
]

const commandHelpText = [
  '可用命令：',
  '$test / ￥test：打印当前飞书发送者标识。',
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
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager
  ) {}

  async receive(input: CommandExecutorInput): Promise<Result<ChannelInputReceiveResult>> {
    const parsed = parseCommandInput(input.message.text)
    if (parsed.type === 'message') {
      return Result.success({
        consumed: false,
        ioThreadId: input.message.thread.id
      })
    }
    Logger.info('command executor received command', {
      source: input.source,
      ioThreadId: input.message.thread.id,
      command: parsed.name,
      args: parsed.args
    })
    if (parsed.name === 'test') {
      if (input.source === 'feishu' && !input.input.mentioned) {
        Logger.info('command executor test ignored', {
          source: input.source,
          ioThreadId: input.message.thread.id,
          reason: 'aite required'
        })
        return Result.success({
          consumed: true,
          ioThreadId: input.message.thread.id
        })
      }
      Logger.info('command executor test', {
        source: input.source,
        ioThreadId: input.message.thread.id,
        mentioned: Boolean(input.input.mentioned),
        openId: input.input.sender?.openId ?? '',
        userId: input.input.sender?.userId ?? '',
        unionId: input.input.sender?.unionId ?? ''
      })
      return Result.success({
        consumed: true,
        ioThreadId: input.message.thread.id
      })
    }
    if (parsed.name === 'help' || parsed.name === '?') {
      const sent = await this.sendSystem(commandHelpText, input.source, input.message.thread, input.message.id, input.input.sourceMessageId)
      if (sent.isFailed) {
        return Result.fail(sent.message)
      }
      return Result.success({
        consumed: true,
        ioThreadId: input.message.thread.id
      })
    }
    const name = parsed.name.length > 0 ? parsed.name : '(empty)'
    Logger.warn('command executor unknown command', {
      source: input.source,
      command: name
    })
    const sent = await this.sendSystem(`unknown command: ${name}`, input.source, input.message.thread, input.message.id, input.input.sourceMessageId)
    if (sent.isFailed) {
      return Result.fail(sent.message)
    }
    return Result.success({
      consumed: true,
      ioThreadId: input.message.thread.id
    })
  }

  private async sendSystem(
    text: string,
    source: ChannelType,
    thread: MessageThread,
    requestMessageId: string,
    sourceMessageId?: string
  ): Promise<Result<void>> {
    return this.outputManager.send(createMessage({
      id: deriveMessageId('command', requestMessageId),
      thread,
      role: 'system',
      text
    }), {
      source,
      sourceMessageId
    })
  }
}
