#!/usr/bin/env node
import { Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { argv, stdout as output, stderr as errorOutput } from 'node:process'
import { pathToFileURL } from 'node:url'
import express from 'express'
import cors from 'cors'
import { Command } from 'commander'
import { AdapterManager } from './channel/AdapterManager.js'
import { AgentManager } from './agent/AgentManager.js'
import { CodexioConfig, ConfigService } from './ConfigService.js'
import { Result } from './Result.js'

export type CodexioServer = {
  app: express.Express
  adapterManager: AdapterManager
  agentManager: AgentManager
  listen: (port?: number, host?: string) => HttpServer
  stop: () => Promise<Result<null>>
}

export function createCodexioApp(config: CodexioConfig): CodexioServer {
  const app = express()
  app.use(cors())
  app.use(express.json({
    limit: '1mb'
  }))

  const adapterManager = new AdapterManager(config)
  const toolBaseUrl = `http://${config.server.host}:${config.server.port}`
  const agentManager = new AgentManager(config, toolBaseUrl, {
    send: async (text) => adapterManager.send(text),
    status: async (text) => adapterManager.status(text)
  })

  app.post('/api/message', async (request, response) => {
    try {
      const body = request.body as Record<string, unknown>
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        response.json(Result.fail('text is required'))
        return
      }
      const sent = await adapterManager.send(body.text)
      if (sent.isFailed) {
        response.json(sent)
        return
      }
      response.json(Result.success({
        sent: true
      }))
    } catch (error) {
      response.json(Result.fromError(error))
    }
  })

  app.get('/api/status', (_request, response) => {
    response.json(Result.success(agentManager.status()))
  })

  adapterManager.start(app, async (received) => agentManager.receive(received))

  return {
    app,
    adapterManager,
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
      adapterManager.attach(listener)
      listener.once('listening', () => {
        void agentManager.start()
      })
      const close = listener.close.bind(listener)
      listener.close = ((callback?: (error?: Error) => void) => {
        void (async () => {
          const agentStopped = await agentManager.stop()
          const adapterStopped = await adapterManager.stop()
          close((error?: Error) => {
            if (error) {
              callback?.(error)
              return
            }
            if (agentStopped.isFailed) {
              callback?.(new Error(agentStopped.message))
              return
            }
            if (adapterStopped.isFailed) {
              callback?.(new Error(adapterStopped.message))
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
      const adapterStopped = await adapterManager.stop()
      if (agentStopped.isFailed) {
        return agentStopped
      }
      if (adapterStopped.isFailed) {
        return adapterStopped
      }
      return Result.success(null)
    }
  }
}

const program = new Command()

program
  .name('codexio')
  .description('Codexio text relay')
  .version('0.1.0')
  .action(async () => {
    await serve()
  })

program
  .command('init')
  .option('--force', 'overwrite existing config')
  .action(async (options: { force?: boolean }) => {
    const service = new ConfigService()
    const config = await service.init(Boolean(options.force))
    output.write(`config: ${service.path}\n`)
    output.write(`server: ${config.server.host}:${config.server.port}\n`)
  })

program
  .command('serve')
  .action(async () => {
    await serve()
  })

program
  .command('dev')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.init(false)
    await serve(config)
  })

program
  .command('login')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.init(false)
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

if (argv[1] && import.meta.url === pathToFileURL(resolve(argv[1])).href) {
  void main()
}

async function main(): Promise<void> {
  try {
    await program.parseAsync()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    errorOutput.write(`${message}\n`)
    process.exitCode = 1
  }
}

async function serve(config?: CodexioConfig): Promise<void> {
  const service = new ConfigService()
  const resolvedConfig = config ?? await service.load()
  const server = createCodexioApp(resolvedConfig)
  const listener = server.listen(resolvedConfig.server.port, resolvedConfig.server.host)
  await new Promise<void>((resolveListening) => {
    listener.once('listening', resolveListening)
  })
  output.write(`codexio listening on http://${resolvedConfig.server.host}:${resolvedConfig.server.port}\n`)
}
