import { randomUUID } from 'node:crypto'
import { Server as HttpServer, IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { inject, injectable } from 'inversify'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { FileStore } from '../FileStore.js'
import { Logger } from '../Logger.js'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../../util/Markdown.js'
import { Message, MessageFile } from '../../value/Message.js'
import { Result } from '../../value/Result.js'
import { ChannelInputReceiver } from '../../controller/channeli/ChannelInput.js'

const WebSocketInputSchema = z.object({
  webThreadId: z.string().min(1),
  text: z.string().default(''),
  files: z.array(z.string()).default([])
})

type WebSocketMessageOutput = {
  event: 'message'
  id: string
  role: Message['role']
  ioThreadId: string
  webThreadId?: string
  text: string
  createdAt: number
  html?: string
  files?: MessageFile[]
}

type WebThread = {
  id: string
  title: string
  messages: WebSocketMessageOutput[]
  updatedAt: number
}

@injectable()
export class WebChannelHub {
  private readonly sockets = new Set<WebSocket>()
  private readonly threads = new Map<string, WebThread>()
  private readonly server = new WebSocketServer({
    noServer: true
  })
  private attached?: HttpServer
  private receiver?: ChannelInputReceiver
  private inputStarted = false
  private stopped = false

  constructor(
    @inject(FileStore) private readonly fileStore: FileStore
  ) {
    this.server.on('connection', (socket) => this.connect(socket))
  }

  startInput(receiver: ChannelInputReceiver): void {
    this.receiver = receiver
    this.inputStarted = true
    this.stopped = false
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

  stopInput(): Result<void> {
    this.receiver = undefined
    this.inputStarted = false
    for (const socket of this.sockets) {
      socket.close()
    }
    this.sockets.clear()
    return Result.successVoid()
  }

  stop(): Result<void> {
    if (this.stopped) {
      return Result.successVoid()
    }
    this.stopped = true
    Logger.info('web channel stopping', {
      sockets: this.sockets.size
    })
    this.stopInput()
    this.server.close()
    return Result.successVoid()
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws' || !this.inputStarted) {
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

  private connect(socket: WebSocket): void {
    this.sockets.add(socket)
    Logger.info('web socket connected', {
      count: this.sockets.size
    })
    socket.send(JSON.stringify({
      event: 'ready'
    }))
    for (const message of this.historyMessages()) {
      socket.send(JSON.stringify(message))
    }
    socket.on('message', async (data) => {
      if (!this.inputStarted) {
        socket.send(JSON.stringify({
          event: 'error',
          message: 'web channel is disabled'
        }))
        return
      }
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
      const webThreadId = parsed.data.webThreadId.trim()
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
        webThreadId,
        length: text.length,
        files: files.length
      })
      const receiver = this.receiver
      if (!receiver) {
        socket.send(JSON.stringify({
          event: 'error',
          message: 'web channel is disabled'
        }))
        return
      }
      const result = await receiver.receive('web', {
        platformThreadIds: [
          {
            source: 'web',
            id: webThreadId
          }
        ],
        text,
        files
      })
      if (result.isFailed) {
        Logger.warn('web message receive failed', {
          message: result.message
        })
        socket.send(JSON.stringify({
          event: 'error',
          webThreadId,
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
  }

  send(message: Message, webThreadId?: string): Result<void> {
    const data = this.toWebSocketMessage(message, webThreadId)
    this.save(data)
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data))
      }
    }
    return Result.successVoid()
  }

  private toWebSocketMessage(message: Message, webThreadId?: string): WebSocketMessageOutput {
    const data: WebSocketMessageOutput = {
      event: 'message',
      id: randomUUID(),
      role: message.role,
      ioThreadId: message.ioThreadId,
      webThreadId,
      text: message.text,
      createdAt: Date.now()
    }
    if (message.files && message.files.length > 0) {
      data.files = message.files
    }
    if (message.role !== 'user' && shouldRenderMarkdown(message.text)) {
      data.html = renderMarkdownHtml(message.text)
    }
    return data
  }

  private save(message: WebSocketMessageOutput): void {
    const threadId = (message.webThreadId ?? message.ioThreadId).trim()
    if (threadId.length === 0) {
      return
    }
    const thread = this.ensureThread(threadId)
    thread.messages.push(message)
    thread.updatedAt = message.createdAt
    if (!thread.title && message.role === 'user' && message.text.trim().length > 0) {
      thread.title = message.text.trim().slice(0, 40)
    }
  }

  private ensureThread(ioThreadId: string): WebThread {
    const existing = this.threads.get(ioThreadId)
    if (existing) {
      return existing
    }
    const thread: WebThread = {
      id: ioThreadId,
      title: '',
      messages: [],
      updatedAt: Date.now()
    }
    this.threads.set(ioThreadId, thread)
    return thread
  }

  private historyMessages(): WebSocketMessageOutput[] {
    return [...this.threads.values()]
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .flatMap((thread) => [...thread.messages].sort((left, right) => left.createdAt - right.createdAt))
  }
}
