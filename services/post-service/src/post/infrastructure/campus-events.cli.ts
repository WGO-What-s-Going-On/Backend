import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { Client, credentials, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { configuration } from '../../config/configuration.js';
import { createCampusEvents } from '../application/create-campus-events.js';
import {
  createBalanceGames,
  balanceContentHash,
} from '../application/create-balance-games.js';
import {
  validateCampusManifest,
  validateBalanceManifest,
} from './campus-events.preflight.js';
import { GrpcLocationAuthorization } from './grpc-location.authorization.js';
import { mapMetadata, mapDeadline } from './map-service-auth.js';
import { MongoosePostStore } from './mongoose-post.store.js';
import {
  PostSchema,
  CommentSchema,
  ReactionSchema,
  CommentReactionSchema,
  ParticipantSchema,
  CounterSchema,
  OutboxSchema,
  ModerationReceiptSchema,
} from './post.schemas.js';
import { MediaSchema } from '../media/media.schema.js';
import type { OutboxWorker } from './outbox.worker.js';

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length < 1 ||
    args.length > 3 ||
    args
      .slice(1)
      .some((arg) => !['--apply', '--balance-games'].includes(arg)) ||
    new Set(args).size !== args.length
  )
    throw new Error(
      'Usage: campus-events <manifest.json> [--balance-games] [--apply] (default: dry-run)',
    );
  const apply = args.includes('--apply');
  const balance = args.includes('--balance-games');
  const manifest = validateCampusManifest(
    JSON.parse(await readFile(args[0]!, 'utf8')),
    apply,
  );
  if (Boolean(manifest.balanceGames) !== balance)
    throw new Error(
      'Balance manifests require the explicit --balance-games operation',
    );
  if (balance) validateBalanceManifest(manifest, apply);
  // No default database/address is allowed for this privileged one-off operation.
  if (
    !process.env.MONGODB_URI ||
    !process.env.USER_GRPC_ADDRESS ||
    !process.env.MAP_GRPC_ADDRESS
  )
    throw new Error(
      'Explicit Post database, User and Map endpoints are required',
    );
  const pkg = loadPackageDefinition(
    loadSync(resolve(process.cwd(), 'contracts/user.proto'), { longs: String }),
  ) as any;
  const user = new pkg.wgo.user.v1.UserService(
    process.env.USER_GRPC_ADDRESS,
    credentials.createInsecure(),
  ) as Client & { GetUserProfile: Function };
  const location = new GrpcLocationAuthorization();
  const config = configuration();
  const db = createConnection(config.database.uri, {
    autoCreate: false,
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    const profile = await new Promise<any>((yes, no) =>
      user.GetUserProfile(
        { userId: String(manifest.authorId) },
        mapMetadata('wgo-user-service'),
        { deadline: mapDeadline() },
        (error: Error | null, result: unknown) =>
          error ? no(error) : yes(result),
      ),
    );
    if (
      Number(profile.userId) !== manifest.authorId ||
      profile.status !== 1 ||
      profile.nickname !== manifest.expectedNickname
    )
      throw new Error(
        'Approved active operating account did not match User Service',
      );
    const region = await location.resolveRegion(
      manifest.location.latitude,
      manifest.location.longitude,
    );
    if (!region.code.startsWith('11590'))
      throw new Error('Expected Dongjak-gu region');
    // This is an explicit administrator creation: no user GPS updates or fake location authorization.
    await db.asPromise();
    const posts = db.model('Post', PostSchema, 'posts');
    const indexes = await posts.collection.indexes();
    if (
      !indexes.some(
        (i) =>
          i.unique && i.key.postId === 1 && Object.keys(i.key).length === 1,
      )
    )
      throw new Error('Unique postId index is required for idempotency');
    const store = new MongoosePostStore(
      db,
      posts,
      db.model('Comment', CommentSchema, 'post_comments'),
      db.model('Reaction', ReactionSchema, 'post_reactions'),
      db.model(
        'CommentReaction',
        CommentReactionSchema,
        'post_comment_reactions',
      ),
      db.model('Participant', ParticipantSchema, 'post_participants'),
      db.model('Outbox', OutboxSchema, 'outbox_events'),
      db.model('Counter', CounterSchema, 'post_counters'),
      db.model(
        'ModerationReceipt',
        ModerationReceiptSchema,
        'moderation_receipts',
      ),
      new ConfigService(config),
      { wake() {} } as OutboxWorker,
      db.model('Media', MediaSchema, 'post_media'),
    );
    // Recheck freshness after remote preflight, immediately before opening the creation transaction.
    validateCampusManifest(manifest, apply);
    if (balance) validateBalanceManifest(manifest, apply);
    const input = {
      authorId: manifest.authorId,
      latitude: manifest.location.latitude,
      longitude: manifest.location.longitude,
      region,
    };
    const postsResult = balance
      ? await createBalanceGames(store, input, manifest.balanceGames, !apply)
      : await createCampusEvents(
          store,
          {
            authorId: manifest.authorId,
            latitude: manifest.location.latitude,
            longitude: manifest.location.longitude,
            region,
          },
          !apply,
        );
    console.log(
      JSON.stringify({
        mode: apply ? 'apply' : 'dry-run',
        administratorCreation: true,
        ...(balance
          ? { contentSha256: balanceContentHash(manifest.balanceGames) }
          : {}),
        posts: postsResult,
      }),
    );
  } finally {
    user.close();
    location.onModuleDestroy();
    await db.close();
  }
}
void main().catch(() => {
  console.error(
    'Campus creation failed; private diagnostics suppressed. Re-run dry-run and review account, coordinates, rollout and reserved identities.',
  );
  process.exitCode = 1;
});
