import { injectable } from 'inversify'

export type ServerEndpoint = {
  host: string
  port: number
}

export type ServerRuntimeOptions = {
  forceAutoPort?: boolean
}

@injectable()
export class ServerRuntime {
  readonly forceAutoPort: boolean
  private currentEndpoint?: ServerEndpoint

  constructor(options: ServerRuntimeOptions = {}) {
    this.forceAutoPort = options.forceAutoPort ?? false
  }

  get endpoint(): ServerEndpoint | undefined {
    return this.currentEndpoint ? { ...this.currentEndpoint } : undefined
  }

  requireEndpoint(): ServerEndpoint {
    const endpoint = this.endpoint
    if (!endpoint) {
      throw new Error('server endpoint not bound')
    }
    return endpoint
  }

  bind(endpoint: ServerEndpoint): void {
    this.currentEndpoint = {
      host: endpoint.host,
      port: endpoint.port
    }
  }

  clear(): void {
    this.currentEndpoint = undefined
  }
}
