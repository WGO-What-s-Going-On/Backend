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
    post: {
      // 생성 시 게시물별로 고정한다. 운영 중 기존 게시물의 bucket 수는 변경하지 않는다.
      bucketCount: positiveInteger(
        process.env.POST_BUCKET_COUNT,
        1,
        'POST_BUCKET_COUNT',
      ),
    },
  };
}
