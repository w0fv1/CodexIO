import { randomUUID } from 'node:crypto'
import { inject, injectable } from 'inversify'
import { Configer } from '../Configer.js'
import { IoThreadIdManager } from '../IoThreadIdManager.js'
import { Logger } from '../Logger.js'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { createNfircoThreadMessage, normalizeNfircoThreadCredentials } from '../channel/NfircoThreadClient.js'
import { ChannelOutput, ChannelOutputContext } from './ChannelOutput.js'

type NfircoOutputConfig = CodexioConfig['channelo']['nfirco']

@injectable()
export class NfircoThreadOutput implements ChannelOutput {
  readonly type = 'nfirco'
  private config?: NfircoOutputConfig

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager
  ) {}

  async start(): Promise<boolean> {
    this.config = await this.configer.get('channelo.nfirco')
    if (!this.config?.enabled) {
      return false
    }
    Logger.info('nfirco thread output ready')
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (context?.inputType === 'nfirco' && message.role === 'user') {
      return Result.successVoid()
    }
    if (!this.config?.enabled) {
      return Result.successVoid()
    }
    const text = message.text.trim()
    if (text.length === 0) {
      return Result.fail('text is required')
    }
    const threadUuid = this.findThreadUuid(message.ioThreadId)
    if (!threadUuid) {
      return Result.fail('nfirco thread uuid not found')
    }
    const result = await createNfircoThreadMessage(
      normalizeNfircoThreadCredentials(this.config),
      threadUuid,
      text,
      `${message.ioThreadId}:${message.role}:${randomUUID()}`
    )
    if (result.isFailed) {
      return Result.fail(result.message)
    }
    Logger.info('nfirco thread message sent', {
      role: message.role,
      ioThreadId: message.ioThreadId,
      threadUuid
    })
    return Result.successVoid()
  }

  async stop(): Promise<Result<void>> {
    Logger.info('nfirco thread output stopped')
    this.config = undefined
    return Result.successVoid()
  }

  private findThreadUuid(ioThreadId: string): string | undefined {
    const threads = this.ioThreadIdManager.getPlatformThreadId(ioThreadId)
    return threads.find((thread) => thread.source === 'nfirco')?.id
  }
}
