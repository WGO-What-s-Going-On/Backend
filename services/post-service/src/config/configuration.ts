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
      port: positiveInteger(process.env.PORT, 3002, 'PORT'),
    },
    database: {
      uri:
        process.env.MONGODB_URI ??
        'mongodb://localhost:27017/wgo_post?replicaSet=rs0',
    },
  };
}
