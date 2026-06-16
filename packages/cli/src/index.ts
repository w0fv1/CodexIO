#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { Command } from 'commander'
import { ConfigService } from '@codexio/core'
import { createCodexioApp } from '@codexio/server'

const program = new Command()

program
  .name('codexio')
  .description('Codexio text relay')
  .version('0.1.0')

program
  .command('init')
  .option('--force', 'overwrite existing config')
  .action(async (options: { force?: boolean }) => {
    const service = new ConfigService()
    const config = await service.init(Boolean(options.force))
    await installSkill()
    output.write(`config: ${service.path}\n`)
    output.write(`server: ${config.server.host}:${config.server.port}\n`)
  })

program
  .command('serve')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    const server = createCodexioApp(config)
    server.app.listen(config.server.port, config.server.host, () => {
      output.write(`codexio listening on http://${config.server.host}:${config.server.port}\n`)
    })
  })

program
  .command('chat')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    const server = createCodexioApp(config)
    const listener = server.app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => {
      listener.once('listening', resolve)
    })
    const address = listener.address()
    if (!address || typeof address === 'string') {
      throw new Error('server address not found')
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    const readline = createInterface({
      input,
      output
    })
    output.write('codexio cli adapter ready. type exit to quit.\n')
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
          conversationId: 'terminal',
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
    listener.close()
  })

program
  .command('doctor')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    output.write(`config: ${service.path}\n`)
    output.write(`server: ${config.server.host}:${config.server.port}\n`)
    output.write(`proxy: ${config.proxy.enabled ? 'enabled' : 'disabled'}\n`)
    if (config.proxy.http) {
      output.write(`http: ${config.proxy.http}\n`)
    }
    if (config.proxy.https) {
      output.write(`https: ${config.proxy.https}\n`)
    }
    if (config.proxy.socks) {
      output.write(`socks: ${config.proxy.socks}\n`)
    }
    output.write(`workspaces: ${Object.keys(config.workspaces).join(', ')}\n`)
  })

const configCommand = program.command('config')

configCommand
  .command('show')
  .action(async () => {
    const service = new ConfigService()
    const text = await readFile(service.path, 'utf8')
    output.write(text)
  })

const proxyCommand = configCommand.command('proxy')

proxyCommand
  .command('enable')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    config.proxy.enabled = true
    await service.save(config)
    output.write('proxy enabled\n')
  })

proxyCommand
  .command('disable')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    config.proxy.enabled = false
    await service.save(config)
    output.write('proxy disabled\n')
  })

proxyCommand
  .command('set')
  .option('--http <url>')
  .option('--https <url>')
  .option('--socks <url>')
  .action(async (options: { http?: string; https?: string; socks?: string }) => {
    const service = new ConfigService()
    const config = await service.load()
    if (options.http) {
      config.proxy.http = options.http
    }
    if (options.https) {
      config.proxy.https = options.https
    }
    if (options.socks) {
      config.proxy.socks = options.socks
    }
    config.proxy.enabled = true
    await service.save(config)
    output.write('proxy updated\n')
  })

proxyCommand
  .command('show')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    output.write(`enabled: ${config.proxy.enabled}\n`)
    output.write(`http: ${config.proxy.http ?? ''}\n`)
    output.write(`https: ${config.proxy.https ?? ''}\n`)
    output.write(`socks: ${config.proxy.socks ?? ''}\n`)
    output.write(`noProxy: ${config.proxy.noProxy.join(',')}\n`)
  })

const serverCommand = configCommand.command('server')

serverCommand
  .command('set')
  .option('--host <host>')
  .option('--port <port>')
  .option('--public-url <url>')
  .action(async (options: { host?: string; port?: string; publicUrl?: string }) => {
    const service = new ConfigService()
    const config = await service.load()
    if (options.host) {
      config.server.host = options.host
    }
    if (options.port) {
      config.server.port = Number.parseInt(options.port, 10)
    }
    if (options.publicUrl) {
      config.server.publicUrl = options.publicUrl
    }
    await service.save(config)
    output.write('server updated\n')
  })

const workspaceCommand = program.command('workspace')

workspaceCommand
  .command('add')
  .argument('<name>')
  .argument('<path>')
  .option('--agent <agent>')
  .action(async (name: string, path: string, options: { agent?: string }) => {
    const service = new ConfigService()
    const config = await service.load()
    config.workspaces[name] = {
      path,
      defaultAgent: options.agent ?? config.defaultAgent,
      allowedChannels: [
        'web',
        'cli'
      ]
    }
    await service.save(config)
    output.write(`workspace added: ${name}\n`)
  })

workspaceCommand
  .command('default')
  .argument('<name>')
  .action(async (name: string) => {
    const service = new ConfigService()
    const config = await service.load()
    if (!config.workspaces[name]) {
      throw new Error(`workspace not found: ${name}`)
    }
    config.routing.defaultWorkspace = name
    await service.save(config)
    output.write(`default workspace: ${name}\n`)
  })

workspaceCommand
  .command('list')
  .action(async () => {
    const service = new ConfigService()
    const config = await service.load()
    for (const [name, workspace] of Object.entries(config.workspaces)) {
      output.write(`${name}\t${workspace.path}\t${workspace.defaultAgent ?? config.defaultAgent}\n`)
    }
  })

workspaceCommand
  .command('remove')
  .argument('<name>')
  .action(async (name: string) => {
    const service = new ConfigService()
    const config = await service.load()
    delete config.workspaces[name]
    await service.save(config)
    output.write(`workspace removed: ${name}\n`)
  })

await program.parseAsync()

async function installSkill(): Promise<void> {
  const root = fileURLToPath(new URL('../../..', import.meta.url))
  const source = join(root, 'skills', 'codexio', 'SKILL.md')
  const target = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.codexio', 'skills', 'codexio', 'SKILL.md')
  const text = await readFile(source, 'utf8')
  await mkdir(dirname(target), {
    recursive: true
  })
  await writeFile(target, text, 'utf8')
}
