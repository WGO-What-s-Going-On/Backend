import { createLogger } from '../observability/logging.js';
import {
  Injectable,
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
import { nearbyEnabled } from './nearby.policy.js';
import { MapNearbyClient } from './map-nearby.client.js';
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
}
@Injectable()
export class NearbyWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('notification-service', 'nearby');
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
    private readonly map: MapNearbyClient = new MapNearbyClient(),
  ) {}
  onModuleInit() {
    if (!this.config.get<string>('redis.url')) return;
    this.timer = setInterval(() => {
      if (!this.stopped && !this.running) {
        this.running = this.runOnce()
          .catch((error) =>
            this.logger.failure(
              'nearby_fanout_failed',
              error,
              'NEARBY_FANOUT_FAILED',
              'Nearby fanout remains pending',
              {},
              true,
            ),
          )
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
    // Rebuild from durable consent before taking a fanout lease, including after restarts/index loss.
    await this.map.ensureIndex(this.database);
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
      const policy = (
        await this.database.pool.query<{ participation_radius_m: number }>(
          'SELECT participation_radius_m FROM notification_nearby_job_policy WHERE post_id=$1',
          [job.post_id],
        )
      ).rows[0];
      if (!policy)
        throw new Error('Nearby job participation radius unavailable; retry');
      const page = await this.map.find({
        latitude: job.latitude,
        longitude: job.longitude,
        participationRadiusM: policy.participation_radius_m,
        authorId: job.author_id,
        afterUserId: job.cursor_user_id,
      });
      const rows: Location[] = page.users.map((user) => ({
        user_id: user.userId,
        revision: user.revision,
      }));
      // At most five 2-second authority requests are in flight. A page stays within the durable lease.
      for (let offset = 0; offset < rows.length; offset += 5) {
        const group = rows.slice(offset, offset + 5);
        const authorized = await Promise.all(
          group.map(async (location) => ({
            location,
            allowed:
              location.user_id !== job.author_id &&
              (await this.blocks.allowed(location.user_id, job.author_id)),
          })),
        );
        for (const { location, allowed } of authorized) {
          const created = await this.enqueue(job, location, allowed);
          if (created) await this.state.invalidateUnread(location.user_id);
        }
      }
      await this.database.pool.query(
        `UPDATE notification_nearby_jobs SET status=$3,lease_id=NULL,lease_until=NULL,next_attempt_at=now(),cursor_user_id=$4
     WHERE post_id=$1 AND lease_id=$2`,
        [
          job.post_id,
          lease,
          page.nextAfterUserId ? 'PENDING' : 'DONE',
          page.nextAfterUserId || rows.at(-1)?.user_id || job.cursor_user_id,
        ],
      );
      await this.deliveries.dispatch(job.post_id);
      this.logger.success(
        'nearby_fanout_completed',
        'Nearby fanout page completed',
        { postId: job.post_id, eventId: job.event_id, count: rows.length },
      );
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
    const subscriptions = await this.database.pool.query(
      `DELETE FROM notification_nearby_subscriptions WHERE user_id IN (SELECT user_id FROM notification_nearby_subscriptions WHERE expires_at<=now() LIMIT 1000)`,
    );
    const jobs = await this.database.pool.query<{ status: string }>(
      `DELETE FROM notification_nearby_jobs WHERE post_id IN (SELECT post_id FROM notification_nearby_jobs WHERE expires_at<=now() OR status IN ('DONE','CANCELED') LIMIT 1000) RETURNING status`,
    );
    const expired = jobs.rows.filter((job) =>
      ['PENDING', 'RUNNING'].includes(job.status),
    ).length;
    if (expired)
      this.logger.emit({
        event: 'nearby_jobs_expired',
        outcome: 'skipped',
        reasonCode: 'NEARBY_LOCATION_WINDOW_EXPIRED',
        message:
          'Nearby jobs exceeded the existing location-use window before completion',
        count: expired,
      });
    await this.database.pool.query(
      `DELETE FROM notification_nearby_limits WHERE user_id IN (SELECT user_id FROM notification_nearby_limits WHERE last_enqueued_at<now()-interval '30 days' LIMIT 1000)`,
    );
    if (subscriptions.rowCount)
      this.logger.success(
        'nearby_retention_completed',
        'Expired location subscriptions removed',
        { count: subscriptions.rowCount },
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
