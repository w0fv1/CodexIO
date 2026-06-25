import { randomUUID } from 'node:crypto'
import { Server as HttpServer, IncomingMessage } from 'node:http'
import { Duplex } from 'node:stream'
import { inject, injectable } from 'inversify'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { FileStore } from '../component/FileStore.js'
import { Logger } from '../component/Logger.js'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../util/Markdown.js'
import { allIoThreadId, Message, MessageFile } from '../value/Message.js'
import { Thread } from '../value/Thread.js'
import { Result } from '../value/Result.js'
import { Configer } from '../component/Configer.js'
import { ThreadManager } from '../component/ThreadManager.js'
import { ThreadMessageStore } from '../component/ThreadMessageStore.js'
import { ChannelInput, ChannelInputReceive, ChannelOutput } from './Channel.js'

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

type WebSocketThreadListOutput = {
  event: 'threads'
  threads: Thread[]
}

type WebSocketThreadOutput = {
  event: 'thread'
  thread: Thread
}

type WebSocketThreadDeletedOutput = {
  event: 'threadDeleted'
  id: string
}

type WebSocketMessagesOutput = {
  event: 'messages'
  messages: WebSocketMessageOutput[]
}

@injectable()
export class WebChannelHub {
  private readonly sockets = new Set<WebSocket>()
  private readonly server = new WebSocketServer({
    noServer: true
  })
  private attached?: HttpServer
  private receive?: ChannelInputReceive
  private stopped = false

  constructor(
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(ThreadManager) private readonly threadManager: ThreadManager,
    @inject(ThreadMessageStore) private readonly messageStore: ThreadMessageStore
  ) {
    this.server.on('connection', (socket) => this.connect(socket))
    this.threadManager.subscribe((thread) => {
      this.broadcast({
        event: 'thread',
        thread
      })
    })
    this.threadManager.subscribeDelete((id) => {
      this.broadcast({
        event: 'threadDeleted',
        id
      })
    })
  }

  startInput(receive: ChannelInputReceive): void {
    this.receive = receive
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

  stopInput(): Result<null> {
    this.receive = undefined
    for (const socket of this.sockets) {
      socket.close()
    }
    this.sockets.clear()
    return Result.success(null)
  }

  stop(): Result<null> {
    if (this.stopped) {
      return Result.success(null)
    }
    this.stopped = true
    Logger.info('web channel stopping', {
      sockets: this.sockets.size
    })
    this.stopInput()
    this.server.close()
    return Result.success(null)
  }

  send(message: Message): Result<null> {
    if (message.role === 'system' && message.text === 'clear') {
      if (message.ioThreadId === allIoThreadId) {
        this.messageStore.clear()
      } else {
        this.messageStore.clear(message.ioThreadId)
      }
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
    this.messageStore.append(message)
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(this.toWebSocketMessage(message)))
      }
    }
    return Result.success(null)
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname !== '/ws' || !this.receive) {
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
    socket.send(JSON.stringify({
      event: 'threads',
      threads: this.threadManager.list()
    } satisfies WebSocketThreadListOutput))
    socket.send(JSON.stringify({
      event: 'messages',
      messages: this.messageStore.list().map((message) => this.toWebSocketMessage(message))
    } satisfies WebSocketMessagesOutput))
    socket.on('message', async (data) => {
      const receive = this.receive
      if (!receive) {
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
      const ioThreadId = parsed.data.ioThreadId ?? randomUUID()
      this.threadManager.ensure(ioThreadId)
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
      const result = await receive({
        role: 'user',
        ioThreadId,
        text,
        createdAt: Date.now(),
        source: 'web',
        files
      })
      if (result.isFailed) {
        Logger.warn('web message receive failed', {
          message: result.message
        })
        socket.send(JSON.stringify({
          event: 'error',
          ioThreadId,
          allIoThreadId,
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

  private broadcast(data: WebSocketThreadOutput | WebSocketThreadDeletedOutput): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data))
      }
    }
  }

  private toWebSocketMessage(message: Message): WebSocketMessageOutput {
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
    return data
  }
}

@injectable()
export class WebChannelInput implements ChannelInput {
  readonly type = 'web'

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(WebChannelHub) private readonly hub: WebChannelHub
  ) {}

  async start(receive: ChannelInputReceive): Promise<boolean> {
    const webConfig = await this.configer.get('channels.web')
    if (!webConfig?.enabled) {
      return false
    }
    this.hub.startInput(receive)
    return true
  }

  async stop(): Promise<Result<null>> {
    return this.hub.stopInput()
  }
}

@injectable()
export class WebChannelOutput implements ChannelOutput {
  readonly type = 'web'

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(WebChannelHub) private readonly hub: WebChannelHub
  ) {}

  async start(): Promise<boolean> {
    const webConfig = await this.configer.get('channels.web')
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

  async send(message: Message): Promise<Result<null>> {
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    return this.hub.send(message)
  }

  async stop(): Promise<Result<null>> {
    return Result.success(null)
  }
}
