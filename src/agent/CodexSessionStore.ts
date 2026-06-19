import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { codexioRootPath } from '../AppMetadata.js'

export type CodexSession = {
  agent: 'codex'
  threadId: string
  updatedAt: string
}

export class CodexSessionStore {
  constructor(private readonly path = join(codexioRootPath, '.codexio', 'session.json')) {}

  async read(): Promise<CodexSession | undefined> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined
      }
      throw error
    }
    const data = JSON.parse(text) as {
      agent?: unknown
      threadId?: unknown
      updatedAt?: unknown
    }
    if (data.agent !== 'codex' || typeof data.threadId !== 'string' || data.threadId.trim().length === 0) {
      return undefined
    }
    return {
      agent: 'codex',
      threadId: data.threadId,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : ''
    }
  }

  async write(threadId: string): Promise<void> {
    const session: CodexSession = {
      agent: 'codex',
      threadId,
      updatedAt: new Date().toISOString()
    }
    await mkdir(dirname(this.path), {
      recursive: true
    })
    const temporaryPath = `${this.path}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.path)
  }

  async clear(): Promise<void> {
    await rm(this.path, {
      force: true
    })
  }
}
