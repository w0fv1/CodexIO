import { WebSocket } from 'ws'
import { Result } from '../../value/Result.js'

export type NfircoThreadCredentials = {
  baseUrl: string
  account: string
  password: string
}

export type NfircoThreadMessageEvent = {
  type: 'thread.message.created'
  eventId: string
  threadUuid: string
  section?: string
  messageUuid: string
  text: string
}

export type NfircoThreadCreatedEvent = {
  type: 'thread.created'
  eventId: string
  threadUuid: string
  section?: string
  text: string
}

export type NfircoThreadInputEvent = NfircoThreadMessageEvent | NfircoThreadCreatedEvent

export type NfircoThreadSocketEvent = NfircoThreadInputEvent | {
  type: string
  [key: string]: unknown
}

export function openNfircoThreadSocket(credentials: NfircoThreadCredentials): WebSocket {
  return new WebSocket(`${toWsBaseUrl(credentials.baseUrl)}/api/threadio/ws`, {
    headers: credentialsHeaders(credentials)
  })
}

export async function createNfircoThreadMessage(credentials: NfircoThreadCredentials, threadUuid: string, text: string, requestId: string): Promise<Result<unknown>> {
  const response = await fetch(`${toHttpBaseUrl(credentials.baseUrl)}/api/threadio/thread/${encodeURIComponent(threadUuid)}/message`, {
    method: 'POST',
    headers: {
      ...credentialsHeaders(credentials),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requestId,
      text
    })
  })
  const body = await readJson(response)
  if (!response.ok) {
    return Result.fail(readResponseMessage(body, `nfirco thread message send failed: ${response.status}`))
  }
  if (isFailedResponse(body)) {
    return Result.fail(readResponseMessage(body, 'nfirco thread message send failed'))
  }
  return Result.success(body)
}

export function parseNfircoThreadSocketEvent(value: unknown): NfircoThreadSocketEvent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (type.length === 0) {
    return undefined
  }
  if (type !== 'thread.message.created' && type !== 'thread.created') {
    return {
      type,
      ...record
    }
  }
  const threadUuid = typeof record.threadUuid === 'string' ? record.threadUuid.trim() : ''
  const text = typeof record.text === 'string' ? record.text : ''
  if (threadUuid.length === 0 || text.trim().length === 0) {
    return undefined
  }
  if (type === 'thread.created') {
    return {
      type,
      eventId: typeof record.eventId === 'string' && record.eventId.trim().length > 0 ? record.eventId.trim() : threadUuid,
      threadUuid,
      section: typeof record.section === 'string' && record.section.trim().length > 0 ? record.section.trim() : undefined,
      text
    }
  }
  const messageUuid = typeof record.messageUuid === 'string' ? record.messageUuid.trim() : ''
  if (messageUuid.length === 0) {
    return undefined
  }
  return {
    type,
    eventId: typeof record.eventId === 'string' && record.eventId.trim().length > 0 ? record.eventId.trim() : messageUuid,
    threadUuid,
    section: typeof record.section === 'string' && record.section.trim().length > 0 ? record.section.trim() : undefined,
    messageUuid,
    text
  }
}

export function isNfircoThreadInputEvent(event: NfircoThreadSocketEvent | undefined): event is NfircoThreadInputEvent {
  return event !== undefined && (event.type === 'thread.message.created' || event.type === 'thread.created')
}

export function normalizeNfircoThreadCredentials(credentials: NfircoThreadCredentials): NfircoThreadCredentials {
  return {
    baseUrl: toHttpBaseUrl(credentials.baseUrl),
    account: credentials.account.trim(),
    password: credentials.password
  }
}

function credentialsHeaders(credentials: NfircoThreadCredentials): Record<string, string> {
  return {
    'Threadio-Account': credentials.account.trim(),
    'Threadio-Password': credentials.password
  }
}

function toHttpBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (normalized.startsWith('ws://')) {
    return `http://${normalized.slice(5)}`
  }
  if (normalized.startsWith('wss://')) {
    return `https://${normalized.slice(6)}`
  }
  return normalized
}

function toWsBaseUrl(value: string): string {
  const normalized = toHttpBaseUrl(value)
  if (normalized.startsWith('https://')) {
    return `wss://${normalized.slice(8)}`
  }
  if (normalized.startsWith('http://')) {
    return `ws://${normalized.slice(7)}`
  }
  return normalized
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.trim().length === 0) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function isFailedResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return record.success === false || record.isFailed === true || record.code === '-1'
}

function readResponseMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const message = (value as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }
  return fallback
}
