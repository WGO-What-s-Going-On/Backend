import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'outbox_events' })
export class OutboxEventEntity {
  @PrimaryColumn({ name: 'event_id', type: 'uuid', primaryKeyConstraintName: 'pk_outbox_events' })
  eventId!: string;

  @Column({ name: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Column({ name: 'event_type', type: 'varchar' })
  eventType!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ name: 'publish_attempts', type: 'integer' })
  publishAttempts!: number;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
