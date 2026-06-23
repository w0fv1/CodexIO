import { Server as HttpServer, IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { inject, injectable } from 'inversify'
import { Message, MessageFile } from '../value/Message.js'
import { Channel, ChannelReceiveResult } from './Channel.js'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../component/Markdown.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { FileStore } from '../component/FileStore.js'
import { allIoThreadId } from '../value/Message.js'
import { ChannelReceiveId } from '../ComponentIdentifier.js'
import { Configer } from '../component/Configer.js'

const WebSocketInputSchema = z.object({
  ioThreadId: z.string().optional(),
  text: z.string().default(''),
  files: z.array(z.string()).default([])
})

type WebSocketMessageOutput = {
  event: 'message'
  role: Message['role']
  ioThreadId: string
  allIoThreadId: string
  text: string
  createdAt: number
  html?: string
  files?: MessageFile[]
}

@injectable()
export class WebChannel implements Channel {
  readonly type = 'web'
  private readonly sockets = new Set<WebSocket>()
  private readonly server = new WebSocketServer({
    noServer: true
  })
  private attached?: HttpServer
  private stopped = false
  private connectionBound = false

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(ChannelReceiveId) private readonly receive: (message: Message) => Promise<Result<ChannelReceiveResult>>
  ) {}

  async start(): Promise<void> {
    const webConfig = await this.configer.get('channels.web')
    if (!webConfig?.enabled) {
      return
    }
    if (this.connectionBound) {
      return
    }
    this.connectionBound = true
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      Logger.info('web socket connected', {
        count: this.sockets.size
      })
      socket.send(JSON.stringify({
        event: 'ready'
      }))
      socket.on('message', async (data) => {
        const raw = data.toString()
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {
        }
        const parsed = WebSocketInputSchema.safeParse(body)
        if (!parsed.success) {
          Logger.warn('web socket input invalid')
          socket.send(JSON.stringify({
            event: 'error',
            message: 'text or file is required'
          }))
          return
        }
        const text = parsed.data.text
        const ioThreadId = parsed.data.ioThreadId ?? randomUUID()
        let files: MessageFile[] = []
        try {
          files = this.fileStore.resolveMany(parsed.data.files)
        } catch (error) {
          const result = Result.fromError(error)
          Logger.warn('web socket file resolve failed', {
            message: result.message
          })
          socket.send(JSON.stringify({
            event: 'error',
            message: result.message
          }))
          return
        }
        Logger.info('web message received', {
          ioThreadId,
          length: text.length,
          files: files.length
        })
        const result = await this.receive({
          role: 'user',
          ioThreadId,
          text,
          createdAt: Date.now(),
          source: this.type,
          files
        })
        if (result.isFailed) {
          Logger.warn('web message receive failed', {
            message: result.message
          })
          socket.send(JSON.stringify({
            event: 'error',
            message: result.message
          }))
        }
      })
      socket.on('close', () => {
        this.sockets.delete(socket)
        Logger.info('web socket closed', {
          count: this.sockets.size
        })
      })
    })
    const host = await this.configer.get('server.host')
    const port = await this.configer.get('server.port')
    Logger.info('web channel ready', {
      host,
      port,
      url: `http://${host}:${port}`
    })
  }

  attach(server: HttpServer): void {
    if (this.attached === server) {
      return
    }
    this.attached = server
    server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head))
    server.once('close', () => {
      void this.stop()
    })
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws') {
        Logger.warn('web socket upgrade rejected', {
          path: url.pathname
        })
        socket.destroy()
        return
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.server.emit('connection', webSocket, request)
      })
    } catch (error) {
      Logger.error('web socket upgrade failed', error)
      socket.destroy(error instanceof Error ? error : undefined)
    }
  }

  async send(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    if (message.role === 'system' && message.text === 'clear') {
      for (const socket of this.sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            event: 'clear',
            ioThreadId: message.ioThreadId,
            allIoThreadId
          }))
        }
      }
      return Result.success(null)
    }
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        const data: WebSocketMessageOutput = {
          event: 'message',
          role: message.role,
          ioThreadId: message.ioThreadId,
          allIoThreadId,
          text: message.text,
          createdAt: message.createdAt
        }
        if (message.files && message.files.length > 0) {
          data.files = message.files
        }
        if (message.role !== 'user' && shouldRenderMarkdown(message.text)) {
          data.html = renderMarkdownHtml(message.text)
        }
        socket.send(JSON.stringify(data))
      }
    }
    return Result.success(null)
  }

  async stop(): Promise<Result<null>> {
    Logger.info('web channel stopping', {
      sockets: this.sockets.size
    })
    for (const socket of this.sockets) {
      socket.close()
    }
    this.sockets.clear()
    if (!this.stopped) {
      this.stopped = true
      this.server.close()
      this.connectionBound = false
    }
    return Result.success(null)
  }

}
