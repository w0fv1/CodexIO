import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer, { Transporter } from 'nodemailer'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../value/ConfigDefinition.js'
import { Message } from '../value/Message.js'
import { Result } from '../value/Result.js'
import { Logger } from '../component/Logger.js'
import { ThreadBinder } from '../value/ThreadBinder.js'
import { Configer } from '../component/Configer.js'
import { ChannelInput, ChannelInputReceive, ChannelOutput, ChannelOutputContext } from './Channel.js'

type EmailChannelConfig = CodexioConfig['channels']['email']

@injectable()
export class EmailChannelHub {
  private config?: EmailChannelConfig
  private imap?: ImapFlow
  private smtp?: Transporter
  private polling = false
  private stopped = false
  private readonly threads = new ThreadBinder()

  constructor(@inject(Configer) private readonly configer: Configer) {}

  async startOutput(): Promise<boolean> {
    this.config = await this.configer.get('channels.email')
    if (!this.config?.enabled) {
      return false
    }
    if (!this.config?.user) {
      throw new Error('email user is required')
    }
    if (!this.config.agent.smtp?.host || !this.config.agent.smtp.user || !this.config.agent.smtp.password) {
      throw new Error('email smtp config is required')
    }
    Logger.info('email output starting', {
      user: this.config.user,
      smtpHost: this.config.agent.smtp.host
    })
    this.smtp = nodemailer.createTransport({
      host: this.config.agent.smtp.host,
      port: this.config.agent.smtp.port,
      secure: this.config.agent.smtp.secure,
      auth: {
        user: this.config.agent.smtp.user,
        pass: this.config.agent.smtp.password
      }
    })
    return true
  }

  async startInput(receive: ChannelInputReceive): Promise<boolean> {
    this.config = await this.configer.get('channels.email')
    if (!this.config?.enabled) {
      return false
    }
    if (!this.config?.user) {
      throw new Error('email user is required')
    }
    if (!this.config.agent?.imap?.host || !this.config.agent.imap.user || !this.config.agent.imap.password) {
      throw new Error('email imap config is required')
    }
    await this.startOutput()
    this.stopped = false
    Logger.info('email input starting', {
      user: this.config.user,
      imapHost: this.config.agent.imap.host
    })
    void this.run(receive).catch((error) => {
      Logger.error('email input failed', error)
    })
    return true
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    if (message.role === 'user' && context?.inputType === 'email') {
      return Result.successVoid()
    }
    if (!this.smtp) {
      return Result.fail('email smtp not ready')
    }
    if (message.text.trim().length === 0 && (!message.files || message.files.length === 0)) {
      return Result.fail('text or file is required')
    }
    const recipient = this.config?.user?.trim() ?? ''
    if (recipient.length === 0) {
      return Result.fail('email user is required')
    }
    let text = message.text
    const fileText = (message.files ?? [])
      .map((file) => file.url ?? file.path)
      .filter((value) => value.trim().length > 0)
      .join('\n')
    if (text.trim().length > 0 && fileText.length > 0) {
      text = `${text}\n\n${fileText}`
    } else if (fileText.length > 0) {
      text = fileText
    }
    const subject = message.role === 'agent' ? 'Agent' : message.role === 'user' ? 'User' : 'System'
    const trimmedFrom = this.config?.agent?.smtp?.from?.trim()
    const trimmedUser = this.config?.agent?.smtp?.user?.trim()
    const from = trimmedFrom && trimmedFrom.includes('@')
      ? trimmedFrom
      : trimmedFrom && trimmedUser && trimmedUser.includes('@')
        ? {
            name: trimmedFrom,
            address: trimmedUser
          }
        : trimmedUser || trimmedFrom
    try {
      Logger.info('email send started', {
        role: message.role,
        inputType: context?.inputType ?? null,
        subject,
        length: text.length
      })
      await this.smtp.sendMail({
        from,
        to: recipient,
        subject,
        text,
        attachments: message.files?.map((file) => ({
          filename: file.name,
          path: file.path,
          contentType: file.mime
        }))
      })
      Logger.info('email send completed', {
        role: message.role,
        subject
      })
      return Result.successVoid()
    } catch (error) {
      Logger.error('email send failed', error)
      return Result.fromError(error)
    }
  }

  async stop(): Promise<Result<void>> {
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
    return Result.successVoid()
  }

  private async run(receive: ChannelInputReceive): Promise<void> {
    while (!this.stopped) {
      try {
        await this.poll(receive)
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

  private async poll(receive: ChannelInputReceive): Promise<void> {
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
        const references = Array.isArray(parsed.references) ? parsed.references : typeof parsed.references === 'string' ? [
          parsed.references
        ] : []
        const root = references.find((item) => item.trim().length > 0) ?? parsed.inReplyTo ?? parsed.messageId ?? ''
        const mailbox = this.config?.agent?.imap?.user ?? this.config?.user ?? 'mailbox'
        const emailKeys = [
          root.trim().length > 0 ? `${mailbox}:root:${root.trim()}` : '',
          parsed.messageId?.trim() ? `${mailbox}:message:${parsed.messageId.trim()}` : ''
        ].filter((value) => value.length > 0)
        const ioThreadId = this.threads.resolveOrCreate(emailKeys.length > 0 ? emailKeys : [
          `${mailbox}:mailbox`
        ])
        const senderList = parsed.from?.value.map((address) => address.address).filter((address): address is string => Boolean(address)) ?? []
        const allowedSender = this.config?.user?.trim().toLowerCase()
        if (!allowedSender || !senderList.some((item) => item.trim().toLowerCase() === allowedSender)) {
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
        if (text.trim().length > 0) {
          Logger.info('email message received', {
            uid: message.uid,
            length: text.length
          })
          const result = await receive({
            ioThreadId,
            role: 'user',
            text
          })
          if (result.isFailed) {
            Logger.warn('email message receive failed', {
              uid: message.uid,
              message: result.message
            })
            await this.send({
              ioThreadId,
              role: 'system',
              text: result.message
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
}

@injectable()
export class EmailChannelInput implements ChannelInput {
  readonly type = 'email'

  constructor(@inject(EmailChannelHub) private readonly hub: EmailChannelHub) {}

  async start(receive: ChannelInputReceive): Promise<boolean> {
    return this.hub.startInput(receive)
  }

  async stop(): Promise<Result<void>> {
    return this.hub.stop()
  }
}

@injectable()
export class EmailChannelOutput implements ChannelOutput {
  readonly type = 'email'

  constructor(@inject(EmailChannelHub) private readonly hub: EmailChannelHub) {}

  async start(): Promise<boolean> {
    return this.hub.startOutput()
  }

  async send(message: Message, context?: ChannelOutputContext): Promise<Result<void>> {
    return this.hub.send(message, context)
  }

  async stop(): Promise<Result<void>> {
    return this.hub.stop()
  }
}
