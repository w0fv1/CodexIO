import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer, { Transporter } from 'nodemailer'
import { Channel, ChannelMessage, ChannelStartInput } from './Channel.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'

type EmailMessagePayload = {
  subject: string
  text: string
}

type EmailAddress = {
  name?: string
  address: string
}

type EmailServerConfig = {
  host?: string
  port?: number
  secure?: boolean
  user?: string
  password?: string
}

export type EmailChannelConfig = {
  enabled?: boolean
  user?: string
  agent?: {
    imap?: EmailServerConfig & {
      mailbox?: string
    }
    smtp?: EmailServerConfig & {
      from?: string
    }
  }
  idle?: boolean
  pollSeconds?: number
}

export function createEmailSender(from: string | undefined, user: string | undefined): string | EmailAddress | undefined {
  const trimmedFrom = from?.trim()
  const trimmedUser = user?.trim()
  if (trimmedFrom && trimmedFrom.includes('@')) {
    return trimmedFrom
  }
  if (trimmedFrom && trimmedUser && trimmedUser.includes('@')) {
    return {
      name: trimmedFrom,
      address: trimmedUser
    }
  }
  if (trimmedUser) {
    return trimmedUser
  }
  return trimmedFrom
}

export function isAllowedEmailSender(from: string[], user: string | undefined): boolean {
  const trimmedUser = user?.trim().toLowerCase()
  if (!trimmedUser) {
    return false
  }
  return from.some((item) => item.trim().toLowerCase() === trimmedUser)
}

export function createEmailMessagePayload(message: ChannelMessage): EmailMessagePayload {
  let text = message.text
  if (message.role === 'system' && message.text === 'clear') {
    text = '已开始新对话'
  }
  if (message.role === 'user') {
    text = `${text}\n\nUser`
  }
  if (message.role === 'agent') {
    return {
      subject: 'Agent',
      text
    }
  }
  if (message.role === 'user') {
    return {
      subject: 'User',
      text
    }
  }
  return {
    subject: 'System',
    text
  }
}

export class EmailChannelAdapter implements Channel {
  readonly type = 'email'
  private input?: ChannelStartInput
  private imap?: ImapFlow
  private smtp?: Transporter
  private polling = false
  private stopped = false

  constructor(private readonly config?: EmailChannelConfig) {}

  start(input: ChannelStartInput): void {
    this.input = input
    this.assertConfig()
    Logger.info('email channel starting', {
      user: this.config?.user,
      imapHost: this.config?.agent?.imap?.host,
      smtpHost: this.config?.agent?.smtp?.host
    })
    this.smtp = nodemailer.createTransport({
      host: this.config?.agent?.smtp?.host,
      port: this.config?.agent?.smtp?.port,
      secure: this.config?.agent?.smtp?.secure,
      auth: {
        user: this.config?.agent?.smtp?.user,
        pass: this.config?.agent?.smtp?.password
      }
    })
    void this.run().catch((error) => {
      Logger.error('email channel failed', error)
    })
  }

