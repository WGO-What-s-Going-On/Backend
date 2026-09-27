import { describe, expect, it, vi } from 'vitest';
import { CreatePost, JoinPost } from '../src/post/application/commands.js';
import type {
  LocationAuthorization,
  PostUnitOfWork,
  PostStateQueries,
} from '../src/post/application/ports.js';
import {
  LocationDeniedError,
  ParticipationUnavailableError,
} from '../src/post/application/errors.js';

const input = {
  title: 'Test',
  content: 'Details',
  category: 'INCIDENT',
  latitude: 37.5,
  longitude: 127,
  radiusM: 250,
};

describe('Map authorization before Post writes', () => {
  it.each([
    new LocationDeniedError('OUTSIDE_RADIUS'),
    new ParticipationUnavailableError('Map unavailable'),
  ])(
    'does not open a create transaction when Map rejects: %s',
    async (error) => {
      const execute = vi.fn();
      const authorization = {
        assertCanCreate: vi.fn().mockRejectedValue(error),
      } as unknown as LocationAuthorization;
      await expect(
        new CreatePost(
          { execute } as unknown as PostUnitOfWork,
          authorization,
        ).execute(input, 123),
      ).rejects.toBe(error);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('sends the stored post center and radius before opening a join transaction', async () => {
    const execute = vi.fn();
    const findPost = vi
      .fn()
      .mockResolvedValue({
        postId: 'post-1',
        status: 'ACTIVE',
        locationSnapshot: { latitude: 37.5, longitude: 127 },
        radiusM: 250,
      });
    const assertCanJoin = vi
      .fn()
      .mockRejectedValue(new LocationDeniedError('LOCATION_STALE'));
    const join = new JoinPost(
      { execute } as unknown as PostUnitOfWork,
      { findPost } as unknown as PostStateQueries,
      { assertCanJoin } as unknown as LocationAuthorization,
    );
    await expect(join.execute('post-1', 123)).rejects.toBeInstanceOf(
      LocationDeniedError,
    );
    expect(assertCanJoin).toHaveBeenCalledWith(123, 'post-1', 37.5, 127, 250);
    expect(execute).not.toHaveBeenCalled();
  });
});
