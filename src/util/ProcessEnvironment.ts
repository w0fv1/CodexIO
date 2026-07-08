import { mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export function createProcessEnv(homePath?: string, shellEnvironmentPath?: string, proxyUrl?: string, noProxyHosts: string[] = [], variables: Record<string, string> = {}, includeLocalBin = true): NodeJS.ProcessEnv {
  const env = {
    ...process.env
  }
  for (const [key, value] of Object.entries(variables)) {
    env[key] = value
  }
  if (homePath) {
    mkdirSync(homePath, {
      recursive: true
    })
    env.CODEX_HOME = homePath
  }
  const noProxy = [...new Set(noProxyHosts)].join(',')
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl
    env.http_proxy = proxyUrl
    env.HTTPS_PROXY = proxyUrl
    env.https_proxy = proxyUrl
    env.ALL_PROXY = proxyUrl
    env.all_proxy = proxyUrl
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  if (shellEnvironmentPath) {
    syncShellEnvironmentConfig(shellEnvironmentPath, proxyUrl, noProxy, variables)
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  if (includeLocalBin) {
    const binPaths = [
      join(process.cwd(), 'node_modules', '.bin'),
      resolve(process.cwd(), 'node_modules', '.bin')
    ]
    env[pathKey] = `${binPaths.join(delimiter)}${delimiter}${env[pathKey] ?? ''}`
  }
  return env
}

export function syncShellEnvironmentConfig(path: string, proxyUrl?: string, noProxy = '', variables: Record<string, string> = {}): void {
  const set: Record<string, string> = proxyUrl ? {
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy
  } : {}
  Object.assign(set, variables)
  const entries = Object.entries(set).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
  const text = [
    '[shell_environment_policy]',
    'inherit = "all"',
    `set = { ${entries.join(', ')} }`,
    ''
  ].join('\n')
  writeFileSync(path, text, 'utf8')
}
