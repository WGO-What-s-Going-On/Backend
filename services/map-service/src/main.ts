import { createLogger } from './observability/logging.js';
const log = createLogger('map-service', 'lifecycle');
import { createGrpcServer, createHttpServer, listenGrpc } from './server.js';
import { CassandraLocationStore } from './store.js';
import { PostIndex } from './post-index.js';
import { PostConsumer } from './post-consumer.js';

const store = new CassandraLocationStore();
// Validate trusted keys before starting external connections or consumers.
const index = new PostIndex();
const grpc = createGrpcServer(store, index);
await store.connect();
await index.connect();
const consumer = new PostConsumer(index);
void consumer.run().catch((error) => {
  log.failure(
    'consumer.stopped',
    error,
    'CONSUMER_STOPPED',
    'Map consumer stopped unexpectedly.',
  );
  process.exitCode = 1;
});
await listenGrpc(grpc, Number(process.env.GRPC_PORT ?? 50051));
let stopping = false;
const http = createHttpServer(store, index, async () => {
  if (stopping || !store.cache.isReady || !index.redis.isReady) return false;
  await store.db.execute('SELECT release_version FROM system.local', [], {
    readTimeout: 2000,
  });
  return true;
});
http.listen(Number(process.env.HTTP_PORT ?? 3003));
const close = async () => {
  if (stopping) return;
  stopping = true;
  consumer.stop();
  const httpClosed = new Promise<void>((resolve) =>
    http.close(() => resolve()),
  );
  const grpcClosed = new Promise<void>((resolve) => {
    const deadline = setTimeout(() => {
      grpc.forceShutdown();
      resolve();
    }, 10000);
    grpc.tryShutdown(() => {
      clearTimeout(deadline);
      resolve();
    });
  });
  await Promise.all([httpClosed, grpcClosed]);
  await index.close();
  await store.close();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
