import { inject, injectable } from 'inversify'
import { Result } from '../../value/Result.js'
import { createMessage, deriveMessageId } from '../../value/Message.js'
import { ChannelOutputManager } from '../channelo/ChannelOutputManager.js'
import { Logger } from '../Logger.js'
import { Agent, AgentInput } from './Agent.js'

@injectable()
export class EchoAgent implements Agent {
  readonly type = 'echo'

  constructor(
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager
  ) {}

  async start(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async receive(event: AgentInput): Promise<Result<void>> {
    Logger.info('echo agent received channel message', {
      source: event.source,
      ioThreadId: event.message.thread.id,
      text: event.message.text,
      files: event.message.files?.length ?? 0
    })
    return this.outputManager.sendAgent(createMessage({
      id: deriveMessageId('echo', event.message.id),
      occurredAt: Math.max(Date.now(), event.message.occurredAt + 1),
      thread: event.message.thread,
      role: 'agent',
      text: event.message.text,
      files: event.message.files
    }), {
      source: event.source,
      sourceMessageId: event.sourceMessageId
    })
  }
}
