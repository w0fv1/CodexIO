#!/usr/bin/env node
import { Server as HttpServer } from 'node:http'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { argv, stdin as input, stdout as output, stderr as errorOutput } from 'node:process'
import { pathToFileURL } from 'node:url'
import express from 'express'
import cors from 'cors'
import { Command } from 'commander'
import { ChannelAdapter, ChannelReceiveResult } from './channel/ChannelAdapter.js'
import { CliChannelAdapter } from './channel/CliChannelAdapter.js'
import { WebChannelAdapter } from './channel/WebChannelAdapter.js'
import { Agent } from './agent/Agent.js'
import { ClaudeAgent } from './agent/ClaudeAgent.js'
import { CodexAgent } from './agent/CodexAgent.js'
import { EchoAgent } from './agent/EchoAgent.js'
import { CodexioConfig, ConfigService } from './ConfigService.js'
import { Result } from './Result.js'

export type CodexioServer = {
  app: express.Express
  web: WebChannelAdapter
  cli: CliChannelAdapter
  ready: Promise<Result<null>>
  listen: (port?: number, host?: string) => HttpServer
}

export function createCodexioApp(config: CodexioConfig): CodexioServer {
  const app = express()
  app.use(cors())
  app.use(express.json({
    limit: '1mb'
  }))

  const web = new WebChannelAdapter()
  const cli = new CliChannelAdapter()
  const adapters = new Map<string, ChannelAdapter>()
  for (const adapter of [
    web,
    cli
  ]) {
    const channelConfig = config.channels[adapter.type]
    if (channelConfig?.enabled) {
      adapters.set(adapter.type, adapter)
    }
  }
  const toolBaseUrl = `http://${config.server.host}:${config.server.port}`
  let currentAgent: Agent | undefined
  let currentChannel = adapters.keys().next().value

  const activeAdapter = (): ChannelAdapter => {
    if (!currentChannel) {
      throw new Error('channel adapter not found')
    }
    const adapter = adapters.get(currentChannel)
    if (!adapter) {
      throw new Error(`channel adapter not found: ${currentChannel}`)
    }
    return adapter
  }

  const startAgent = async (channel?: string): Promise<Result<null>> => {
    try {
      if (channel) {
        currentChannel = channel
      }
      if (!currentChannel) {
        currentChannel = adapters.keys().next().value
      }
      if (!currentChannel || !adapters.has(currentChannel)) {
        return Result.fail('channel adapter not found')
      }
      const send = async (value: string) => {
        const sent = await activeAdapter().send(value)
        if (sent.isFailed) {
          throw new Error(sent.message)
        }
      }
      currentAgent = createAgent(config, toolBaseUrl, send)
      await currentAgent.start(config)
      return Result.success(null)
    } catch (error) {
      return Result.fromError(error)
    }
  }

  app.post('/api/message', async (request, response) => {
    try {
      const body = request.body as Record<string, unknown>
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        response.json(Result.fail('text is required'))
        return
      }
      const sent = await activeAdapter().send(body.text)
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

  for (const adapter of adapters.values()) {
    adapter.start({
      app,
      receive: async (received) => {
        try {
          if (received.text.trim() === '/$ clear') {
            currentChannel = received.channel
            if (!currentAgent) {
              const started = await startAgent(received.channel)
              if (started.isFailed) {
                return Result.fail<ChannelReceiveResult>(started.message)
              }
            }
            if (!currentAgent) {
              return Result.fail<ChannelReceiveResult>('agent not started')
            }
            await currentAgent.clear()
            return Result.success({
              action: 'clear'
            })
          }
          let text = received.text
          if (text.startsWith('/$$')) {
            text = `/$${text.slice(3)}`
          }
          currentChannel = received.channel
          if (!currentAgent) {
            const started = await startAgent(received.channel)
            if (started.isFailed) {
              return Result.fail<ChannelReceiveResult>(started.message)
            }
          }
          if (!currentAgent) {
            return Result.fail<ChannelReceiveResult>('agent not started')
          }
          await currentAgent.receive(text)
          return Result.success({})
        } catch (error) {
          const failed = Result.fromError(error)
          return Result.fail<ChannelReceiveResult>(failed.message)
        }
      }
    })
  }

  return {
    app,
    web,
    cli,
    ready: startAgent(),
    listen: (port?: number, host?: string) => {
      let listener: HttpServer
      if (port !== undefined && host) {
        listener = app.listen(port, host)
      } else if (port !== undefined) {
        listener = app.listen(port)
      } else {
        listener = app.listen()
      }
      if (adapters.has(web.type)) {
        web.attach(listener)
      }
      return listener
    }
  }
}

export function createAgent(config: CodexioConfig, toolBaseUrl: string, send: (text: string) => Promise<void>): Agent {
  const enabledAgents = Object.entries(config.agents).filter(([, agentConfig]) => agentConfig.enabled)
  if (enabledAgents.length === 0) {
    throw new Error('agent not found')
  }
  if (enabledAgents.length > 1) {
    throw new Error('only one agent can be enabled')
  }
  const [agentName] = enabledAgents[0]
  if (agentName === 'echo') {
    return new EchoAgent({
      send
    })
  }
  if (agentName === 'codex') {
    return new CodexAgent({
      workspacePath: config.workspace.path,
      config,
      toolBaseUrl,
      send
    })
  }
  if (agentName === 'claude') {
    return new ClaudeAgent({
      workspacePath: config.workspace.path,
      config,
      send
    })
  }
  throw new Error(`agent not supported: ${agentName}`)
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
    await serve(service.createDefaultConfig(process.cwd()))
  })

program
  .command('login')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.init(false)
    const toolBaseUrl = `http://${config.server.host}:${config.server.port}`
    const agent = createAgent(config, toolBaseUrl, async (text) => {
      output.write(`${text}\n`)
    })
    await agent.login()
  })

program
  .command('chat')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    const baseUrl = `http://${config.server.host}:${config.server.port}`
    const readline = createInterface({
      input,
      output
    })
    output.write(`codexio cli adapter connected to ${baseUrl}. type exit to quit.\n`)
    if (input.isTTY) {
      output.write('> ')
    }
    for await (const text of readline) {
      if (text.trim() === 'exit') {
        readline.close()
        break
      }
      if (text.trim().length === 0) {
        continue
      }
      const response = await fetch(`${baseUrl}/api/messages/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channel: 'cli',
          text
        })
      })
      const result = await response.json() as {
        isFailed: boolean
        message: string
      }
      if (result.isFailed) {
        output.write(`error: ${result.message}\n`)
      }
      if (input.isTTY) {
        output.write('> ')
      }
    }
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
  const ready = await server.ready
  if (ready.isFailed) {
    throw new Error(ready.message)
  }
  const listener = server.listen(resolvedConfig.server.port, resolvedConfig.server.host)
  await new Promise<void>((resolveListening) => {
    listener.once('listening', resolveListening)
  })
  output.write(`codexio listening on http://${resolvedConfig.server.host}:${resolvedConfig.server.port}\n`)
}
