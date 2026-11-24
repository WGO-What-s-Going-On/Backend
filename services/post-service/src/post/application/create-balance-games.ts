import { createHash } from 'node:crypto';
import {
  BALANCE_OPTION_IDS,
  BALANCE_POST_IDS,
  CAMPUS_DURATION_MS,
  CAMPUS_POLICY,
} from '../domain/campus-events.js';
import { createPost } from '../domain/post.js';
import type { CampusCreationInput } from './create-campus-events.js';
import type { PostUnitOfWork } from './ports.js';
import { UniqueConflictError } from './errors.js';
import { event } from './event.js';

export interface BalanceGameCopy {
  title: string;
  content: string;
  choices: [string, string];
}

export function validateBalanceGames(raw: unknown): BalanceGameCopy[] {
  if (!Array.isArray(raw) || raw.length !== 3)
    throw new Error('Exactly three approved balance games are required');
  for (const copy of raw) {
    if (
      !copy ||
      typeof copy.title !== 'string' ||
      !copy.title.trim() ||
      copy.title.length > 100 ||
      typeof copy.content !== 'string' ||
      !copy.content.trim() ||
      copy.content.length > 10000 ||
      !Array.isArray(copy.choices) ||
      copy.choices.length !== 2 ||
      copy.choices.some(
        (v: unknown) => typeof v !== 'string' || !v.trim() || v.length > 100,
      ) ||
      copy.choices[0] === copy.choices[1]
    )
      throw new Error(
        'Each balance game requires title, content and two distinct choices',
      );
  }
  if (raw[0].choices[0] !== '송강' || raw[0].choices[1] !== '종강')
    throw new Error('The first approved topic is 송강 vs 종강');
  return raw.map(({ title, content, choices }) => ({
    title,
    content,
    choices: [choices[0], choices[1]],
  }));
}

export function balanceContentHash(games: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(validateBalanceGames(games)))
    .digest('hex');
}

// A separate one-off operation: it never visits or repairs the two existing campus IDs.
export async function createBalanceGames(
  store: PostUnitOfWork,
  input: CampusCreationInput,
  raw: unknown,
  dryRun = true,
  now = new Date(),
) {
  const copies = validateBalanceGames(raw);
  if (
    input.authorId !== 1 ||
    input.latitude !== 37.5047225 ||
    input.longitude !== 126.9565323
  )
    throw new Error(
      'Balance games require the verified author and Seorabeol Hall coordinates',
    );
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.execute(async ({ queries, commands }) => {
        const result = [];
        for (const [index, postId] of BALANCE_POST_IDS.entries()) {
          const copy = copies[index]!;
          const existing = await queries.findPost(postId);
          if (existing) {
            // Retrying after votes/expiry must preserve the original time and all selections.
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
              existing.voteKind !== 'FIXED_AB' ||
              !(
                ['OPEN', 'CLOSED'].includes(existing.voteStatus ?? '') ||
                (['HIDDEN', 'DELETED'].includes(existing.status) &&
                  existing.voteStatus === 'CANCELLED')
              ) ||
              JSON.stringify(existing.voteCandidateIds) !==
                JSON.stringify(BALANCE_OPTION_IDS) ||
              JSON.stringify(existing.voteCandidateContents) !==
                JSON.stringify(copy.choices)
            )
              throw new Error(
                'Reserved balance identity conflicts; no data changed',
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
                title: copy.title,
                content: copy.content,
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
            balanceChoices: copy.choices,
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
                    title: copy.title,
                    content: copy.content,
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
      if (error instanceof UniqueConflictError && attempt < 2) continue;
      throw error;
    }
  }
}
