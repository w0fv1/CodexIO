import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { CodexioConfig } from '../config/ConfigDefinition.js'
import { codexioRootPath } from '../AppMetadata.js'

export const codexHomePath = join(codexioRootPath, '.codexio', 'codex')
export const codexConfigPath = join(codexHomePath, 'config.toml')

type ProxyEnv = {
  httpProxy: string
  noProxy: string
}

export type AgentEnvOptions = {
  codexio?: {
    apiUrl: string
    token: string
  }
}

export function createAgentEnv(config: CodexioConfig, options: AgentEnvOptions = {}): NodeJS.ProcessEnv {
  const env = {
    ...process.env
  }
  if (options.codexio) {
    env.CODEXIO_API_URL = options.codexio.apiUrl
    env.CODEXIO_TOKEN = options.codexio.token
  }
  const bundledCodex = config.agents.codex?.bundled ?? true
  if (bundledCodex) {
    mkdirSync(codexHomePath, {
      recursive: true
    })
    env.CODEX_HOME = codexHomePath
  }
  if (config.proxy.enabled) {
    const proxyEnv = {
      httpProxy: `http://${config.proxy.host}:${config.proxy.port}`,
      noProxy: [
        'localhost',
        '127.0.0.1',
        '::1',
        config.server.host
      ].filter((value, index, values) => values.indexOf(value) === index).join(',')
    }
    env.HTTP_PROXY = proxyEnv.httpProxy
    env.http_proxy = proxyEnv.httpProxy
    env.HTTPS_PROXY = proxyEnv.httpProxy
    env.https_proxy = proxyEnv.httpProxy
    env.ALL_PROXY = proxyEnv.httpProxy
    env.all_proxy = proxyEnv.httpProxy
    env.NO_PROXY = proxyEnv.noProxy
    env.no_proxy = proxyEnv.noProxy
    if (bundledCodex) {
      syncCodexConfig(proxyEnv, options)
    }
  } else {
    if (bundledCodex) {
      syncCodexConfig(undefined, options)
    }
  }
  const binPaths = [
    join(process.cwd(), 'node_modules', '.bin'),
    resolve(process.cwd(), 'node_modules', '.bin')
  ]
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = `${binPaths.join(delimiter)}${delimiter}${env[pathKey] ?? ''}`
  return env
}

export function syncCodexConfig(proxyEnv: ProxyEnv | undefined, options: AgentEnvOptions = {}): void {
  const set: Record<string, string> = proxyEnv ? {
    HTTP_PROXY: proxyEnv.httpProxy,
    http_proxy: proxyEnv.httpProxy,
    HTTPS_PROXY: proxyEnv.httpProxy,
    https_proxy: proxyEnv.httpProxy,
    ALL_PROXY: proxyEnv.httpProxy,
    all_proxy: proxyEnv.httpProxy,
    NO_PROXY: proxyEnv.noProxy,
    no_proxy: proxyEnv.noProxy
  } : {}
  if (options.codexio) {
    set.CODEXIO_API_URL = options.codexio.apiUrl
    set.CODEXIO_TOKEN = options.codexio.token
  }
  const entries = Object.entries(set).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
  const text = [
    '[shell_environment_policy]',
    'inherit = "all"',
    `set = { ${entries.join(', ')} }`,
    ''
  ].join('\n')
  writeFileSync(codexConfigPath, text, 'utf8')
}
