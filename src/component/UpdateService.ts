import { inject, injectable } from 'inversify'
import { Result } from '../value/Result.js'
import { UpdateInstaller } from './UpdateInstaller.js'

@injectable()
export class UpdateService {
  constructor(@inject(UpdateInstaller) private readonly updateInstaller: UpdateInstaller) {}

  async update(): Promise<Result<string>> {
    return this.updateInstaller.update()
  }
}
