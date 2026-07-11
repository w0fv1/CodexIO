export type DesktopRequest = {
  type: 'desktop.request'
  id: string
  command: 'setStartAtLogin'
  value: boolean
}

export type DesktopResponse = {
  type: 'desktop.response'
  id: string
  error?: string
}

export function isDesktopRequest(value: unknown): value is DesktopRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Partial<DesktopRequest>
  return message.type === 'desktop.request'
    && typeof message.id === 'string'
    && message.command === 'setStartAtLogin'
    && typeof message.value === 'boolean'
}

export function isDesktopResponse(value: unknown): value is DesktopResponse {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Partial<DesktopResponse>
  return message.type === 'desktop.response'
    && typeof message.id === 'string'
    && (message.error === undefined || typeof message.error === 'string')
}
