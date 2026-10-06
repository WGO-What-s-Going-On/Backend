function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function configuration() {
  return {
    app: {
      nodeEnv: process.env.NODE_ENV ?? 'development',
      port: positiveInteger(process.env.PORT, 3005, 'PORT'),
    },
    redis: {
      url: process.env.REDIS_URL,
      postEventStream: process.env.POST_EVENT_STREAM ?? 'post:events',
      moderationEventStream:
        process.env.MODERATION_EVENT_STREAM ?? 'moderation:events',
      moderationConsumerGroup:
        process.env.MODERATION_CONSUMER_GROUP ?? 'post-moderation',
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
    },
  };
}
