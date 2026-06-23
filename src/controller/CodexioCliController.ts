import { Writable } from 'node:stream'
import { Command } from 'commander'
import { inject, injectable } from 'inversify'
import { OutputId, ServeCommandId } from '../ComponentIdentifier.js'
import { AgentLoginService } from '../agent/AgentLoginService.js'
import { CodexioMetadata } from '../component/CodexioMetadata.js'
import { SupervisorClient } from '../component/ServerLifecycle.js'
import { SupervisorService } from '../component/Supervisor.js'
import { UpdateService } from '../component/UpdateService.js'
import { UpdateInstaller } from '../component/UpdateInstaller.js'
import { Configer } from '../component/Configer.js'

type ConfigOption = {
  config?: string
}

type ServeCommandOption = ConfigOption & {
  autoPort?: boolean
}

export type ServeCommand = (configer: Configer) => Promise<void>

@injectable()
export class CodexioCliController {
  constructor(
    @inject(OutputId) private readonly output: Writable,
    @inject(ServeCommandId) private readonly serve: ServeCommand,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata,
    @inject(SupervisorService) private readonly supervisorService: SupervisorService,
    @inject(AgentLoginService) private readonly agentLoginService: AgentLoginService
  ) {}

  createProgram(): Command {
    const program = new Command()
    program
      .name('codexio')
      .description('Codexio text relay')
      .version(this.metadata.readVersion())
      .action(async () => {
        await this.supervisorService.run()
      })

    program
      .command('init')
      .option('--config <path>', 'config file path')
      .option('--force', 'overwrite existing config')
      .action(async (command: Command | (ConfigOption & { force?: boolean })) => {
        const options = this.getCommandOptions<ConfigOption & { force?: boolean }>(command)
        const configer = new Configer(options.config ? new CodexioMetadata({
          rootPath: this.metadata.rootPath,
          configPath: options.config
        }) : this.metadata)
        const config = await configer.init(Boolean(options.force))
        this.output.write(`config: ${configer.path}\n`)
        this.output.write(`api: http://${config.server.host}:${config.server.port}\n`)
        if (config.channels.web?.enabled) {
          this.output.write(`web: http://${config.channels.web.host}:${config.channels.web.port}\n`)
        }
      })

    program
      .command('serve', {
        hidden: true
      })
      .option('--config <path>', 'config file path')
      .option('--auto-port', 'use next available server port')
      .action(async (command: Command | ServeCommandOption) => {
        const options = this.getCommandOptions<ServeCommandOption>(command)
        const configer = new Configer(options.config ? new CodexioMetadata({
          rootPath: this.metadata.rootPath,
          configPath: options.config
        }) : this.metadata)
        if (options.autoPort) {
          await configer.set('server.autoPort', true)
        }
        await this.serve(configer)
      })

    program
      .command('start')
      .option('--config <path>', 'config file path')
      .action(async (command: Command | ConfigOption) => {
        await this.supervisorService.run({
          configPath: this.getConfigPath(command)
        })
      })

    program
      .command('stop')
      .option('--config <path>', 'config file path')
      .action(async (command: Command | ConfigOption) => {
        const configPath = this.getConfigPath(command)
        const stopped = await new SupervisorClient(new Configer(configPath ? new CodexioMetadata({
          rootPath: this.metadata.rootPath,
          configPath
        }) : this.metadata)).stop()
        if (stopped) {
          this.output.write('codexio server stopped\n')
          return
        }
        this.output.write('codexio server not running\n')
      })

    program
      .command('dev')
      .option('--config <path>', 'config file path')
      .action(async (command: Command | ConfigOption) => {
        await this.supervisorService.run({
          configPath: this.getConfigPath(command),
          initConfig: true,
          autoPort: true,
          replaceRunning: true
        })
      })

    program
      .command('login')
      .option('--config <path>', 'config file path')
      .action(async (command: Command | ConfigOption) => {
        await this.agentLoginService.login(this.getConfigPath(command))
      })

    program
      .command('restart')
      .option('--config <path>', 'config file path')
      .action(async (command: Command | ConfigOption) => {
        const configPath = this.getConfigPath(command)
        const state = await new SupervisorClient(new Configer(configPath ? new CodexioMetadata({
          rootPath: this.metadata.rootPath,
          configPath
        }) : this.metadata)).restart()
        this.output.write(`codexio restart requested through supervisor ${state.host}:${state.port}\n`)
      })

    program
      .command('update')
      .option('--config <path>', 'config file path')
      .action(async (command: Command | ConfigOption) => {
        const configPath = this.getConfigPath(command)
        const configer = new Configer(configPath ? new CodexioMetadata({
          rootPath: this.metadata.rootPath,
          configPath
        }) : this.metadata)
        const result = await new UpdateService(new UpdateInstaller(configer, this.metadata)).update()
        if (result.isFailed) {
          throw new Error(result.message)
        }
        this.output.write(`${result.data ?? result.message}\n`)
      })

    return program
  }

  private getCommandOptions<T extends ConfigOption>(value: T | Command): T {
    const maybeCommand = value as {
      opts?: unknown
    }
    if (typeof maybeCommand.opts === 'function') {
      return (value as Command).opts<T>()
    }
    return value as T
  }

  private getConfigPath(value: Command | ConfigOption): string | undefined {
    return this.getCommandOptions<ConfigOption>(value).config
  }

}
