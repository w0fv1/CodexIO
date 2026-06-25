#!/usr/bin/env node
import 'reflect-metadata'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pid } from 'node:process'
import { Container, inject, injectable } from 'inversify'
import { ChannelInputManager } from './channel/ChannelInputManager.js'
import { ChannelOutputManager } from './channel/ChannelOutputManager.js'
import { AgentManager } from './agent/AgentManager.js'
import { Configer } from './component/Configer.js'
import { Result } from './value/Result.js'
import { Updater } from './component/Updater.js'
import { Logger } from './component/Logger.js'
import { CodexioMetadata } from './component/CodexioMetadata.js'
import { CodexioApiController } from './controller/CodexioApiController.js'
import { EventBus } from './component/EventBus.js'
import { AppEvent } from './value/Event.js'
import { allIoThreadId } from './value/Message.js'

@injectable()
export class CodexioApplication {
  private stopping = false

  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly codexioMetadata: CodexioMetadata,
    @inject(ChannelInputManager) private readonly inputManager: ChannelInputManager,
    @inject(ChannelOutputManager) private readonly outputManager: ChannelOutputManager,
    @inject(AgentManager) private readonly agentManager: AgentManager,
    @inject(CodexioApiController) private readonly apiController: CodexioApiController,
    @inject(Updater) private readonly updater: Updater,
    @inject(EventBus) private readonly eventBus: EventBus
  ) {
    this.eventBus.on(AppEvent.StopRequested, () => {
      void this.stop()
    })
  }

  async start(): Promise<void> {
    await this.configer.init(false)
    await this.configer.validate()
    Logger.configure({
      logDir: this.codexioMetadata.logPath
    })
    const cleanedLogs = await Logger.cleanup(30)
    if (cleanedLogs.deleted > 0) {
      Logger.info('old log files cleaned', cleanedLogs)
    }
    try {
      await this.apiController.start()
      await this.outputManager.start()
      await this.inputManager.start()
      const agentStarted = await this.agentManager.start()
      if (agentStarted.isFailed) {
        await this.outputManager.sendSystem(agentStarted.message, 'agent', allIoThreadId)
      }
      this.updater.start()
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

  async stop(): Promise<Result<null>> {
    if (this.stopping) {
      return Result.success(null)
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
    await rm(this.codexioMetadata.serverStatePath, {
      force: true
    })
    return Result.success(null)
  }

  private requestStop(): void {
    void this.stop()
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

void application.start().catch((error) => {
  Logger.error('codexio server failed', error)
  process.exitCode = 1
})
