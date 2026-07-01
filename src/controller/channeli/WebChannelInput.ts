import { inject, injectable } from 'inversify'
import { Configer } from '../../component/Configer.js'
import { WebChannelHub } from '../../component/channel/WebChannelHub.js'
import { Result } from '../../value/Result.js'
import { ChannelInput, ChannelInputReceiver } from './ChannelInput.js'

@injectable()
export class WebChannelInput implements ChannelInput {
  readonly type = 'web'

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(WebChannelHub) private readonly hub: WebChannelHub
  ) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    const webConfig = await this.configer.get('channeli.web')
    if (!webConfig?.enabled) {
      return false
    }
    this.hub.startInput(receiver)
    return true
  }

  async stop(): Promise<Result<void>> {
    return this.hub.stopInput()
  }
}