  async send(message: ChannelMessage): Promise<Result<null>> {
    if (message.role === 'user' && message.source === this.type) {
      return Result.success(null)
    }
    if (!this.smtp) {
      return Result.fail('email smtp not ready')
    }
    if (message.text.trim().length === 0) {
      return Result.fail('text is required')
    }
    const recipient = this.config?.user?.trim() ?? ''
    if (recipient.length === 0) {
      return Result.fail('email user is required')
    }
    const payload = createEmailMessagePayload(message)
    try {
      Logger.info('email send started', {
        role: message.role,
        source: message.source ?? null,
        subject: payload.subject,
        length: payload.text.length
      })
      await this.smtp.sendMail({
        from: createEmailSender(this.config?.agent?.smtp?.from, this.config?.agent?.smtp?.user),
        to: recipient,
        subject: payload.subject,
        text: payload.text
      })
      Logger.info('email send completed', {
        role: message.role,
        subject: payload.subject
      })
      return Result.success(null)
    } catch (error) {
      Logger.error('email send failed', error)
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<null>> {
    this.stopped = true
    Logger.info('email channel stopping')
    try {
      await this.imap?.logout()
    } catch (error) {
      Logger.error('email channel stop failed', error)
      return Result.fromError(error)
    } finally {
      this.imap = undefined
    }
    return Result.success(null)
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.poll()
        if (this.stopped) {
          return
        }
        if (this.config?.idle === false) {
          await new Promise((resolve) => {
            setTimeout(resolve, (this.config?.pollSeconds ?? 30) * 1000)
          })
          continue
        }
        const imap = await this.ensureImap()
        await imap.idle()
      } catch (error) {
        Logger.error('email channel loop failed', error)
        this.imap = undefined
        await new Promise((resolve) => {
          setTimeout(resolve, (this.config?.pollSeconds ?? 30) * 1000)
        })
      }
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) {
      return
    }
    this.polling = true
    try {
      const imap = await this.ensureImap()
      await imap.mailboxOpen(this.config?.agent?.imap?.mailbox ?? 'INBOX')
      for await (const message of imap.fetch({
        seen: false
      }, {
        uid: true,
        source: true,
        envelope: true
      })) {
        if (!message.source) {
          continue
        }
        const parsed = await simpleParser(message.source)
        const senderList = parsed.from?.value.map((address) => address.address).filter((address): address is string => Boolean(address)) ?? []
        if (!isAllowedEmailSender(senderList, this.config?.user)) {
          Logger.info('email message ignored', {
            from: senderList
          })
          await imap.messageFlagsAdd([message.uid], ['\\Seen'], {
            uid: true
          })
          continue
        }
        const text = [
          parsed.subject ? `Subject: ${parsed.subject}` : '',
          parsed.from?.text ? `From: ${parsed.from.text}` : '',
          parsed.text?.trim() ?? ''
        ].filter((item) => item.trim().length > 0).join('\n\n')
        if (text.trim().length > 0 && this.input) {
          Logger.info('email message received', {
            uid: message.uid,
            length: text.length
          })
          const result = await this.input.receive(text)
          if (result.isFailed) {
            Logger.warn('email message receive failed', {
              uid: message.uid,
              message: result.message
            })
            await this.send({
              role: 'system',
              text: result.message,
              createdAt: Date.now(),
              source: this.type
            })
          }
        }
        await imap.messageFlagsAdd([message.uid], ['\\Seen'], {
          uid: true
        })
      }
    } finally {
      this.polling = false
    }
  }

  private async ensureImap(): Promise<ImapFlow> {
    if (this.imap) {
      return this.imap
    }
    this.imap = new ImapFlow({
      host: this.config?.agent?.imap?.host ?? '',
      port: this.config?.agent?.imap?.port ?? 993,
      secure: this.config?.agent?.imap?.secure ?? true,
      disableAutoIdle: true,
      maxIdleTime: (this.config?.pollSeconds ?? 30) * 1000,
      auth: {
        user: this.config?.agent?.imap?.user ?? '',
        pass: this.config?.agent?.imap?.password ?? ''
      },
      logger: false
    })
    this.imap.on('error', (error) => {
      Logger.error('email imap failed', error)
      this.imap = undefined
    })
    await this.imap.connect()
    Logger.info('email imap connected', {
      host: this.config?.agent?.imap?.host,
      mailbox: this.config?.agent?.imap?.mailbox ?? 'INBOX'
    })
    return this.imap
  }

  private assertConfig(): void {
    if (!this.config?.user) {
      throw new Error('email user is required')
    }
    if (!this.config.agent?.imap?.host || !this.config.agent.imap.user || !this.config.agent.imap.password) {
      throw new Error('email imap config is required')
    }
    if (!this.config.agent.smtp?.host || !this.config.agent.smtp.user || !this.config.agent.smtp.password) {
      throw new Error('email smtp config is required')
    }
  }
}
