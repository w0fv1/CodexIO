import { Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { ChannelAdapter, ChannelStartInput } from './ChannelAdapter.js'
import { webPageHtml } from './WebPage.js'
import { Result } from '../Result.js'

export class WebChannelAdapter implements ChannelAdapter {
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
    input.app.get('/', (_request, response) => {
      response.type('html').send(webPageHtml)
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      const history = input.history()
      setImmediate(() => {
        if (socket.readyState !== WebSocket.OPEN) {
          return
        }
        for (const message of history) {
          socket.send(JSON.stringify({
            type: message.role,
            text: message.text,
            createdAt: message.createdAt
          }))
        }
      })
      socket.on('message', async (data) => {
        let body: unknown = data.toString()
        try {
          body = JSON.parse(data.toString()) as unknown
        } catch {
          body = data.toString()
        }
        let text: string | undefined
        if (typeof body === 'string') {
          text = body
        }
        if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).text === 'string') {
          text = (body as Record<string, string>).text
        }
        if (!text || text.trim().length === 0) {
          socket.send(JSON.stringify({
            type: 'error',
            message: 'text is required'
          }))
          return
        }
        const received = await this.receive(text)
        if (received.isFailed) {
          socket.send(JSON.stringify({
            type: 'error',
            message: received.message
          }))
          return
        }
        if (!this.input) {
          socket.send(JSON.stringify({
            type: 'error',
            message: 'web channel not started'
          }))
          return
        }
        const result = await this.input.receive(text)
        if (result.data?.action === 'clear') {
          for (const target of this.sockets) {
            if (target.readyState === WebSocket.OPEN) {
              target.send(JSON.stringify({
                type: 'clear'
              }))
            }
          }
          return
        }
        if (result.isFailed) {
          socket.send(JSON.stringify({
            type: 'error',
            message: result.message
          }))
        }
      })
      socket.on('close', () => {
        this.sockets.delete(socket)
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
          socket.destroy()
          return
        }
        this.server.handleUpgrade(request, socket, head, (webSocket) => {
          this.server.emit('connection', webSocket, request)
        })
      } catch (error) {
        socket.destroy(error instanceof Error ? error : undefined)
      }
    })
    server.once('close', () => {
      void this.stop()
    })
  }

  async receive(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    return Result.success(null)
  }

  async send(text: string): Promise<Result<null>> {
    if (text.trim().length === 0) {
      return Result.fail('text is required')
    }
    const createdAt = Date.now()
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'agent',
          text,
          createdAt
        }))
      }
    }
    return Result.success(null)
  }

  async stop(): Promise<Result<null>> {
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
}
