import { mkdir, appendFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { codexioRootPath } from '../AppMetadata.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LoggerOptions = {
  logDir?: string
  consoleEnabled?: boolean
}

export type LoggerCleanupResult = {
  deleted: number
}

type LogRecord = {
  time: string
  level: LogLevel
  message: string
  data?: unknown
  error?: unknown
}

const defaultConsoleEnabled = process.env.NODE_ENV !== 'test'

export class Logger {
  private static logDir = join(codexioRootPath, '.codexio', 'log')
  private static consoleEnabled = defaultConsoleEnabled
  private static pending: Promise<void> = Promise.resolve()

  static configure(options: LoggerOptions): void {
    if (options.logDir !== undefined) {
      Logger.logDir = options.logDir
    }
    if (options.consoleEnabled !== undefined) {
      Logger.consoleEnabled = options.consoleEnabled
    }
  }

  static reset(): void {
    Logger.logDir = join(codexioRootPath, '.codexio', 'log')
    Logger.consoleEnabled = defaultConsoleEnabled
    Logger.pending = Promise.resolve()
  }

  static debug(message: string, data?: unknown): void {
    Logger.write('debug', message, data)
  }

  static info(message: string, data?: unknown): void {
    Logger.write('info', message, data)
  }

  static warn(message: string, data?: unknown): void {
    Logger.write('warn', message, data)
  }

  static error(message: string, error?: unknown): void {
    const record: LogRecord = {
      time: new Date().toISOString(),
      level: 'error',
      message
    }
    if (error !== undefined) {
      record.error = Logger.normalizeError(error)
    }
    Logger.output(record)
    Logger.enqueue(record)
  }

  static async flush(): Promise<void> {
    await Logger.pending
  }

  static async cleanup(retentionDays = 30): Promise<LoggerCleanupResult> {
    await mkdir(Logger.logDir, {
      recursive: true
    })
    const cutoff = new Date()
    cutoff.setHours(0, 0, 0, 0)
    cutoff.setDate(cutoff.getDate() - retentionDays)
    let deleted = 0
    for (const entry of await readdir(Logger.logDir, {
      withFileTypes: true
    })) {
      if (!entry.isFile()) {
        continue
      }
      const matched = /^(\d{4})-(\d{2})-(\d{2})\.log$/.exec(entry.name)
      if (!matched) {
        continue
      }
      const fileDate = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]))
      if (Number.isNaN(fileDate.getTime()) || fileDate >= cutoff) {
        continue
      }
      await rm(join(Logger.logDir, entry.name), {
        force: true
      })
      deleted += 1
    }
    return {
      deleted
    }
  }

  private static write(level: LogLevel, message: string, data?: unknown): void {
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      message
    }
    if (data !== undefined) {
      record.data = Logger.normalizeData(data)
    }
    Logger.output(record)
    Logger.enqueue(record)
  }

  private static output(record: LogRecord): void {
    if (!Logger.consoleEnabled) {
      return
    }
    const payload = record.error ?? record.data
    const suffix = payload === undefined ? '' : ` ${Logger.stringifyConsole(payload)}`
    const line = `[${record.level}] ${record.message}${suffix}\n`
    if (record.level === 'error' || record.level === 'warn') {
      process.stderr.write(line)
      return
    }
    process.stdout.write(line)
  }

  private static enqueue(record: LogRecord): void {
    Logger.pending = Logger.pending
      .then(() => Logger.append(record))
      .catch((error) => {
        process.stderr.write(`[error] logger write failed ${Logger.stringifyConsole(Logger.normalizeError(error))}\n`)
      })
  }

  private static async append(record: LogRecord): Promise<void> {
    await mkdir(Logger.logDir, {
      recursive: true
    })
    await appendFile(join(Logger.logDir, `${Logger.localDate()}.log`), `${JSON.stringify(record)}\n`, 'utf8')
  }

  private static localDate(): string {
    const date = new Date()
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  private static normalizeError(error: unknown): unknown {
    if (error instanceof Error) {
      const normalized: Record<string, unknown> = {
        name: error.name,
        message: error.message
      }
      if (error.stack) {
        normalized.stack = error.stack
      }
      if ('cause' in error && error.cause !== undefined) {
        normalized.cause = Logger.normalizeData(error.cause)
      }
      return normalized
    }
    return Logger.normalizeData(error)
  }

  private static normalizeData(data: unknown): unknown {
    try {
      JSON.stringify(data)
      return data
    } catch {
      return inspect(data, {
        depth: 6,
        breakLength: Infinity
      })
    }
  }

  private static stringifyConsole(data: unknown): string {
    if (typeof data === 'string') {
      return data
    }
    return inspect(data, {
      depth: 6,
      colors: false,
      breakLength: Infinity
    })
  }
}
