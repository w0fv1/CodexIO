#!/usr/bin/env node
import { Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { argv, pid, stdout as output } from 'node:process'
import { pathToFileURL } from 'node:url'
import express from 'express'
import cors from 'cors'
import { Command } from 'commander'
import { z } from 'zod'
import { ChannelManager } from './channel/ChannelManager.js'
import { AgentManager } from './agent/AgentManager.js'
import { CodexioConfig, ConfigSchema, ConfigService, validateCodexioConfig } from './ConfigService.js'
import { Result } from './value/Result.js'
import { readCodexioVersion } from './AppMetadata.js'
import { checkCodexioUpdate } from './component/UpdateChecker.js'
import { UpdateInstaller } from './component/UpdateInstaller.js'
import { CommandExecutor } from './controller/CommandExecutor.js'
import { AgentFactory } from './agent/AgentManager.js'
import { Logger } from './component/Logger.js'
import { runSupervisor } from './component/Supervisor.js'
import {
  removeRuntimeServerState,
  resolveAvailableServerPort,
  resolveRestartTargets,
  restartServer,
  stopServer,
  writeRuntimeServerState
} from './component/ServerLifecycle.js'

const AgentMessageBodySchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0)
})

export type CodexioServer = {
  app: express.Express
  channelManager: ChannelManager
  agentManager: AgentManager
  listen: (port?: number, host?: string) => HttpServer
  stop: () => Promise<Result<null>>
}

export type CodexioAppOptions = {
  agentFactory?: AgentFactory
  configPath?: string
}

export function createCodexioApp(config: CodexioConfig, options: CodexioAppOptions = {}): CodexioServer {
  validateCodexioConfig(config)
  const app = express()
  app.use(cors())
  app.use(express.json({
    limit: '1mb'
  }))

  const channelManager = new ChannelManager(config)
  const toolBaseUrl = `http://${config.server.host}:${config.server.port}`
  const agentManager = new AgentManager(config, toolBaseUrl, {
    send: async (text) => channelManager.send(text),
    status: async (text) => channelManager.status(text)
  }, {
    agentFactory: options.agentFactory
  })
  const updateInstaller = options.configPath ? new UpdateInstaller(config, options.configPath) : undefined
  const commandExecutor = new CommandExecutor(channelManager, agentManager, updateInstaller)
  let activeListener: HttpServer | undefined

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
        response.json(Result.fail('text is required'))
        return
      }
      Logger.info('api message received', {
        length: body.data.text.length
      })
      const sent = await channelManager.send(body.data.text)
      if (sent.isFailed) {
        response.json(sent)
        return
      }
      response.json(Result.success({
        sent: true
      }))
    } catch (error) {
      Logger.error('api message failed', error)
      response.json(Result.fromError(error))
    }
  })

  app.post('/api/agent/restart', async (request, response) => {
    try {
      const authorization = request.header('authorization')
      if (authorization !== `Bearer ${config.server.token}`) {
        Logger.warn('api agent restart unauthorized')
        response.status(401).json(Result.fail('unauthorized', '401'))
        return
      }
      Logger.info('api agent restart requested')
      response.json(await agentManager.restart())
    } catch (error) {
      Logger.error('api agent restart failed', error)
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

  app.get('/api/status', (_request, response) => {
    response.json(Result.success({
      ...agentManager.status(),
      pid
    }))
  })

  channelManager.start(app, async (text, source) => commandExecutor.receive({
    text,
    source
  }))

  return {
    app,
    channelManager,
    agentManager,
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
      channelManager.attach(listener)
      listener.once('listening', () => {
        void channelManager.send('Codexio server started.')
        void checkCodexioUpdate(config)
          .then(async (message) => {
            if (message) {
              await channelManager.send(message)
            }
          })
          .catch((error) => {
            Logger.error('update check failed', error)
          })
        void agentManager.start()
      })
      const close = listener.close.bind(listener)
      listener.close = ((callback?: (error?: Error) => void) => {
        void (async () => {
          await channelManager.send('Codexio server stopping.')
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
    const service = new ConfigService(options.config)
    const config = await service.init(Boolean(options.force))
    output.write(`config: ${service.path}\n`)
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
      autoPort: true
    })
  })

program
  .command('login')
  .option('--config <path>', 'config file path')
  .action(async (command: Command | ConfigOption) => {
    const service = new ConfigService(getConfigPath(command))
    const config = await service.init(false)
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
    const service = new ConfigService(getConfigPath(command))
    const config = await service.load()
    const result = await new UpdateInstaller(config, service.path).update()
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
  const service = new ConfigService(configPath)
  const resolvedConfig = config ?? await service.load()
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
    configPath: service.path
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
  await writeRuntimeServerState(service.path, {
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
  const stop = () => {
    if (stopping) {
      return
    }
    stopping = true
    Logger.info('codexio server stopping', {
      pid
    })
    listener.close((error) => {
      void removeRuntimeServerState(service.path)
        .finally(() => {
          if (error) {
            Logger.error('server close failed', error)
            process.exitCode = 1
          }
        })
    })
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

export { resolveAvailableServerPort, resolveRestartTargets }
