import { Server as HttpServer } from 'node:http'
import express from 'express'
import multer from 'multer'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { CodexioConfig } from '../ConfigService.js'
import { Channel, ChannelFile, ChannelInput, ChannelMessage, ChannelReceiveResult } from './Channel.js'
import { renderMarkdownHtml, shouldRenderMarkdown } from '../component/Markdown.js'
import { webPageHtml } from './WebPage.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { FileStore } from '../component/FileStore.js'

const WebSocketInputSchema = z.union([
  z.string(),
  z.object({
    text: z.string().default(''),
    files: z.array(z.string()).default([])
  })
])

type WebChannelMessage = {
  type: ChannelMessage['role']
  text: string
  createdAt: number
  html?: string
  files?: ChannelFile[]
}

export class WebChannel implements Channel {
  readonly type = 'web'
  private readonly sockets = new Set<WebSocket>()
  private readonly server = new WebSocketServer({
    noServer: true
  })
  private listener?: HttpServer
  private attached?: HttpServer
  private stopped = false

  constructor(
    private readonly fileStore: FileStore,
    private readonly receive: (input: ChannelInput) => Promise<Result<ChannelReceiveResult>>
  ) {}

  start(config: CodexioConfig): void {
    const webConfig = config.channels.web
    if (!webConfig?.enabled) {
      return
    }
    const app = express()
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 20 * 1024 * 1024
      }
    })
    Logger.info('web channel ready')
    app.get('/', (_request, response) => {
      response.type('html').send(webPageHtml)
    })
    app.get('/config', (_request, response) => {
      response.redirect(`http://${config.server.host}:${config.server.port}/config`)
    })
    app.post('/api/files', upload.single('file'), async (request, response) => {
      try {
        if (!request.file) {
          response.json(Result.fail('file is required'))
          return
        }
        const file = await this.fileStore.importBuffer({
          buffer: request.file.buffer,
          name: request.file.originalname,
          mime: request.file.mimetype
        })
        response.json(Result.success({
          file
        }))
      } catch (error) {
        Logger.error('web file upload failed', error)
        response.json(Result.fromError(error))
      }
    })
    app.get('/api/files/:id', async (request, response) => {
      try {
        const id = String(request.params.id ?? '').trim()
        if (id.length === 0) {
          response.status(404).json(Result.fail('file not found'))
          return
        }
        const file = this.fileStore.resolve(id)
        response.type(file.mime).send(await this.fileStore.read(file.id))
      } catch (error) {
        Logger.warn('web file read failed', {
          id: request.params.id,
          message: error instanceof Error ? error.message : String(error)
        })
        response.status(404).json(Result.fail('file not found'))
      }
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      Logger.info('web socket connected', {
        count: this.sockets.size
      })
      socket.send(JSON.stringify({
        type: 'ready'
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
            type: 'error',
            message: 'text or file is required'
          }))
          return
        }
        const text = typeof parsed.data === 'string' ? parsed.data : parsed.data.text
        let files: ChannelFile[] = []
        try {
          files = typeof parsed.data === 'string' ? [] : this.fileStore.resolveMany(parsed.data.files)
        } catch (error) {
          const result = Result.fromError(error)
          Logger.warn('web socket file resolve failed', {
            message: result.message
          })
          socket.send(JSON.stringify({
            type: 'error',
            message: result.message
          }))
          return
        }
        Logger.info('web message received', {
          length: text.length,
          files: files.length
        })
        const result = await this.receive({
          text,
          files
        })
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
    this.listener = app.listen(webConfig.port, webConfig.host)
    this.attach(this.listener)
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
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
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
    await new Promise<void>((resolve, reject) => {
      if (!this.listener) {
        resolve()
        return
      }
      this.listener.close((error) => {
        this.listener = undefined
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    }).catch((error) => {
      Logger.warn('web channel listener stop failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
    return Result.success(null)
  }

  private toWebMessage(message: ChannelMessage): WebChannelMessage {
    const data: WebChannelMessage = {
      type: message.role,
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
