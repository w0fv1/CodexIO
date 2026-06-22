import { ChannelFile, ChannelMessage } from './Channel.js'
import { FileStore } from '../component/FileStore.js'

const markdownImagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const localImagePathPattern = /(?:[A-Za-z]:[\\/][^\r\n"'<>|?*]+?\.(?:png|jpe?g|webp|gif)|\/[^\r\n"'<>]+?\.(?:png|jpe?g|webp|gif))/gi

export async function normalizeChannelMessageFiles(message: ChannelMessage, fileStore: FileStore): Promise<ChannelMessage> {
  const files = new Map<string, ChannelFile>()
  for (const file of message.files ?? []) {
    files.set(file.id, file)
  }
  const importedPaths = new Map<string, ChannelFile>()
  const text = cleanText(await replaceLocalImagePaths(await replaceMarkdownImages(message.text, fileStore, files, importedPaths), fileStore, files, importedPaths))
  return {
    ...message,
    text,
    files: files.size > 0 ? [...files.values()] : undefined
  }
}

async function replaceMarkdownImages(text: string, fileStore: FileStore, files: Map<string, ChannelFile>, importedPaths: Map<string, ChannelFile>): Promise<string> {
  return replaceAsync(text, markdownImagePattern, async (_match, alt: string, url: string) => {
    const file = await resolveImageReference(url, fileStore, importedPaths)
    if (file) {
      files.set(file.id, file)
      return ''
    }
    return alt.trim().length > 0 ? `${alt} ${url}` : url
  })
}

async function replaceLocalImagePaths(text: string, fileStore: FileStore, files: Map<string, ChannelFile>, importedPaths: Map<string, ChannelFile>): Promise<string> {
  return replaceAsync(text, localImagePathPattern, async (match) => {
    const file = await resolveImageReference(match, fileStore, importedPaths)
    if (!file) {
      return match
    }
    files.set(file.id, file)
    return ''
  })
}

async function resolveImageReference(value: string, fileStore: FileStore, importedPaths: Map<string, ChannelFile>): Promise<ChannelFile | undefined> {
  const urlFile = fileStore.resolveUrl(value)
  if (urlFile) {
    return urlFile
  }
  if (/^https?:\/\//i.test(value)) {
    return undefined
  }
  const path = value.replaceAll('/', '\\')
  const existing = importedPaths.get(path)
  if (existing) {
    return existing
  }
  try {
    const file = await fileStore.importPath(path)
    importedPaths.set(path, file)
    return file
  } catch {
    return undefined
  }
}

async function replaceAsync(text: string, pattern: RegExp, replace: (...matches: string[]) => Promise<string>): Promise<string> {
  const parts: string[] = []
  let lastIndex = 0
  pattern.lastIndex = 0
  for (;;) {
    const match = pattern.exec(text)
    if (!match) {
      break
    }
    parts.push(text.slice(lastIndex, match.index))
    parts.push(await replace(...match))
    lastIndex = match.index + match[0].length
  }
  parts.push(text.slice(lastIndex))
  return parts.join('')
}

function cleanText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
