import { inject, injectable } from 'inversify'
import { WebSocket } from 'ws'
import { Configer } from '../../component/Configer.js'
import { Logger } from '../../component/Logger.js'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Result } from '../../value/Result.js'
import { isNfircoThreadMessageEvent, normalizeNfircoThreadCredentials, openNfircoThreadSocket, parseNfircoThreadSocketEvent } from '../../component/channel/NfircoThreadClient.js'
import { ChannelInput, ChannelInputReceiver } from './ChannelInput.js'

type NfircoThreadInputConfig = CodexioConfig['channeli']['nfircoThread']

@injectable()
export class NfircoThreadInput implements ChannelInput {
  readonly type = 'nfircoThread'
  private socket?: WebSocket
  private receiver?: ChannelInputReceiver
  private config?: NfircoThreadInputConfig
  private handledEventIds = new Set<string>()

  constructor(@inject(Configer) private readonly configer: Configer) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    this.config = await this.configer.get('channeli.nfircoThread')
    if (!this.config?.enabled) {
      return false
    }
    this.receiver = receiver
    this.handledEventIds.clear()
    const credentials = normalizeNfircoThreadCredentials(this.config)
    const categoryUuid = this.config.categoryUuid.trim()
    await new Promise<void>((resolve, reject) => {
      const socket = openNfircoThreadSocket(credentials)
      this.socket = socket
      socket.once('open', () => {
        socket.send(JSON.stringify({
          type: 'thread.category.subscribe',
          categoryUuid
        }))
        Logger.info('nfirco thread input connected', {
          categoryUuid
        })
        resolve()
      })
      socket.once('error', reject)
      socket.on('message', (data) => {
        void this.receive(data.toString()).catch((error) => {
          Logger.warn('nfirco thread message receive crashed', {
            message: error instanceof Error ? error.message : String(error)
          })
        })
      })
      socket.on('close', (code, reason) => {
        Logger.warn('nfirco thread input closed', {
          code,
          reason: reason.toString()
        })
      })
    })
    return true
  }

  async stop(): Promise<Result<void>> {
    Logger.info('nfirco thread input stopping')
    this.socket?.close()
    this.socket = undefined
    this.receiver = undefined
    this.config = undefined
    this.handledEventIds.clear()
    return Result.successVoid()
  }

  private async receive(payload: string): Promise<void> {
    const event = parseNfircoThreadSocketEvent(JSON.parse(payload))
    if (!isNfircoThreadMessageEvent(event)) {
      return
    }
    if (this.handledEventIds.has(event.eventId)) {
      return
    }
    this.handledEventIds.add(event.eventId)
    const receiver = this.receiver
    if (!receiver) {
      return
    }
    const result = await receiver.receive('nfircoThread', {
      platformThreadIds: [
        {
          source: 'nfircoThread',
          id: event.threadUuid
        }
      ],
      text: event.text
    })
    if (result.isFailed) {
      Logger.warn('nfirco thread message receive failed', {
        message: result.message
      })
    }
  }
}
