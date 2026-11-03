import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { DurableStreamConsumer } from '../../src/event-consumer/durable-stream.consumer.js';
import { UserEventHandler } from '../../src/event-consumer/user-event.handler.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import { wire } from '../helpers/post-events.js';

it.skipIf(process.env.NOTIFICATION_RESTART_TEST !== '1')(
  'recovers real Redis PEL and PostgreSQL committed delivery after isolated container restarts',
  async () => {
    const redisName = process.env.NOTIFICATION_RESTART_REDIS_CONTAINER,
      pgName = process.env.NOTIFICATION_RESTART_PG_CONTAINER;
    for (const [name, kind] of [
      [redisName, 'redis'],
      [pgName, 'postgres'],
    ]) {
      if (
        !name ||
        !new RegExp(`^wgo-notification-full-${kind}-[0-9]+$`).test(name)
      )
        throw new Error('Dedicated test containers required');
      expect(
        execFileSync(
          'docker',
          [
            'inspect',
            '--format',
            '{{ index .Config.Labels "com.wgo.notification-full-test" }}',
            name,
          ],
          { encoding: 'utf8' },
        ).trim(),
      ).toBe('1');
    }
    const h = await harness();
    ['user:events', 'notification:user:dead', 'notification:unread:42'].forEach(
      (k) => h.ownedKeys.add(k),
    );
    const send = vi.fn().mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      invalidTokens: [],
      retryTokens: [],
    });
    const store = new PostgresEventStore(h.database),
      delivery = new PostEventHandler(store, h.state, { send });
    const user = new UserEventHandler(
      new NotificationEventWriter(h.database),
      h.state,
      delivery,
    );
    const options = {
      url: h.config.get<string>('redis.url')!,
      stream: 'user:events',
      group: 'user-notification',
      dead: 'notification:user:dead',
      pendingIdleMs: 0,
      blockMs: 1,
    };
    let consumer = new DurableStreamConsumer(h.database, options, async () => {
      throw new Error('precommit crash');
    });
    try {
      await consumer.initialize();
      const eventId = randomUUID();
      await h.redis.xAdd('user:events', '*', {
        eventId,
        eventType: 'USER_BADGE_GRANTED',
        data: JSON.stringify({
          eventId,
          type: 'USER_BADGE_GRANTED',
          version: 1,
          producer: 'user-service',
          target: { type: 'USER', id: '42' },
          occurredAt: new Date().toISOString(),
          correlationId: 'test',
          payload: {
            userId: '42',
            sourceEventId: randomUUID(),
            policyVersion: 'wgo-titles-v2',
            badgeId: '1',
            badgeCode: 'NEWS_BOY',
          },
        }),
      });
      await consumer.pollOnce();
      expect(
        (await h.redis.xPending('user:events', 'user-notification')).pending,
      ).toBe(1);
      await h.redis.sendCommand(['SAVE']);
      await consumer.onModuleDestroy();
      await h.redis.quit();
      execFileSync('docker', ['restart', redisName!], { timeout: 30000 });
      await expect
        .poll(
          async () => {
            try {
              if (!h.redis.isOpen) await h.redis.connect();
              return h.redis.isReady;
            } catch {
              return false;
            }
          },
          { timeout: 15000 },
        )
        .toBe(true);
      consumer = new DurableStreamConsumer(h.database, options, (f) =>
        user.handle(f),
      );
      await consumer.initialize();
      await consumer.pollOnce();
      expect(
        (await h.redis.xPending('user:events', 'user-notification')).pending,
      ).toBe(0);
      expect(send).toHaveBeenCalledOnce();
      expect((await h.notifications.list('42')).items).toHaveLength(1);
      const post = parsePostEvent(wire('PostCommentCreated').data)!;
      await store.apply(post);
      expect(send).toHaveBeenCalledOnce();
      // No other suites are running against this owned PostgreSQL container.
      execFileSync('docker', ['restart', pgName!], { timeout: 30000 });
      await expect
        .poll(
          async () => {
            try {
              await h.database.pool.query('SELECT 1');
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 15000 },
        )
        .toBe(true);
      await new PostEventHandler(new PostgresEventStore(h.database), h.state, {
        send,
      }).handle(post);
      expect(send).toHaveBeenCalledTimes(2);
      expect((await h.notifications.list('1')).items).toHaveLength(1);
    } catch (error) {
      console.error(
        'Dedicated restart test failed before cleanup:',
        error instanceof Error ? error.message : 'unknown',
      );
      throw error;
    } finally {
      await consumer.onModuleDestroy();
      await h.cleanup();
    }
  },
  90000,
);
