import { inject, injectable } from 'inversify'
import { AppEvent, ChannelMessageReceivedEvent } from '../../value/Event.js'
import { Result } from '../../value/Result.js'
import { createMessage, deriveMessageId } from '../../value/Message.js'
import { EventBus } from '../EventBus.js'
import { Logger } from '../Logger.js'
import { Agent } from './Agent.js'

@injectable()
export class EchoAgent implements Agent {
  readonly type = 'echo'

  constructor(
    @inject(EventBus) private readonly eventBus: EventBus
  ) {}

  async start(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    return Result.successVoid()
  }

  async receive(event: ChannelMessageReceivedEvent): Promise<Result<void>> {
    Logger.info('echo agent received channel message', {
      source: event.source,
      ioThreadId: event.message.thread.id,
      text: event.message.text,
      files: event.message.files?.length ?? 0
    })
    const resultList = await this.eventBus.emitAsync(AppEvent.ChannelMessageDisplayRequested, {
      source: event.source,
      sourceMessageId: event.sourceMessageId,
      message: createMessage({
        id: deriveMessageId('echo', event.message.id),
        occurredAt: Math.max(Date.now(), event.message.occurredAt + 1),
        thread: event.message.thread,
        role: 'agent',
        text: event.message.text,
        files: event.message.files
      })
    })
    const failures = resultList.filter((item) => item.isFailed)
    if (failures.length > 0) {
      return Result.fail(failures.map((item) => item.message).join('\n'))
    }
    return Result.successVoid()
  }
}
