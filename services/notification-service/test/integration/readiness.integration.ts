import { Test } from '@nestjs/testing';
import request from 'supertest';
import { expect, it } from 'vitest';
import { NotificationReadinessController } from '../../src/notification/readiness.controller.js';
import { PostgresDatabase } from '../../src/persistence/postgres.database.js';
import { PostEventConsumer } from '../../src/event-consumer/post-event.consumer.js';
import { HealthController } from '../../src/health/health.controller.js';
import { postgresHarness } from './postgres-harness.js';

it('serves readiness only with a live consumer and initialized SQL schema while liveness stays independent', async () => {
  const h = await postgresHarness();
  let consumerReady = true;
  const module = await Test.createTestingModule({
    controllers: [NotificationReadinessController, HealthController],
    providers: [
      { provide: PostgresDatabase, useValue: { pool: h.database.pool } },
      {
        provide: PostEventConsumer,
        useValue: { isReady: () => consumerReady },
      },
    ],
  }).compile();
  const app = module.createNestApplication();
  await app.init();
  try {
    await request(app.getHttpServer()).get('/health/ready').expect(200);
    consumerReady = false;
    await request(app.getHttpServer()).get('/health/ready').expect(503);
    consumerReady = true;
    await h.database.pool.query('DROP TABLE notification_schema_versions');
    const result = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(result.body.message).toBe('Notification dependencies are not ready');
    await request(app.getHttpServer()).get('/health/live').expect(200);
  } finally {
    await app.close();
    await h.cleanup();
  }
});
