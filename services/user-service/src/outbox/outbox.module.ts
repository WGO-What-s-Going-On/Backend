import { Module } from '@nestjs/common';
import { OutboxWorker } from './outbox.worker.js';
import { RedisStreamsPublisher } from './redis-streams.publisher.js';

@Module({ providers: [RedisStreamsPublisher, OutboxWorker] })
export class OutboxModule {}
