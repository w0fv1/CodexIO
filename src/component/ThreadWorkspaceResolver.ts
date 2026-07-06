import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inject, injectable } from 'inversify'
import { resolveUserPath } from '../util/Path.js'
import { CodexioMetadata } from './CodexioMetadata.js'
import { Configer } from './Configer.js'

@injectable()
export class ThreadWorkspaceResolver {
  constructor(
    @inject(Configer) private readonly configer: Configer,
    @inject(CodexioMetadata) private readonly metadata: CodexioMetadata
  ) {}

  async resolveBase(): Promise<string> {
    const workspacePath = await this.configer.get('workspace.path')
    const resolved = typeof workspacePath === 'string' ? resolveUserPath(workspacePath) : ''
    return resolved.length > 0 ? resolved : join(this.metadata.dataPath, 'workspace')
  }

  async resolve(ioThreadId?: string): Promise<string> {
    const base = await this.resolveBase()
    const perIoThread = await this.configer.get('workspace.perIoThread')
    const normalizedIoThreadId = ioThreadId?.trim() ?? ''
    if (!perIoThread || normalizedIoThreadId.length === 0) {
      return base
    }
    return join(base, sanitizePathSegment(normalizedIoThreadId))
  }

  async ensureBase(): Promise<string> {
    const path = await this.resolveBase()
    await mkdir(path, {
      recursive: true
    })
    return path
  }

  async ensure(ioThreadId?: string): Promise<string> {
    const path = await this.resolve(ioThreadId)
    await mkdir(path, {
      recursive: true
    })
    return path
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/^\.+$/, '_')
}
