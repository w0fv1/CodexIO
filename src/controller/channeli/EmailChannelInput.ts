import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { inject, injectable } from 'inversify'
import { CodexioConfig } from '../../value/ConfigDefinition.js'
import { Result } from '../../value/Result.js'
import { Logger } from '../../component/Logger.js'
import { Configer } from '../../component/Configer.js'
import { ChannelInput, ChannelInputReceiver } from './ChannelInput.js'

type EmailChannelInputConfig = CodexioConfig['channeli']['email']

@injectable()
export class EmailChannelInput implements ChannelInput {
  readonly type = 'email'
  private inputConfig?: EmailChannelInputConfig
  private imap?: ImapFlow
  private receiver?: ChannelInputReceiver
  private polling = false
  private stopped = false

  constructor(
    @inject(Configer) private readonly configer: Configer
  ) {}

  async start(receiver: ChannelInputReceiver): Promise<boolean> {
    this.inputConfig = await this.configer.get('channeli.email')
    if (!this.inputConfig?.enabled) {
      return false
    }
    if (!this.inputConfig?.user) {
      throw new Error('email user is required')
    }
    if (!this.inputConfig.account?.imap?.host || !this.inputConfig.account.imap.user || !this.inputConfig.account.imap.password) {
      throw new Error('email imap config is required')
    }
    this.receiver = receiver
    this.stopped = false
    Logger.info('email imap input starting', {
      user: this.inputConfig.user,
      imapHost: this.inputConfig.account.imap.host
    })
    void this.run().catch((error) => {
      Logger.error('email imap input failed', error)
    })
    return true
  }

  async stop(): Promise<Result<void>> {
    this.stopped = true
    Logger.info('email imap input stopping')
    try {
      await this.imap?.logout()
    } catch (error) {
      Logger.error('email imap input stop failed', error)
      return Result.fromError(error)
    } finally {
      this.imap = undefined
      this.receiver = undefined
    }
    return Result.successVoid()
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.poll()
        if (this.stopped) {
          return
        }
        if (this.inputConfig?.idle === false) {
          await new Promise((resolve) => {
            setTimeout(resolve, (this.inputConfig?.pollSeconds ?? 30) * 1000)
          })
          continue
        }
        const imap = await this.ensureImap()
        await imap.idle()
      } catch (error) {
        Logger.error('email imap loop failed', error)
        this.imap = undefined
        await new Promise((resolve) => {
          setTimeout(resolve, (this.inputConfig?.pollSeconds ?? 30) * 1000)
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
      await imap.mailboxOpen(this.inputConfig?.account?.imap?.mailbox ?? 'INBOX')
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
        const mailbox = this.inputConfig?.account?.imap?.user ?? this.inputConfig?.user ?? 'mailbox'
        const emailKeys = [
          root.trim().length > 0 ? `${mailbox}:root:${root.trim()}` : '',
          parsed.messageId?.trim() ? `${mailbox}:message:${parsed.messageId.trim()}` : ''
        ].filter((value) => value.length > 0)
        const emailThreadIds = (emailKeys.length > 0 ? emailKeys : [
          `${mailbox}:mailbox`
        ]).map((id) => ({
          source: 'email' as const,
          id
        }))
        const senderList = parsed.from?.value.map((address) => address.address).filter((address): address is string => Boolean(address)) ?? []
        const allowedSender = this.inputConfig?.user?.trim().toLowerCase()
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
          const receiver = this.receiver
          if (!receiver) {
            Logger.warn('email message receive failed', {
              uid: message.uid,
              message: 'email channel is disabled'
            })
            continue
          }
          const result = await receiver.receive('email', {
            platformThreadIds: emailThreadIds as [typeof emailThreadIds[number], ...typeof emailThreadIds[number][]],
            text
          })
          if (result.isFailed) {
            Logger.warn('email message receive failed', {
              uid: message.uid,
              message: result.message
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
      host: this.inputConfig?.account?.imap?.host ?? '',
      port: this.inputConfig?.account?.imap?.port ?? 993,
      secure: this.inputConfig?.account?.imap?.secure ?? true,
      disableAutoIdle: true,
      maxIdleTime: (this.inputConfig?.pollSeconds ?? 30) * 1000,
      auth: {
        user: this.inputConfig?.account?.imap?.user ?? '',
        pass: this.inputConfig?.account?.imap?.password ?? ''
      },
      logger: false
    })
    this.imap.on('error', (error) => {
      Logger.error('email imap failed', error)
      this.imap = undefined
    })
    await this.imap.connect()
    Logger.info('email imap connected', {
      host: this.inputConfig?.account?.imap?.host,
      mailbox: this.inputConfig?.account?.imap?.mailbox ?? 'INBOX'
    })
    return this.imap
  }
}
