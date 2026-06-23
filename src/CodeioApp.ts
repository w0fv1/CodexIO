import { inject, injectable } from 'inversify'
import { CodexioMetadata } from './component/CodexioMetadata.js'

@injectable()
export class CodeioApp {
  constructor(@inject(CodexioMetadata) readonly metadata: CodexioMetadata) {}
}
