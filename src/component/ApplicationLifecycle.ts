import { Result } from '../value/Result.js'
import { restartServer } from './ServerLifecycle.js'

export type ApplicationLifecycle = {
  restart: () => Promise<Result<string>>
}

export class SupervisorApplicationLifecycle implements ApplicationLifecycle {
  constructor(private readonly configPath: string) {}

  async restart(): Promise<Result<string>> {
    try {
      const supervisor = await restartServer(this.configPath)
      return Result.success(`Codexio restart requested through supervisor ${supervisor.host}:${supervisor.port}`)
    } catch (error) {
      const failed = Result.fromError(error)
      return Result.fail<string>(failed.message, failed.code)
    }
  }
}
