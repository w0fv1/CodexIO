import { inject, injectable } from 'inversify'
import { WebChannelHub } from '../channel/WebChannelHub.js'
import { Configer } from '../Configer.js'
import { Logger } from '../Logger.js'
import { Message } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { ChannelOutput } from './ChannelOutput.js'
import { IoThreadIdManager } from '../IoThreadIdManager.js'

@injectable()
export class WebChannelOutput implements ChannelOutput {
  readonly type = 'web'

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(WebChannelHub) private readonly hub: WebChannelHub,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager
  ) {}

  async start(): Promise<boolean> {
    const webConfig = await this.configer.get('channelo.web')
    if (!webConfig?.enabled) {
      return false
    }
    const host = await this.configer.get('server.host')
    const port = await this.configer.get('server.port')
    Logger.info('web channel ready', {
      host,
      port,
      url: `http://${host}:${port}`
    })
    return true
  }

  async send(message: Message): Promise<Result<void>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const webThreadId = this.ioThreadIdManager.getPlatformThreadId(message.ioThreadId)
      .find((item) => item.source === 'web')
    return this.hub.send(message, webThreadId?.id)
  }

  async stop(): Promise<Result<void>> {
    return Result.successVoid()
  }
}
