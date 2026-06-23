import 'reflect-metadata'
import { Container } from 'inversify'
import type { ServiceIdentifier } from 'inversify'
import { Writable } from 'node:stream'
import { AgentManager } from './agent/AgentManager.js'
import { AgentLoginService } from './agent/AgentLoginService.js'
import { ChannelManager } from './channel/ChannelManager.js'
import { CommandExecutor } from './controller/CommandExecutor.js'
import { CodexioCliController, ServeCommand } from './controller/CodexioCliController.js'
import { Result } from './value/Result.js'
import { CodeioApp } from './CodeioApp.js'
import { CodexioMetadata } from './component/CodexioMetadata.js'
import { Configer } from './component/Configer.js'
import { SupervisorService } from './component/Supervisor.js'
import {
  AgentManagerCallbacksId,
  ChannelReceiveId,
  OutputId,
  ServeCommandId
} from './ComponentIdentifier.js'

export class ComponentRegistry {
  private readonly container = new Container({
    autobind: true,
    defaultScope: 'Singleton'
  })

  registerCli(input: {
    output: Writable
    serve: ServeCommand
  }): void {
    this.container.bind(OutputId).toConstantValue(input.output)
    this.container.bind(ServeCommandId).toConstantValue(input.serve)
    this.container.bind(AgentManagerCallbacksId).toConstantValue({
      send: async (message) => {
        input.output.write(`${message.text}\n`)
        return Result.success(null)
      },
      status: async (text) => {
        input.output.write(`${text}\n`)
        return Result.success(null)
      }
    })
  }

  async registerServer(input: {
    configer: Configer
  }): Promise<void> {
    await input.configer.validate()
    this.container.bind(Configer).toConstantValue(input.configer)
    this.container.bind(ChannelReceiveId).toConstantValue(async (message) => this.resolve(CommandExecutor).receive(message))
    this.container.bind(AgentManagerCallbacksId).toConstantValue({
      send: async (message) => this.resolve(ChannelManager).send(message),
      status: async (text) => this.resolve(ChannelManager).status(text)
    })
  }

  resolve<T>(serviceIdentifier: ServiceIdentifier<T>): T {
    return this.container.get(serviceIdentifier)
  }
}
