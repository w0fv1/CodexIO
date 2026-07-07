#!/usr/bin/env node
import 'reflect-metadata'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { exit, pid } from 'node:process'
import { fileURLToPath } from 'node:url'
import { Container, inject, injectable } from 'inversify'
import { ChannelInputManager } from './controller/channeli/ChannelInputManager.js'
import { ChannelOutputManager } from './component/channelo/ChannelOutputManager.js'
import { Configer } from './component/Configer.js'
import { Result } from './value/Result.js'
import { Logger } from './component/Logger.js'
import { CodexioMetadata } from './component/CodexioMetadata.js'
import { CodexioApiController } from './controller/CodexioApiController.js'
import { EventBus } from './component/EventBus.js'
import { AppEvent } from './value/Event.js'
import { AgentManager } from './component/agent/AgentManager.js'
import { IoThreadIdManager } from './component/IoThreadIdManager.js'

@injectable()
export class CodexioApplication {
  private stopping = false
  private exiting = false

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly codexioMetadata: CodexioMetadata,
    @inject(ChannelInputManager) private readonly inputManager: ChannelInputManager,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(CodexioApiController) private readonly apiController: CodexioApiController,
    @inject(EventBus) private readonly eventBus: EventBus,
    @inject(AgentManager) private readonly agentManager: AgentManager,
    @inject(IoThreadIdManager) private readonly ioThreadIdManager: IoThreadIdManager
  ) {
    this.eventBus.on(AppEvent.StopRequested, () => {
      void this.stopAndExit(0)
    })
  }

  async start(): Promise<void> {
    await this.configer.init(false)
    await applyRuntimeConfig(this.configer, process.argv)
    await this.configer.validate()
    Logger.configure({
      logDir: this.codexioMetadata.logPath
    })
    const cleanedLogs = await Logger.cleanup(30)
    if (cleanedLogs.deleted > 0) {
      Logger.info('old log files cleaned', cleanedLogs)
    }
    try {
      await this.ioThreadIdManager.init()
      await this.apiController.start()
      await this.outputManager.start()
      const agentStarted = await this.agentManager.start()
      if (agentStarted.isFailed) {
        throw new Error(agentStarted.message)
      }
      await this.inputManager.start()
      await mkdir(dirname(this.codexioMetadata.serverStatePath), {
        recursive: true
      })
      await writeFile(this.codexioMetadata.serverStatePath, JSON.stringify({
        pid,
        host: await this.configer.get('server.host'),
        port: await this.configer.get('server.port'),
        startedAt: new Date().toISOString()
      }, null, 2), 'utf8')
      process.once('SIGINT', () => this.requestStop())
      process.once('SIGTERM', () => this.requestStop())
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<Result<void>> {
    if (this.stopping) {
      return Result.successVoid()
    }
    this.stopping = true
    Logger.info('codexio server stopping', {
      pid
    })
    const apiStopped = await this.apiController.stop()
    if (apiStopped.isFailed) {
      Logger.error('api stop failed', new Error(apiStopped.message))
    }
    const inputStopped = await this.inputManager.stop()
    if (inputStopped.isFailed) {
      Logger.error('channel input stop failed', new Error(inputStopped.message))
    }
    const agentStopped = await this.agentManager.stop()
    if (agentStopped.isFailed) {
      Logger.error('agent stop failed', new Error(agentStopped.message))
    }
    const outputStopped = await this.outputManager.stop()
    if (outputStopped.isFailed) {
      Logger.error('channel output stop failed', new Error(outputStopped.message))
    }
    await this.ioThreadIdManager.flush().catch((error) => {
      Logger.error('ioThread state flush failed', error)
    })
    await rm(this.codexioMetadata.serverStatePath, {
      force: true
    })
    await Logger.flush()
    return Result.successVoid()
  }

  private requestStop(): void {
    void this.stopAndExit(0)
  }

  private async stopAndExit(code: number): Promise<void> {
    if (this.exiting) {
      return
    }
    this.exiting = true
    const stopped = await this.stop()
    if (stopped.isFailed) {
      Logger.error('codexio server stop before exit failed', new Error(stopped.message))
      await Logger.flush()
      exit(1)
    }
    exit(code)
  }
}

export async function applyRuntimeConfig(configer: Configer, args: string[]): Promise<void> {
  if (args.includes('--auto-port')) {
    await configer.set('server.autoPort', true)
  }
}

const container = new Container({
  autobind: true,
  defaultScope: 'Singleton'
})
container.bind(CodexioMetadata).toConstantValue(new CodexioMetadata({
  configPath: process.argv.find((_, index, args) => args[index - 1] === '--config')
}))
const application = container.get(CodexioApplication)

if (isEntrypoint()) {
  void application.start().catch((error) => {
    Logger.error('codexio server failed', error)
    process.exitCode = 1
  })
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
