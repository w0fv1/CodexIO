import { pid } from 'node:process'
import { Server as HttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { z } from 'zod'
import { inject, injectable } from 'inversify'
import { ChannelOutputManager } from '../component/channelo/ChannelOutputManager.js'
import { Logger } from '../component/Logger.js'
import { FileStore } from '../component/FileStore.js'
import { configDescriptor } from '../value/ConfigDefinition.js'
import { Configer } from '../component/Configer.js'
import { configPageHtml } from './ConfigPage.js'
import { Result } from '../value/Result.js'
import { webPageHtml } from './channeli/WebPage.js'
import { WebChannelHub } from '../component/channel/WebChannelHub.js'
import { resolveAvailableServerPort } from '../util/Network.js'
import { EventBus } from '../component/EventBus.js'
import { AppEvent } from '../value/Event.js'
import { CodexioMetadata } from '../component/CodexioMetadata.js'

const FileParamsSchema = z.object({
  id: z.string().min(1)
})

const ConfigPatchBodySchema = z.object({
  patch: z.record(z.string(), z.unknown())
})

const ConfigImportBodySchema = z.object({
  text: z.string().min(1)
})

type ListenError = NodeJS.ErrnoException & {
  address?: unknown
  port?: unknown
}

@injectable()
export class CodexioApiController {
  private readonly web = express()
  private bound = false
  private listener?: HttpServer
  private closing = false
  private readonly upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024
    }
  })

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(FileStore) private readonly fileStore: FileStore,
    @inject(WebChannelHub) private readonly webChannel: WebChannelHub,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata
  ) {
  }

  async start(): Promise<HttpServer> {
    const host = await this.configer.get('server.host')
    const configuredPort = await this.configer.get('server.port')
    const port = await this.configer.get('server.autoPort')
      ? await resolveAvailableServerPort(host, configuredPort)
      : configuredPort
    if (port !== configuredPort) {
      Logger.warn('configured port is in use', {
        configuredPort,
        port
      })
      await this.configer.set('server.port', port)
    }
    const listener = this.listen(port, host)
    await this.waitForListening(listener)
    Logger.info('codexio server listening', {
      host,
      port
    })
    return listener
  }

  listen(port?: number, host?: string): HttpServer {
    this.bind()
    let listener: HttpServer
    if (port !== undefined && host) {
      listener = this.web.listen(port, host)
    } else if (port !== undefined) {
      listener = this.web.listen(port)
    } else {
      listener = this.web.listen()
    }
    this.listener = listener
    this.closing = false
    this.webChannel.attach(listener)
    listener.once('close', () => {
      if (this.listener === listener) {
        this.listener = undefined
      }
    })
    return listener
  }

  async stop(): Promise<Result<void>> {
    if (this.closing) {
      return Result.successVoid()
    }
    this.closing = true
    if (!this.listener) {
      return Result.successVoid()
    }
    const listener = this.listener
    if (!listener.listening) {
      this.listener = undefined
      this.webChannel.stop()
      return Result.successVoid()
    }
    try {
      this.webChannel.stop()
      await new Promise<void>((resolveStop, reject) => {
        listener.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolveStop()
        })
      })
      return Result.successVoid()
    } catch (error) {
      return Result.fromError(error)
    }
  }

  bind(): void {
    if (this.bound) {
      return
    }
    this.bound = true
    this.web.use(cors())
    this.web.use(express.json({
      limit: '1mb'
    }))

    this.web.get('/', (_request, response) => {
      response.type('html').send(webPageHtml)
    })

    this.web.get('/icon.png', async (_request, response) => {
      try {
        response.type('png').send(await readFile(join(this.metadata.rootPath, 'assets', 'icon.png')))
      } catch (error) {
        Logger.error('api icon read failed', error)
        response.status(404).end()
      }
    })

    this.web.post('/api/files', this.upload.single('file'), async (request, response) => {
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
        Logger.error('api file upload failed', error)
        response.json(Result.fromError(error))
      }
    })

    this.web.get('/api/files/:id', async (request, response) => {
      try {
        const params = FileParamsSchema.safeParse(request.params)
        if (!params.success) {
          response.status(404).json(Result.fail('file not found'))
          return
        }
        const file = this.fileStore.resolve(params.data.id)
        response.type(file.mime).send(await this.fileStore.read(file.id))
      } catch (error) {
        Logger.warn('api file read failed', {
          id: request.params.id,
          message: error instanceof Error ? error.message : String(error)
        })
        response.status(404).json(Result.fail('file not found'))
      }
    })

    this.web.post('/api/server/stop', async (request, response) => {
      try {
        if (!await this.authorize(request)) {
          Logger.warn('api server stop unauthorized')
          response.status(401).json(Result.fail('unauthorized', '401'))
          return
        }
        Logger.info('api server stop requested', {
          pid
        })
        response.json(Result.success({
          stopping: true,
          pid
        }))
        setImmediate(() => {
          this.eventBus.emit(AppEvent.StopRequested)
        })
      } catch (error) {
        Logger.error('api server stop failed', error)
        response.json(Result.fromError(error))
      }
    })

    this.web.get('/config', (_request, response) => {
      response.type('html').send(configPageHtml)
    })

    this.web.get('/api/config', async (_request, response) => {
      try {
        response.json(Result.success({
          config: {
            app: await this.configer.get('app'),
            server: await this.configer.get('server'),
            agents: await this.configer.get('agents'),
            proxy: await this.configer.get('proxy'),
            channeli: await this.configer.get('channeli'),
            channelo: await this.configer.get('channelo')
          },
          descriptor: configDescriptor
        }))
      } catch (error) {
        Logger.error('api config read failed', error)
        response.json(Result.fromError(error))
      }
    })

    this.web.get('/api/config/export', async (_request, response) => {
      try {
        response
          .type('yaml')
          .setHeader('Content-Disposition', 'attachment; filename="codexio-config.yaml"')
          .send(await this.configer.exportText())
      } catch (error) {
        Logger.error('api config export failed', error)
        response.status(500).json(Result.fromError(error))
      }
    })

    this.web.post('/api/config/import', async (request, response) => {
      try {
        const body = ConfigImportBodySchema.safeParse(request.body)
        if (!body.success) {
          response.json(Result.fail('config text is required'))
          return
        }
        const change = await this.configer.importText(body.data.text)
        const message = formatConfigSavedMessage(change.paths)
        response.json(Result.success({
          changedPaths: change.paths,
          message
        }))
        await this.outputManager.sendSystem(message)
      } catch (error) {
        Logger.error('api config import failed', error)
        response.json(Result.fromError(error))
      }
    })

    this.web.patch('/api/config', async (request, response) => {
      try {
        const body = ConfigPatchBodySchema.safeParse(request.body)
        if (!body.success) {
          response.json(Result.fail('config patch is required'))
          return
        }
        const change = await this.configer.patch(body.data.patch)
        const message = formatConfigSavedMessage(change.paths)
        response.json(Result.success({
          changedPaths: change.paths,
          message
        }))
        await this.outputManager.sendSystem(message)
      } catch (error) {
        Logger.error('api config patch failed', error)
        response.json(Result.fromError(error))
      }
    })

    this.web.get('/api/status', (_request, response) => {
      response.json(Result.success({
        pid
      }))
    })

    this.web.get('/version', (_request, response) => {
      response.json(Result.success({
        name: 'codexio',
        version: this.metadata.readVersion(),
        pid
      }))
    })
  }

  private waitForListening(listener: HttpServer): Promise<void> {
    return new Promise((resolveListening, reject) => {
      listener.once('listening', resolveListening)
      listener.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          const listenError = error as ListenError
          const detail = [
            typeof listenError.address === 'string' ? listenError.address : undefined,
            typeof listenError.port === 'number' ? String(listenError.port) : undefined
          ].filter(Boolean).join(':')
          reject(new Error(`server port is already in use${detail ? `: ${detail}` : ''}`))
          return
        }
        reject(error)
      })
    })
  }

  private async authorize(request: express.Request): Promise<boolean> {
    const authorization = request.header('authorization')
    return authorization === `Bearer ${await this.configer.get('server.token')}`
  }
}

function formatConfigSavedMessage(paths: string[]): string {
  if (paths.length === 0) {
    return '配置已保存，没有检测到有效变更。'
  }
  return [
    '配置已保存。',
    `已变更：${paths.join(', ')}`
  ].join('\n')
}
