import {
  CAMPUS_CONTENT,
  CAMPUS_DURATION_MS,
  CAMPUS_POLICY,
  CAMPUS_POST_IDS,
} from '../domain/campus-events.js';
import { createPost, type PostRegion } from '../domain/post.js';
import type { PostUnitOfWork } from './ports.js';
import { UniqueConflictError } from './errors.js';
import { event } from './event.js';

export interface CampusCreationInput {
  authorId: number;
  latitude: number;
  longitude: number;
  region: PostRegion;
}

// Administrator-only application operation. Never expose through the public create API.
export async function createCampusEvents(
  store: PostUnitOfWork,
  input: CampusCreationInput,
  dryRun = true,
  now = new Date(),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.execute(async ({ queries, commands }) => {
        const result = [];
        for (const [index, postId] of CAMPUS_POST_IDS.entries()) {
          const copy = CAMPUS_CONTENT[index]!;
          const existing = await queries.findPost(postId);
          if (existing) {
            // Never repair or resurrect an occupied/expired identity on a retry.
            if (
              existing.lifecyclePolicy !== CAMPUS_POLICY ||
              existing.authorId !== input.authorId ||
              existing.title !== copy.title ||
              existing.content !== copy.content ||
              existing.category !== 'NEWS' ||
              existing.radiusM !== 350 ||
              existing.locationSnapshot?.latitude !== input.latitude ||
              existing.locationSnapshot.longitude !== input.longitude ||
              !existing.createdAt ||
              existing.expiresAt?.getTime() !==
                existing.createdAt.getTime() + CAMPUS_DURATION_MS ||
              existing.voteStatus !== 'NONE'
            )
              throw new Error(
                'Reserved campus post identity conflicts; no data changed',
              );
            result.push({
              postId,
              created: false,
              status: existing.status,
              expiresAt: existing.expiresAt,
            });
            continue;
          }
          const post = {
            ...createPost(
              {
                ...copy,
                category: 'NEWS',
                latitude: input.latitude,
                longitude: input.longitude,
                radiusM: 350,
              },
              input.authorId,
              postId,
              now,
            ),
            lifecyclePolicy: CAMPUS_POLICY,
            region: input.region,
            expiresAt: new Date(now.getTime() + CAMPUS_DURATION_MS),
          };
          if (!dryRun) {
            await commands.insertPost(post);
            await commands.scheduleExpiration(postId, post.expiresAt, now);
            await commands.appendEvent(
              event(
                postId,
                'PostCreated',
                {
                  post: {
                    postId,
                    ...copy,
                    authorId: input.authorId,
                    latitude: input.latitude,
                    longitude: input.longitude,
                    radiusM: 350,
                    category: 'NEWS',
                    expiresAt: post.expiresAt,
                    lifecyclePolicy: CAMPUS_POLICY,
                  },
                  postVersion: 1,
                },
                now,
              ),
            );
          }
          result.push({
            postId,
            created: !dryRun,
            status: post.status,
            expiresAt: post.expiresAt,
          });
        }
        return result;
      });
    } catch (error) {
      // Concurrent operators race on the same unique postId; re-read their committed result.
      if (error instanceof UniqueConflictError && attempt < 2) continue;
      throw error;
    }
  }
}
