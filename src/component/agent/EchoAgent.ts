import { injectable } from 'inversify'
import { Result } from '../../value/Result.js'
import { createMessage, deriveMessageId, Message } from '../../value/Message.js'
import { Logger } from '../Logger.js'
import { Agent, AgentOutputReceiver } from './Agent.js'

@injectable()
export class EchoAgent implements Agent {
  readonly type = 'echo'
  private receiver?: AgentOutputReceiver

  async start(receiver: AgentOutputReceiver): Promise<Result<void>> {
    this.receiver = receiver
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    this.receiver = undefined
    return Result.successVoid()
  }

  async receive(message: Message): Promise<Result<void>> {
    Logger.info('echo agent received channel message', {
      ioThreadId: message.thread.id,
      text: message.text,
      files: message.files?.length ?? 0
    })
    if (!this.receiver) {
      return Result.fail('echo agent output receiver not ready')
    }
    const result = await this.receiver.receiveAgentOutput(createMessage({
      id: deriveMessageId('echo', message.id),
      occurredAt: Math.max(Date.now(), message.occurredAt + 1),
      thread: message.thread,
      role: 'agent',
      text: message.text,
      files: message.files
    }))
    this.receiver.completeAgentTurn?.(message.thread.id, result.isFailed ? result.message : undefined)
    return result
  }
}
