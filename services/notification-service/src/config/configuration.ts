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
      port: positiveInteger(process.env.PORT, 3004, 'PORT'),
    },
    redis: {
      url: process.env.REDIS_URL,
    },
    dynamodb: {
      region: process.env.AWS_REGION,
      endpoint: process.env.DYNAMODB_ENDPOINT,
      notificationsTable: process.env.DYNAMODB_NOTIFICATIONS_TABLE,
      pushSubscriptionsTable: process.env.DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE,
    },
    firebase: {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
    },
  };
}
