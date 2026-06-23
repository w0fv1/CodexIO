#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { argv, pid, stdout as output } from 'node:process'
import { pathToFileURL } from 'node:url'
import { inject, injectable } from 'inversify'
import { ChannelManager } from './channel/ChannelManager.js'
import { AgentManager } from './agent/AgentManager.js'
import { Configer } from './component/Configer.js'
import { Result } from './value/Result.js'
import { UpdateChecker } from './component/UpdateChecker.js'
import { CodexioCliController } from './controller/CodexioCliController.js'
import { Logger } from './component/Logger.js'
import { ComponentRegistry } from './ComponentRegistry.js'
import { CodexioMetadata } from './component/CodexioMetadata.js'
import { CodexioApiController } from './controller/CodexioApiController.js'
import { isProcessAlive, SupervisorClient } from './component/ServerLifecycle.js'
import { EventBus } from './component/EventBus.js'
import { AppEvent } from './value/Event.js'

@injectable()
export class CodexioApplication {
  private stopping = false
  private closed = false
  private supervisorWatch?: NodeJS.Timeout

  constructor(
    @inject(CodexioMetadata) private readonly codexioMetadata: CodexioMetadata,
    @inject(ChannelManager) private readonly channelManager: ChannelManager,
    @inject(AgentManager) private readonly agentManager: AgentManager,
    @inject(CodexioApiController) private readonly apiController: CodexioApiController,
    @inject(SupervisorClient) private readonly supervisorClient: SupervisorClient,
    @inject(UpdateChecker) private readonly updateChecker: UpdateChecker,
    @inject(EventBus) private readonly eventBus: EventBus
  ) {
    this.eventBus.on(AppEvent.HttpClosed, (error) => {
      void this.close(error)
    })
  }

  async start(): Promise<void> {
    Logger.configure({
      logDir: join(this.codexioMetadata.rootPath, '.codexio', 'log')
    })
    const cleanedLogs = await Logger.cleanup(30)
    if (cleanedLogs.deleted > 0) {
      Logger.info('old log files cleaned', cleanedLogs)
    }
    await this.apiController.start()
    await this.channelManager.start()
    void this.channelManager.sendSystem('Codexio server started.')
    this.eventBus.emit(AppEvent.Started)
    this.updateChecker.start()
    await this.supervisorClient.initial()
    this.watchSupervisor()
    process.once('SIGINT', () => this.requestStop())
    process.once('SIGTERM', () => this.requestStop())
  }

  async stop(): Promise<Result<null>> {
    const agentStopped = await this.agentManager.stop()
    const channelStopped = await this.channelManager.stop()
    if (agentStopped.isFailed) {
      return agentStopped
    }
    if (channelStopped.isFailed) {
      return channelStopped
    }
    return Result.success(null)
  }

  private requestStop(): void {
    if (this.stopping) {
      return
    }
    this.stopping = true
    if (this.supervisorWatch) {
      clearInterval(this.supervisorWatch)
      this.supervisorWatch = undefined
    }
    Logger.info('codexio server stopping', {
      pid
    })
    void this.channelManager.sendSystem('Codexio server stopping.')
      .finally(() => {
        this.eventBus.emit(AppEvent.StopRequested)
      })
  }

  private watchSupervisor(): void {
    const supervisorPid = Number(process.env.CODEXIO_SUPERVISOR_PID)
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
      return
    }
    this.supervisorWatch = setInterval(() => {
      if (isProcessAlive(supervisorPid)) {
        return
      }
      Logger.warn('codexio supervisor disappeared', {
        supervisorPid
      })
      this.requestStop()
    }, 1000)
    this.supervisorWatch.unref()
  }

  private async close(error?: Error): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    const agentStopped = await this.agentManager.stop()
    const channelStopped = await this.channelManager.stop()
    await this.supervisorClient.clearRuntime()
    if (error) {
      Logger.error('server close failed', error)
      process.exitCode = 1
      return
    }
    if (agentStopped.isFailed) {
      Logger.error('agent stop failed', new Error(agentStopped.message))
      process.exitCode = 1
      return
    }
    if (channelStopped.isFailed) {
      Logger.error('channel stop failed', new Error(channelStopped.message))
      process.exitCode = 1
    }
  }
}

const registry = new ComponentRegistry()
registry.registerCli({
  output,
  serve
})
const program = registry.resolve(CodexioCliController).createProgram()

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

async function serve(configer: Configer): Promise<void> {
  const registry = new ComponentRegistry()
  await registry.registerServer({
    configer
  })
  const application = registry.resolve(CodexioApplication)
  await application.start()
}
