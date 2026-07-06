import { WebSocket } from 'ws'
import { Result } from '../../value/Result.js'

export type NfircoThreadCredentials = {
  baseUrl: string
  account: string
  password: string
}

export type NfircoThreadAttachment = {
  id: string
  name: string
  mime?: string
  size?: number
  url: string
}

export type NfircoThreadUploadFileUrl = {
  id: number
  filename?: string
  originalFilename?: string
  size?: number
  uploadUrl: string
  downloadUrl?: string
}

export type NfircoThreadCreateMessageInput = {
  text: string
  requestId: string
  fileIds?: number[]
  imageIds?: number[]
}

export type NfircoThreadMessageEvent = {
  type: 'thread.message.created'
  eventId: string
  threadUuid: string
  section?: string
  messageUuid: string
  text: string
  files: NfircoThreadAttachment[]
  images: NfircoThreadAttachment[]
}

export type NfircoThreadCreatedEvent = {
  type: 'thread.created'
  eventId: string
  threadUuid: string
  section?: string
  text: string
  files: NfircoThreadAttachment[]
  images: NfircoThreadAttachment[]
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

export async function createNfircoThreadMessage(credentials: NfircoThreadCredentials, threadUuid: string, input: NfircoThreadCreateMessageInput): Promise<Result<unknown>> {
  const response = await fetch(`${toHttpBaseUrl(credentials.baseUrl)}/api/threadio/thread/${encodeURIComponent(threadUuid)}/message`, {
    method: 'POST',
    headers: {
      ...credentialsHeaders(credentials),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requestId: input.requestId,
      text: input.text,
      fileIds: input.fileIds ?? [],
      imageIds: input.imageIds ?? []
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

export async function generateNfircoThreadUploadUrl(credentials: NfircoThreadCredentials, file: { mime: string, name: string, size: number }): Promise<Result<NfircoThreadUploadFileUrl>> {
  const response = await fetch(`${toHttpBaseUrl(credentials.baseUrl)}/api/threadio/file/upload-url`, {
    method: 'POST',
    headers: {
      ...credentialsHeaders(credentials),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      mimeType: file.mime,
      originalFilename: file.name,
      size: file.size
    })
  })
  const body = await readJson(response)
  if (!response.ok) {
    return Result.fail(readResponseMessage(body, `nfirco thread upload url failed: ${response.status}`))
  }
  if (isFailedResponse(body)) {
    return Result.fail(readResponseMessage(body, 'nfirco thread upload url failed'))
  }
  const data = readResponseData(body)
  if (!isUploadFileUrl(data)) {
    return Result.fail('nfirco thread upload url response invalid')
  }
  return Result.success(data)
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
  const files = readAttachments(record.files)
  const images = readAttachments(record.images)
  if (threadUuid.length === 0 || (text.trim().length === 0 && files.length === 0 && images.length === 0)) {
    return undefined
  }
  if (type === 'thread.created') {
    return {
      type,
      eventId: typeof record.eventId === 'string' && record.eventId.trim().length > 0 ? record.eventId.trim() : threadUuid,
      threadUuid,
      section: typeof record.section === 'string' && record.section.trim().length > 0 ? record.section.trim() : undefined,
      text,
      files,
      images
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
    text,
    files,
    images
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
    Authorization: `Basic ${Buffer.from(`${credentials.account.trim()}:${credentials.password}`, 'utf8').toString('base64')}`
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

function readResponseData(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return (value as Record<string, unknown>).data
}

function isUploadFileUrl(value: unknown): value is NfircoThreadUploadFileUrl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return typeof record.id === 'number'
    && typeof record.uploadUrl === 'string'
    && record.uploadUrl.trim().length > 0
}

function readAttachments(value: unknown): NfircoThreadAttachment[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item): NfircoThreadAttachment[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return []
    }
    const record = item as Record<string, unknown>
    const url = readString(record.url)
    if (!url) {
      return []
    }
    const idValue = record.id
    let id = url
    if (typeof idValue === 'string' && idValue.trim().length > 0) {
      id = idValue.trim()
    }
    if (typeof idValue === 'number' && Number.isFinite(idValue)) {
      id = String(idValue)
    }
    const originalFilename = readString(record.originalFilename)
    const filename = readString(record.filename)
    const mime = readString(record.mimeType)
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined
    return [{
      id,
      name: originalFilename ?? filename ?? id,
      mime,
      size,
      url
    }]
  })
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const text = value.trim()
  if (text.length === 0) {
    return undefined
  }
  return text
}
