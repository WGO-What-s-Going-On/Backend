import { createPost } from '../domain/post.js';
import {
  CAT_CONTEST_COPY,
  CAT_CONTEST_EXPIRES_AT,
  CAT_CONTEST_LOCATION,
  CAT_CONTEST_POST_ID,
} from '../domain/cat-contest.js';
import { CAMPUS_POLICY, CAMPUS_POST_IDS } from '../domain/campus-events.js';
import { UniqueConflictError } from './errors.js';
import { event } from './event.js';
import type { PostUnitOfWork } from './ports.js';
import type { CampusCreationInput } from './create-campus-events.js';

// Reuses the Post transaction/outbox path without updating any of the five existing IDs.
export async function createCatContest(
  store: PostUnitOfWork,
  input: CampusCreationInput,
  dryRun = true,
  now = new Date(),
) {
  if (
    input.authorId !== 1 ||
    input.latitude !== CAT_CONTEST_LOCATION.latitude ||
    input.longitude !== CAT_CONTEST_LOCATION.longitude
  )
    throw new Error('Verified cat contest author/location required');
  const deadline = new Date(CAT_CONTEST_EXPIRES_AT);
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.execute(async ({ queries, commands }) => {
        const existing = await queries.findPost(CAT_CONTEST_POST_ID);
        if (existing) {
          if (
            existing.authorId !== 1 ||
            existing.title !== CAT_CONTEST_COPY.title ||
            existing.content !== CAT_CONTEST_COPY.content ||
            existing.category !== 'NEWS' ||
            existing.radiusM !== 350 ||
            existing.locationSnapshot?.latitude !== input.latitude ||
            existing.locationSnapshot.longitude !== input.longitude ||
            existing.lifecyclePolicy !== CAMPUS_POLICY ||
            existing.expiresAt?.getTime() !== deadline.getTime() ||
            existing.voteStatus !== 'NONE'
          )
            throw new Error(
              'Reserved cat contest identity conflicts; no data changed',
            );
          return [
            {
              postId: existing.postId,
              created: false,
              status: existing.status,
              expiresAt: existing.expiresAt,
            },
          ];
        }
        if (now >= deadline) throw new Error('Cat contest deadline has passed');
        // The exact common deadline is checked against both originals in the creation snapshot.
        for (const id of CAMPUS_POST_IDS) {
          const original = await queries.findPost(id);
          if (
            !original ||
            original.status !== 'ACTIVE' ||
            original.authorId !== 1 ||
            original.category !== 'NEWS' ||
            original.radiusM !== 350 ||
            original.lifecyclePolicy !== CAMPUS_POLICY ||
            original.voteStatus !== 'NONE' ||
            original.expiresAt?.getTime() !== deadline.getTime() ||
            original.locationSnapshot?.latitude !== 37.5047225 ||
            original.locationSnapshot.longitude !== 126.9565323
          )
            throw new Error(
              'Original campus events do not match the verified common deadline/settings',
            );
        }
        const post = {
          ...createPost(
            {
              ...CAT_CONTEST_COPY,
              category: 'NEWS',
              ...CAT_CONTEST_LOCATION,
              radiusM: 350,
            },
            1,
            CAT_CONTEST_POST_ID,
            now,
          ),
          lifecyclePolicy: CAMPUS_POLICY,
          region: input.region,
          expiresAt: deadline,
        };
        if (!dryRun) {
          await commands.insertPost(post);
          await commands.scheduleExpiration(post.postId, deadline, now);
          await commands.appendEvent(
            event(
              post.postId,
              'PostCreated',
              {
                post: {
                  postId: post.postId,
                  ...CAT_CONTEST_COPY,
                  authorId: 1,
                  category: 'NEWS',
                  ...CAT_CONTEST_LOCATION,
                  radiusM: 350,
                  expiresAt: deadline,
                  lifecyclePolicy: CAMPUS_POLICY,
                },
                postVersion: 1,
              },
              now,
            ),
          );
        }
        return [
          {
            postId: post.postId,
            created: !dryRun,
            status: post.status,
            expiresAt: deadline,
          },
        ];
      });
    } catch (error) {
      if (error instanceof UniqueConflictError && attempt < 2) continue;
      throw error;
    }
  }
}
