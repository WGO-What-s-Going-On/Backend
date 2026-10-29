import 'reflect-metadata';
import { createConnection } from 'mongoose';
import { configuration } from '../../config/configuration.js';
import { GrpcLocationAuthorization } from './grpc-location.authorization.js';
import { PostSchema } from './post.schemas.js';
async function main() {
  const limit = Number(process.argv[2] ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error('Batch size must be 1-1000');
  const db = createConnection(configuration().database.uri, {
    serverSelectionTimeoutMS: 5000,
    autoIndex: false,
  });
  const map = new GrpcLocationAuthorization();
  try {
    await db.asPromise();
    const posts = db.model('Post', PostSchema, 'posts');
    const rows = await posts
      .find(
        { 'region.code': { $exists: false }, status: { $ne: 'DELETED' } },
        'postId locationSnapshot',
      )
      .sort({ _id: 1 })
      .limit(limit)
      .maxTimeMS(2000)
      .lean();
    let updated = 0;
    for (const row of rows) {
      if (
        !row.locationSnapshot ||
        row.locationSnapshot.latitude == null ||
        row.locationSnapshot.longitude == null
      )
        throw new Error('Post location unavailable');
      const region = await map.resolveRegion(
        row.locationSnapshot.latitude,
        row.locationSnapshot.longitude,
      );
      const result = await posts.updateOne(
        { postId: row.postId, 'region.code': { $exists: false } },
        { $set: { region } },
      );
      updated += result.modifiedCount;
    }
    console.info(
      JSON.stringify({
        scanned: rows.length,
        updated,
        repeat: rows.length === limit,
      }),
    );
  } finally {
    map.onModuleDestroy();
    await db.close();
  }
}
void main().catch(() => {
  console.error(
    'Region backfill failed; committed rows are retained. Verify Map connectivity and retry.',
  );
  process.exitCode = 1;
});
