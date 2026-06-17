import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join, resolve } from 'node:path'
import { CodexioConfig } from '../ConfigService.js'

let codexioRoot = dirname(fileURLToPath(import.meta.url))
while (!existsSync(join(codexioRoot, 'package.json')) && dirname(codexioRoot) !== codexioRoot) {
  codexioRoot = dirname(codexioRoot)
}

export const codexHomePath = join(codexioRoot, '.codexio', 'codex')
export const codexioRootPath = codexioRoot

export function createAgentEnv(config: CodexioConfig): NodeJS.ProcessEnv {
  mkdirSync(codexHomePath, {
    recursive: true
  })
  const env = {
    ...process.env
  }
  env.CODEX_HOME = codexHomePath
  if (config.proxy.enabled) {
    const httpProxy = `http://${config.proxy.host}:${config.proxy.port}`
    const socksProxy = `socks5://${config.proxy.host}:${config.proxy.port}`
    env.HTTP_PROXY = httpProxy
    env.http_proxy = httpProxy
    env.HTTPS_PROXY = httpProxy
    env.https_proxy = httpProxy
    env.ALL_PROXY = socksProxy
    env.all_proxy = socksProxy
    const noProxy = [
      'localhost',
      '127.0.0.1',
      '::1',
      config.server.host
    ].filter((value, index, values) => values.indexOf(value) === index).join(',')
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  const binPaths = [
    join(process.cwd(), 'node_modules', '.bin'),
    resolve(process.cwd(), 'node_modules', '.bin')
  ]
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${binPaths.join(delimiter)}${delimiter}${env[pathKey] ?? ''}`
  return env
}
