import { CodexioConfig } from '../config/ConfigSchema.js'

export function buildAgentEnv(config: CodexioConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (config.proxy.enabled) {
    if (config.proxy.http) {
      env.HTTP_PROXY = config.proxy.http
      env.http_proxy = config.proxy.http
    }
    if (config.proxy.https) {
      env.HTTPS_PROXY = config.proxy.https
      env.https_proxy = config.proxy.https
    }
    if (config.proxy.socks) {
      env.ALL_PROXY = config.proxy.socks
      env.all_proxy = config.proxy.socks
    }
    if (config.proxy.noProxy.length > 0) {
      env.NO_PROXY = config.proxy.noProxy.join(',')
      env.no_proxy = config.proxy.noProxy.join(',')
    }
  }
  return env
}
