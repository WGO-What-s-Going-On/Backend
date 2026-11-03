import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { NotificationEventWriter } from '../persistence/notification-event.writer.js';
import { NotificationState } from '../redis/notification-state.js';
import { PostEventHandler } from '../event-consumer/post-event.handler.js';
import { NotificationBlockChecker } from './block-checker.js';
import { nearbyEnabled, distanceM } from './nearby.policy.js';
interface Job {
  post_id: string;
  event_id: string;
  author_id: string;
  latitude: number;
  longitude: number;
  cursor_user_id: string;
  lease_id: string;
}
interface Location {
  user_id: string;
  revision: string;
  latitude: number;
  longitude: number;
}
@Injectable()
export class NearbyWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NearbyWorker.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private running: Promise<void> | undefined;
  private nextCleanup = 0;
  constructor(
    private readonly database: PostgresDatabase,
    private readonly writer: NotificationEventWriter,
    private readonly blocks: NotificationBlockChecker,
    private readonly state: NotificationState,
    private readonly deliveries: PostEventHandler,
    private readonly config: ConfigService,
  ) {}
  onModuleInit() {
    if (!this.config.get<string>('redis.url')) return;
    this.timer = setInterval(() => {
      if (!this.stopped && !this.running) {
        this.running = this.runOnce()
          .catch(() => this.logger.warn('Nearby fanout remains pending'))
          .finally(() => {
            this.running = undefined;
          });
      }
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  async runOnce() {
    if (Date.now() >= this.nextCleanup) {
      await this.cleanupExpired();
      this.nextCleanup = Date.now() + 60000;
    }
    if (!nearbyEnabled()) return;
    const lease = randomUUID();
    const job = (
      await this.database.pool.query<Job>(
        `UPDATE notification_nearby_jobs j SET status='RUNNING',lease_id=$1,lease_until=now()+interval '60 seconds'
    WHERE post_id=(SELECT post_id FROM notification_nearby_jobs WHERE expires_at>now() AND next_attempt_at<=now()
      AND (status='PENDING' OR status='RUNNING' AND lease_until<=now()) ORDER BY next_attempt_at,post_id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING j.*`,
        [lease],
      )
    ).rows[0];
    if (!job) return;
    try {
      // A latitude index bounds candidate discovery; exact Haversine handles longitude wrapping and poles.
      const rows = (
        await this.database.pool.query<Location>(
          `SELECT user_id,revision,latitude,longitude FROM notification_nearby_subscriptions
     WHERE expires_at>now() AND captured_at>now()-interval '15 minutes' AND user_id COLLATE "C">$1 COLLATE "C"
     AND latitude BETWEEN $2 AND $3 ORDER BY user_id COLLATE "C" LIMIT 50`,
          [
            job.cursor_user_id,
            job.latitude - 151 / 111195,
            job.latitude + 151 / 111195,
          ],
        )
      ).rows;
      // At most five 2-second authority requests are in flight. A page stays within the durable lease.
      for (let offset = 0; offset < rows.length; offset += 5) {
        const group = rows.slice(offset, offset + 5);
        const authorized = await Promise.all(
          group.map(async (location) => ({
            location,
            allowed:
              location.user_id !== job.author_id &&
              distanceM(
                job.latitude,
                job.longitude,
                location.latitude,
                location.longitude,
              ) <=
                150 + 0.000001 &&
              (await this.blocks.allowed(location.user_id, job.author_id)),
          })),
        );
        for (const { location, allowed } of authorized) {
          const created = await this.enqueue(job, location, allowed);
          if (created) await this.state.invalidateUnread(location.user_id);
        }
      }
      await this.database.pool.query(
        `UPDATE notification_nearby_jobs SET status=$3,lease_id=NULL,lease_until=NULL,next_attempt_at=now()
     WHERE post_id=$1 AND lease_id=$2`,
        [job.post_id, lease, rows.length < 50 ? 'DONE' : 'PENDING'],
      );
      await this.deliveries.dispatch(job.post_id);
    } catch (error) {
      await this.database.pool.query(
        `UPDATE notification_nearby_jobs SET status='PENDING',lease_id=NULL,lease_until=NULL,next_attempt_at=now()+interval '5 seconds' WHERE post_id=$1 AND lease_id=$2`,
        [job.post_id, lease],
      );
      throw error;
    }
  }
  async cleanupExpired() {
    // Coordinates are short lived even when fanout is disabled; receipts retain no location.
    await this.database.pool.query(
      `DELETE FROM notification_nearby_subscriptions WHERE user_id IN (SELECT user_id FROM notification_nearby_subscriptions WHERE expires_at<=now() LIMIT 1000)`,
    );
    await this.database.pool.query(
      `DELETE FROM notification_nearby_jobs WHERE post_id IN (SELECT post_id FROM notification_nearby_jobs WHERE expires_at<=now() OR status IN ('DONE','CANCELED') LIMIT 1000)`,
    );
    await this.database.pool.query(
      `DELETE FROM notification_nearby_limits WHERE user_id IN (SELECT user_id FROM notification_nearby_limits WHERE last_enqueued_at<now()-interval '30 days' LIMIT 1000)`,
    );
  }
  private async enqueue(job: Job, location: Location, allowed: boolean) {
    return this.database.transaction(async (client) => {
      const post = (
        await client.query(
          'SELECT closed,paused FROM notification_posts WHERE post_id=$1 FOR UPDATE',
          [job.post_id],
        )
      ).rows[0];
      const current = (
        await client.query(
          `SELECT * FROM notification_nearby_jobs WHERE post_id=$1 AND lease_id=$2 AND status='RUNNING' AND lease_until>now() AND expires_at>now() FOR UPDATE`,
          [job.post_id, job.lease_id],
        )
      ).rows[0];
      if (!current) throw new Error('Nearby lease expired');
      if (!post || post.closed || post.paused) {
        await client.query(
          "UPDATE notification_nearby_jobs SET status='CANCELED',lease_id=NULL,lease_until=NULL WHERE post_id=$1",
          [job.post_id],
        );
        return false;
      }
      const subscription = (
        await client.query(
          'SELECT revision FROM notification_nearby_subscriptions WHERE user_id=$1 AND expires_at>now() FOR UPDATE',
          [location.user_id],
        )
      ).rows[0];
      let created = false;
      if (allowed && subscription?.revision === location.revision) {
        await client.query(
          `INSERT INTO notification_nearby_limits(user_id,last_enqueued_at) VALUES($1,'-infinity') ON CONFLICT DO NOTHING`,
          [location.user_id],
        );
        const throttle = Number(process.env.NEARBY_MIN_INTERVAL_SECONDS ?? 600);
        if (
          !Number.isSafeInteger(throttle) ||
          throttle < 60 ||
          throttle > 86400
        )
          throw new Error('Invalid nearby throttle');
        const limit = (
          await client.query(
            "SELECT last_enqueued_at<=now()-($2::int*interval '1 second') AS eligible FROM notification_nearby_limits WHERE user_id=$1 FOR UPDATE",
            [location.user_id, throttle],
          )
        ).rows[0];
        if (limit.eligible) {
          const n = await this.writer.write(client, {
            stream: 'post:events',
            eventId: job.event_id,
            businessKey: `nearby:${job.post_id}:${location.user_id}`,
            userId: location.user_id,
            postId: job.post_id,
            type: 'NEARBY_POST_CREATED',
            category: 'nearby',
            title: '주변 새 게시물',
            body: '주변에 새로운 게시물이 등록되었습니다.',
            push: true,
            authorizationActorId: job.author_id,
            deliveryData: { subscriptionRevision: location.revision },
          });
          created = !!n?.created;
          if (created)
            await client.query(
              'UPDATE notification_nearby_limits SET last_enqueued_at=now() WHERE user_id=$1',
              [location.user_id],
            );
        }
      }
      await client.query(
        'UPDATE notification_nearby_jobs SET cursor_user_id=$3 WHERE post_id=$1 AND lease_id=$2',
        [job.post_id, job.lease_id, location.user_id],
      );
      return created;
    });
  }
}
