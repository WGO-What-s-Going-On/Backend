import { Injectable } from '@nestjs/common';
import type { ParticipationAuthorization } from '../application/ports.js';
import { ParticipationUnavailableError } from '../application/errors.js';

@Injectable()
export class LocalParticipationAuthorization implements ParticipationAuthorization {
  async assertCanJoin(_postId: string, _userId: number): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new ParticipationUnavailableError('Map participation authorization unavailable');
    }
  }
}
