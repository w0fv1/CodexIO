import { Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { Channel, ChannelMessage, ChannelStartInput } from './Channel.js'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../component/Markdown.js'
import { webPageHtml } from './WebPage.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'

const WebSocketInputSchema = z.union([
  z.string(),
  z.object({
    text: z.string()
  })
])

type WebChannelMessage = {
  type: ChannelMessage['role']
  text: string
  createdAt: number
  html?: string
}

export class WebChannelAdapter implements Channel {
  readonly type = 'web'
  private readonly sockets = new Set<WebSocket>()
  private readonly server = new WebSocketServer({
    noServer: true
  })
  private input?: ChannelStartInput
  private attached?: HttpServer
  private stopped = false

  start(input: ChannelStartInput): void {
    this.input = input
    Logger.info('web channel ready')
    input.app.get('/', (_request, response) => {
      response.type('html').send(webPageHtml)
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      Logger.info('web socket connected', {
        count: this.sockets.size
      })
      socket.send(JSON.stringify({
        type: 'ready'
      }))
      const history = input.displayHistory()
      setImmediate(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return
        }
        for (const message of history) {
          socket.send(JSON.stringify(this.toWebMessage(message)))
        }
      })
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
            type: 'error',
            message: 'text is required'
          }))
          return
        }
        if (!this.input) {
          Logger.warn('web channel input missing')
          socket.send(JSON.stringify({
            type: 'error',
            message: 'web channel not started'
          }))
          return
        }
        const text = typeof parsed.data === 'string' ? parsed.data : parsed.data.text
        Logger.info('web message received', {
          length: text.length
        })
        const result = await this.input.receive(text)
        if (result.isFailed) {
          Logger.warn('web message receive failed', {
            message: result.message
          })
          socket.send(JSON.stringify({
            type: 'error',
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
  }

  attach(server: HttpServer): void {
    if (this.attached === server) {
      return
    }
    this.attached = server
    server.on('upgrade', (request, socket, head) => {
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
    })
    server.once('close', () => {
      void this.stop()
    })
  }

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (message.text.trim().length === 0) {
      return Result.fail('text is required')
    }
    if (message.role === 'system' && message.text === 'clear') {
      for (const socket of this.sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            type: 'clear'
          }))
        }
      }
      return Result.success(null)
    }
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          ...this.toWebMessage(message)
        }))
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
    }
    return Result.success(null)
  }

  private toWebMessage(message: ChannelMessage): WebChannelMessage {
    const data: WebChannelMessage = {
      type: message.role,
      text: message.text,
      createdAt: message.createdAt
    }
    if (message.role !== 'user' && shouldRenderMarkdown(message.text)) {
      data.html = renderMarkdownHtml(message.text)
    }
    return data
  }
}
