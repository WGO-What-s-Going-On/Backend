import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { SemanticSource } from './ports.js';
import { CANDIDATE_LIMIT, type SourcePost } from './policy.js';
const fields =
  'postId title content category status createdAt updatedAt expiresAt -_id';

@Injectable()
export class MongooseSemanticSource implements SemanticSource {
  constructor(@InjectModel('Post') private readonly posts: Model<any>) {}
  async batch(ids: string[]): Promise<SourcePost[]> {
    if (ids.length > CANDIDATE_LIMIT)
      throw new Error('Too many semantic candidates');
    return this.posts
      .find({ postId: { $in: ids } }, fields)
      .maxTimeMS(2000)
      .lean<SourcePost[]>();
  }
  async *scan(): AsyncIterable<SourcePost> {
    const cursor = this.posts
      .find({}, fields)
      .lean<SourcePost>()
      .cursor({ batchSize: 200 });
    try {
      for await (const post of cursor) yield post;
    } finally {
      await cursor.close();
    }
  }
}
