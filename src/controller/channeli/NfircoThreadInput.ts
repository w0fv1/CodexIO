import { inject, injectable } from 'inversify'
import { WebSocket } from 'ws'
import { Configer } from '../../component/Configer.js'
import { Logger } from '../../component/Logger.js'
import { FileStore } from '../../component/FileStore.js'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { MessageFile } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { isNfircoThreadInputEvent, normalizeNfircoThreadCredentials, openNfircoThreadSocket, parseNfircoThreadSocketEvent } from '../../component/channel/NfircoThreadClient.js'
import { ChannelInput, ChannelInputReceiver } from './ChannelInput.js'

type NfircoInputConfig = CodexioConfig['channeli']['nfirco']

@injectable()
export class NfircoThreadInput implements ChannelInput {
  readonly type = 'nfirco'
  private socket?: WebSocket
  private receiver?: ChannelInputReceiver
  private config?: NfircoInputConfig
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private stopped = true
  private reconnectDelayMs = 1000
  private heartbeatIntervalMs = 15000
  private receiveQueue = Promise.resolve()
  private selfAccessId?: string

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore
  ) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    this.config = await this.configer.get('channeli.nfirco')
    if (!this.config?.enabled) {
      return false
    }
    this.receiver = receiver
    this.stopped = false
    await this.connect().catch((error) => {
      Logger.warn('nfirco thread initial connect failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      this.scheduleReconnect()
    })
    return true
  }

  async stop(): Promise<Result<void>> {
    Logger.info('nfirco thread input stopping')
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.socket?.close()
    this.socket = undefined
    this.receiver = undefined
    this.config = undefined
    this.selfAccessId = undefined
    this.receiveQueue = Promise.resolve()
    return Result.successVoid()
  }

  private async connect(): Promise<void> {
    const config = this.config
    if (!config?.enabled || this.stopped) {
      return
    }
    const credentials = normalizeNfircoThreadCredentials(config)
    const section = config.section.trim()
    this.selfAccessId = undefined
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let pongReceived = true
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined
      const socket = openNfircoThreadSocket(credentials)
      this.socket = socket
      socket.once('open', () => {
        heartbeatTimer = setInterval(() => {
          if (!pongReceived) {
            Logger.warn('nfirco thread input heartbeat timed out', {
              section
            })
            socket.terminate()
            return
          }
          pongReceived = false
          socket.ping()
        }, this.heartbeatIntervalMs)
        socket.send(JSON.stringify({
          type: 'thread.section.subscribe',
          section
        }))
      })
      socket.on('pong', () => {
        pongReceived = true
      })
      socket.once('error', (error) => {
        Logger.warn('nfirco thread input error', {
          message: error.message
        })
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      socket.on('message', (data) => {
        try {
          const payload = data.toString()
          const event = parseNfircoThreadSocketEvent(JSON.parse(payload))
          if (event?.type === 'ready') {
            const accessId = typeof event.accessId === 'string' ? event.accessId.trim() : ''
            if (accessId.length === 0) {
              const error = new Error('nfirco thread ready accessId missing')
              if (!settled) {
                settled = true
                reject(error)
              }
              socket.close()
              return
            }
            this.selfAccessId = accessId
            Logger.info('nfirco thread identity ready', {
              accessId
            })
            return
          }
          if (!settled && event?.type === 'thread.section.subscribed') {
            if (!this.selfAccessId) {
              settled = true
              reject(new Error('nfirco thread subscribed before identity ready'))
              socket.close()
              return
            }
            settled = true
            Logger.info('nfirco thread input connected', {
              section
            })
            resolve()
            return
          }
          const selfAccessId = this.selfAccessId
          if (!selfAccessId) {
            return
          }
          this.receiveQueue = this.receiveQueue.then(() => this.receiveEvent(event, selfAccessId)).catch((error) => {
            Logger.warn('nfirco thread message receive crashed', {
              message: error instanceof Error ? error.message : String(error)
            })
          })
        } catch (error) {
          Logger.warn('nfirco thread message receive crashed', {
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      socket.on('close', (code, reason) => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = undefined
        }
        Logger.warn('nfirco thread input closed', {
          code,
          reason: reason.toString()
        })
        if (!settled) {
          settled = true
          reject(new Error(`nfirco thread input closed before subscribed: ${code}`))
        }
        if (this.socket === socket) {
          this.socket = undefined
          this.scheduleReconnect()
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.config?.enabled || this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch((error) => {
        Logger.warn('nfirco thread reconnect failed', {
          message: error instanceof Error ? error.message : String(error)
        })
        this.scheduleReconnect()
      })
    }, this.reconnectDelayMs)
  }

  private async receiveEvent(event: ReturnType<typeof parseNfircoThreadSocketEvent>, selfAccessId: string): Promise<void> {
    if (!isNfircoThreadInputEvent(event)) {
      return
    }
    if (event.authorAccessId?.trim() === selfAccessId) {
      Logger.info('nfirco thread self event ignored', {
        type: event.type,
        threadUuid: event.threadUuid,
        authorAccessId: event.authorAccessId,
        selfAccessId
      })
      return
    }
    const receiver = this.receiver
    if (!receiver) {
      return
    }
    const files: MessageFile[] = []
    for (const attachment of [...event.files, ...event.images]) {
      try {
        const response = await fetch(attachment.url)
        if (!response.ok) {
          Logger.warn('nfirco thread file download failed', {
            url: attachment.url,
            status: response.status
          })
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        const file = await this.fileStore.importBuffer({
          buffer,
          name: attachment.name,
          mime: attachment.mime
        })
        files.push(file)
      } catch (error) {
        Logger.warn('nfirco thread file import failed', {
          url: attachment.url,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const result = await receiver.receive('nfirco', {
      channelThreadId: {
        source: 'nfirco',
        id: event.threadUuid
      },
      threadName: event.title,
      sourceMessageId: event.eventId,
      text: event.text,
      files
    })
    if (result.isFailed) {
      Logger.warn('nfirco thread message receive failed', {
        message: result.message
      })
    }
  }

}
