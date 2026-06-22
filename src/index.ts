#!/usr/bin/env node
import { Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { argv, pid, stdout as output } from 'node:process'
import { pathToFileURL } from 'node:url'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { Command } from 'commander'
import { z } from 'zod'
import { asFunction, asValue, createContainer } from 'awilix'
import { ChannelManager } from './channel/ChannelManager.js'
import { ChannelFile } from './channel/Channel.js'
import { AgentManager } from './agent/AgentManager.js'
import { CodexioConfig, ConfigSchema, configFieldDescriptors, validateCodexioConfig } from './config/ConfigDefinition.js'
import { Configer } from './config/Configer.js'
import { Result } from './value/Result.js'
import { readCodexioVersion } from './AppMetadata.js'
import { checkCodexioUpdate } from './component/UpdateChecker.js'
import { UpdateInstaller } from './component/UpdateInstaller.js'
import { FileStore } from './component/FileStore.js'
import { AgentFactory } from './agent/AgentManager.js'
import { CommandExecutor, UpdateHandler } from './controller/CommandExecutor.js'
import { Logger } from './component/Logger.js'
import { runSupervisor } from './component/Supervisor.js'
import { ApplicationLifecycle, SupervisorApplicationLifecycle } from './component/ApplicationLifecycle.js'
import { configPageHtml } from './config/ConfigPage.js'
import {
  removeRuntimeServerState,
  resolveAvailableServerPort,
  restartServer,
  stopServer,
  writeRuntimeServerState,
  isProcessAlive
} from './component/ServerLifecycle.js'

const AgentMessageBodySchema = z.object({
  text: z.string().default(''),
  files: z.array(z.object({
    path: z.string().min(1)
  })).default([])
}).refine((value) => value.text.trim().length > 0 || value.files.length > 0)

const WebSocketFileParamsSchema = z.object({
  id: z.string().min(1)
})

const ConfigPatchBodySchema = z.object({
  patch: z.record(z.string(), z.unknown())
})

const ConfigImportBodySchema = z.object({
  text: z.string().min(1)
})

export type CodexioServer = {
  app: express.Express
  channelManager: ChannelManager
  agentManager: AgentManager
  fileStore: FileStore
  listen: (port?: number, host?: string) => HttpServer
  stop: () => Promise<Result<null>>
}

export type CodexioAppOptions = {
  agentFactory?: AgentFactory
  configPath?: string
  configer?: Configer
  applicationLifecycle?: ApplicationLifecycle
}

export function createCodexioApp(config: CodexioConfig, options: CodexioAppOptions = {}): CodexioServer {
  validateCodexioConfig(config)
  const app = express()
  app.use(cors())
  app.use(express.json({
    limit: '1mb'
  }))
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024
    }
  })

  const configer = options.configer ?? new Configer(options.configPath)
  const updateHandler = options.configPath ? {
    update: async () => new UpdateInstaller(await configer.read(), configer.path).update()
  } : undefined
  const applicationLifecycle = options.applicationLifecycle ?? (options.configPath ? new SupervisorApplicationLifecycle(configer.path) : undefined)
  const container = createAppContainer({
    app,
    config,
    configer,
    agentFactory: options.agentFactory,
    applicationLifecycle,
    updateHandler
  })
  const channelManager = container.resolve('channelManager')
  const agentManager = container.resolve('agentManager')
  const fileStore = container.resolve('fileStore')
  bindConfigSubscribers(configer, channelManager, agentManager, applicationLifecycle)
  let activeListener: HttpServer | undefined

  app.post('/api/files', upload.single('file'), async (request, response) => {
    try {
      if (!request.file) {
        response.json(Result.fail('file is required'))
        return
      }
      const file = await fileStore.importBuffer({
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

  app.get('/api/files/:id', async (request, response) => {
    try {
      const params = WebSocketFileParamsSchema.safeParse(request.params)
      if (!params.success) {
        response.status(404).json(Result.fail('file not found'))
        return
      }
      const file = fileStore.resolve(params.data.id)
      response.type(file.mime).send(await fileStore.read(file.id))
    } catch (error) {
      Logger.warn('api file read failed', {
        id: request.params.id,
        message: error instanceof Error ? error.message : String(error)
      })
      response.status(404).json(Result.fail('file not found'))
    }
  })

  app.post('/api/message', async (request, response) => {
    try {
      const authorization = request.header('authorization')
      if (authorization !== `Bearer ${config.server.token}`) {
        Logger.warn('api message unauthorized')
        response.status(401).json(Result.fail('unauthorized', '401'))
        return
      }
      const body = AgentMessageBodySchema.safeParse(request.body)
      if (!body.success) {
        Logger.warn('api message invalid body')
        response.json(Result.fail('text or file is required'))
        return
      }
      const files: ChannelFile[] = []
      for (const file of body.data.files) {
        files.push(await fileStore.importPath(file.path))
      }
      Logger.info('api message received', {
        length: body.data.text.length,
        files: files.length
      })
      const sent = await channelManager.send({
        text: body.data.text,
        files
      })
      if (sent.isFailed) {
        response.json(sent)
        return
      }
      response.json(Result.success({
        sent: true,
        files
      }))
    } catch (error) {
      Logger.error('api message failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.post('/api/server/restart', async (request, response) => {
    try {
      const authorization = request.header('authorization')
      if (authorization !== `Bearer ${config.server.token}`) {
        Logger.warn('api server restart unauthorized')
        response.status(401).json(Result.fail('unauthorized', '401'))
        return
      }
      if (!applicationLifecycle) {
        response.json(Result.fail('Codexio supervisor 未运行，请用 start.cmd 启动后再重启。'))
        return
      }
      Logger.info('api server restart requested')
      response.json(await applicationLifecycle.restart())
    } catch (error) {
      Logger.error('api server restart failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.post('/api/server/stop', async (request, response) => {
    try {
      const authorization = request.header('authorization')
      if (authorization !== `Bearer ${config.server.token}`) {
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
        activeListener?.close((error) => {
          if (error) {
            Logger.error('server stop failed', error)
            process.exitCode = 1
          }
        })
      })
    } catch (error) {
      Logger.error('api server stop failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.get('/config', (_request, response) => {
    response.type('html').send(configPageHtml)
  })

  app.get('/api/config', async (_request, response) => {
    try {
      response.json(Result.success({
        config: await configer.read(),
        descriptor: configFieldDescriptors
      }))
    } catch (error) {
      Logger.error('api config read failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.get('/api/config/export', async (_request, response) => {
    try {
      response
        .type('yaml')
        .setHeader('Content-Disposition', 'attachment; filename="codexio-config.yaml"')
        .send(await configer.exportText())
    } catch (error) {
      Logger.error('api config export failed', error)
      response.status(500).json(Result.fromError(error))
    }
  })

  app.post('/api/config/import', async (request, response) => {
    try {
      const body = ConfigImportBodySchema.safeParse(request.body)
      if (!body.success) {
        response.json(Result.fail('config text is required'))
        return
      }
      const change = await configer.importText(body.data.text)
      const message = formatConfigSavedMessage(change.paths)
      response.json(Result.success({
        config: change.current,
        changedPaths: change.paths,
        message
      }))
      await channelManager.sendSystem(message)
    } catch (error) {
      Logger.error('api config import failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.patch('/api/config', async (request, response) => {
    try {
      const body = ConfigPatchBodySchema.safeParse(request.body)
      if (!body.success) {
        response.json(Result.fail('config patch is required'))
        return
      }
      const change = await configer.patch(body.data.patch)
      const message = formatConfigSavedMessage(change.paths)
      response.json(Result.success({
        config: change.current,
        changedPaths: change.paths,
        message
      }))
      await channelManager.sendSystem(message)
    } catch (error) {
      Logger.error('api config patch failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.get('/api/status', (_request, response) => {
    response.json(Result.success({
      ...agentManager.status(),
      pid
    }))
  })

  channelManager.start(config)

  return {
    app,
    channelManager,
    agentManager,
    fileStore,
    listen: (port?: number, host?: string) => {
      let listener: HttpServer
      if (port !== undefined && host) {
        listener = app.listen(port, host)
      } else if (port !== undefined) {
        listener = app.listen(port)
      } else {
        listener = app.listen()
      }
      activeListener = listener
      listener.once('listening', () => {
        void channelManager.sendSystem('Codexio server started.')
        void checkCodexioUpdate(config)
          .then(async (message) => {
            if (message) {
              await channelManager.sendSystem(message)
            }
          })
          .catch((error) => {
            Logger.error('update check failed', error)
          })
      })
      const close = listener.close.bind(listener)
      listener.close = ((callback?: (error?: Error) => void) => {
        void (async () => {
          await channelManager.sendSystem('Codexio server stopping.')
          const agentStopped = await agentManager.stop()
          const channelStopped = await channelManager.stop()
          close((error?: Error) => {
            if (error) {
              callback?.(error)
              return
            }
            if (agentStopped.isFailed) {
              callback?.(new Error(agentStopped.message))
              return
            }
            if (channelStopped.isFailed) {
              callback?.(new Error(channelStopped.message))
              return
            }
            callback?.()
          })
        })()
        return listener
      }) as typeof listener.close
      return listener
    },
    stop: async () => {
      const agentStopped = await agentManager.stop()
      const channelStopped = await channelManager.stop()
      if (agentStopped.isFailed) {
        return agentStopped
      }
      if (channelStopped.isFailed) {
        return channelStopped
      }
      return Result.success(null)
    }
  }
}

const program = new Command()

type ConfigOption = {
  config?: string
}

type ServeOptions = {
  autoPort?: boolean
}

type ServeCommandOption = ConfigOption & ServeOptions

type ListenError = NodeJS.ErrnoException & {
  address?: unknown
  port?: unknown
}

type AppCradle = {
  app: express.Express
  config: CodexioConfig
  configer: Configer
  agentFactory?: AgentFactory
  applicationLifecycle?: ApplicationLifecycle
  channelManager: ChannelManager
  agentManager: AgentManager
  fileStore: FileStore
  updateHandler?: UpdateHandler
  commandExecutor: CommandExecutor
}

function createAppContainer(input: {
  app: express.Express
  config: CodexioConfig
  configer: Configer
  agentFactory?: AgentFactory
  applicationLifecycle?: ApplicationLifecycle
  updateHandler?: UpdateHandler
}) {
  const container = createContainer<AppCradle>()
  container.register({
    app: asValue(input.app),
    config: asValue(input.config),
    configer: asValue(input.configer),
    agentFactory: asValue(input.agentFactory),
    applicationLifecycle: asValue(input.applicationLifecycle),
    fileStore: asFunction(() => new FileStore()).singleton(),
    channelManager: asFunction(({ config, fileStore }) => new ChannelManager(config, fileStore, async (input, source) => {
      const commandExecutor = container.resolve('commandExecutor')
      return commandExecutor.receive({
        text: input.text,
        source,
        files: input.files
      })
    })).singleton(),
    agentManager: asFunction(({ config, channelManager, agentFactory }) => new AgentManager(config, `http://${config.server.host}:${config.server.port}`, {
      send: async (text) => channelManager.send(text),
      system: async (text) => channelManager.sendSystem(text),
      status: async (text) => channelManager.status(text)
    }, {
      agentFactory
    })).singleton(),
    updateHandler: asValue(input.updateHandler),
    commandExecutor: asFunction(({ channelManager, agentManager, updateHandler, applicationLifecycle }) => new CommandExecutor(channelManager, agentManager, updateHandler, applicationLifecycle)).singleton()
  })
  return container
}

function getCommandOptions<T extends ConfigOption>(value: T | Command): T {
  const maybeCommand = value as {
    opts?: unknown
  }
  if (typeof maybeCommand.opts === 'function') {
    return (value as Command).opts<T>()
  }
  return value as T
}

function getConfigPath(value: Command | ConfigOption): string | undefined {
  return getCommandOptions<ConfigOption>(value).config
}

program
  .name('codexio')
  .description('Codexio text relay')
  .version(readCodexioVersion())
  .action(async () => {
    await runSupervisor()
  })

program
  .command('init')
  .option('--config <path>', 'config file path')
  .option('--force', 'overwrite existing config')
  .action(async (command: Command | (ConfigOption & { force?: boolean })) => {
    const options = getCommandOptions<ConfigOption & { force?: boolean }>(command)
    const configer = new Configer(options.config)
    const config = await configer.init(Boolean(options.force))
    output.write(`config: ${configer.path}\n`)
    output.write(`server: ${config.server.host}:${config.server.port}\n`)
  })

program
  .command('serve', {
    hidden: true
  })
  .option('--config <path>', 'config file path')
  .option('--auto-port', 'use next available server port')
  .action(async (command: Command | ServeCommandOption) => {
    const options = getCommandOptions<ServeCommandOption>(command)
    await serve(undefined, options.config, {
      autoPort: Boolean(options.autoPort)
    })
  })

program
  .command('start')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    await runSupervisor({
      configPath: getConfigPath(command)
    })
  })

program
  .command('stop')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    const stopped = await stopServer(getConfigPath(command))
    if (stopped) {
      output.write('codexio server stopped\n')
      return
    }
    output.write('codexio server not running\n')
  })

program
  .command('dev')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    await runSupervisor({
      configPath: getConfigPath(command),
      initConfig: true,
      autoPort: true,
      replaceRunning: true
    })
  })

program
  .command('login')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    const configer = new Configer(getConfigPath(command))
    const config = await configer.init(false)
    validateCodexioConfig(config)
    const toolBaseUrl = `http://${config.server.host}:${config.server.port}`
    const agentManager = new AgentManager(config, toolBaseUrl, {
      send: async (text) => {
        output.write(`${text}\n`)
        return Result.success(null)
      },
      status: async (text) => {
        output.write(`${text}\n`)
        return Result.success(null)
      }
    })
    await agentManager.login()
  })

program
  .command('restart')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    const state = await restartServer(getConfigPath(command))
    output.write(`codexio restart requested through supervisor ${state.host}:${state.port}\n`)
  })

program
  .command('update')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    const configer = new Configer(getConfigPath(command))
    const config = await configer.read()
    const result = await new UpdateInstaller(config, configer.path).update()
    if (result.isFailed) {
      throw new Error(result.message)
    }
    output.write(`${result.data ?? result.message}\n`)
  })

if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  void main()
}

async function main(): Promise<void> {
  try {
    await program.parseAsync()
  } catch (error) {
    Logger.error('codexio command failed', error)
    process.exitCode = 1
  }
}

async function serve(config?: CodexioConfig, configPath?: string, options: ServeOptions = {}): Promise<void> {
  const cleanedLogs = await Logger.cleanup(30)
  if (cleanedLogs.deleted > 0) {
    Logger.info('old log files cleaned', cleanedLogs)
  }
  const configer = new Configer(configPath)
  const resolvedConfig = config ?? await configer.read()
  const port = options.autoPort
    ? await resolveAvailableServerPort(resolvedConfig.server.host, resolvedConfig.server.port)
    : resolvedConfig.server.port
  const serverConfig = ConfigSchema.parse({
    ...resolvedConfig,
    server: {
      ...resolvedConfig.server,
      port
    }
  })
  const server = createCodexioApp(serverConfig, {
    configPath: configer.path
  })
  const listener = server.listen(serverConfig.server.port, serverConfig.server.host)
  try {
    await waitForListening(listener)
  } catch (error) {
    await server.stop()
    throw error
  }
  if (port !== resolvedConfig.server.port) {
    Logger.warn('configured port is in use', {
      configuredPort: resolvedConfig.server.port,
      port
    })
  }
  await writeRuntimeServerState(configer.path, {
    pid,
    host: serverConfig.server.host,
    port: serverConfig.server.port,
    startedAt: new Date().toISOString()
  })
  Logger.info('codexio server listening', {
    host: serverConfig.server.host,
    port: serverConfig.server.port,
    pid
  })
  output.write(`codexio listening on http://${serverConfig.server.host}:${serverConfig.server.port}\n`)
  let stopping = false
  let supervisorWatch: NodeJS.Timeout | undefined
  const stop = () => {
    if (stopping) {
      return
    }
    stopping = true
    if (supervisorWatch) {
      clearInterval(supervisorWatch)
      supervisorWatch = undefined
    }
    Logger.info('codexio server stopping', {
      pid
    })
    listener.close((error) => {
      void removeRuntimeServerState(configer.path)
        .finally(() => {
          if (error) {
            Logger.error('server close failed', error)
            process.exitCode = 1
          }
        })
    })
  }
  const supervisorPid = Number(process.env.CODEXIO_SUPERVISOR_PID)
  if (Number.isInteger(supervisorPid) && supervisorPid > 0) {
    supervisorWatch = setInterval(() => {
      if (isProcessAlive(supervisorPid)) {
        return
      }
      Logger.warn('codexio supervisor disappeared', {
        supervisorPid
      })
      stop()
    }, 1000)
    supervisorWatch.unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

function waitForListening(listener: HttpServer): Promise<void> {
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

function bindConfigSubscribers(configer: Configer, channelManager: ChannelManager, agentManager: AgentManager, applicationLifecycle?: ApplicationLifecycle): void {
  configer.subscribe((config) => config.channels, async (change) => {
    const applied = await channelManager.applyConfig(change.current)
    if (applied.isFailed) {
      await channelManager.sendSystem(`通道配置应用失败：${applied.message}`)
    }
  })
  configer.subscribe((config) => ({
    agents: config.agents,
    proxy: config.proxy,
    workspace: config.workspace,
    server: config.server
  }), async (change) => {
    const applied = await agentManager.applyConfig(change.current)
    if (applied.isFailed) {
      await channelManager.sendSystem(`Agent 配置应用失败：${applied.message}`)
    }
  })
  if (applicationLifecycle) {
    configer.subscribe((config) => ({
      server: config.server,
      web: config.channels.web
    }), () => {
      setImmediate(() => {
        void applicationLifecycle.restart().then(async (restarted) => {
          if (restarted.isFailed) {
            await channelManager.sendSystem(`Codexio 重启失败：${restarted.message}`)
          }
        }).catch(async (error) => {
          const failed = Result.fromError(error)
          await channelManager.sendSystem(`Codexio 重启失败：${failed.message}`)
        })
      })
    })
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

export { resolveAvailableServerPort }
