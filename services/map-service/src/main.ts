import { createGrpcServer, createHttpServer, listenGrpc } from './server.js';
import { CassandraLocationStore } from './store.js';
import { PostIndex } from './post-index.js';
import { PostConsumer } from './post-consumer.js';

const store = new CassandraLocationStore();
await store.connect();
const index = new PostIndex();
await index.connect();
const consumer = new PostConsumer(index);
void consumer.run().catch((error) => { console.error('post-map stopped', error); process.exitCode = 1; });
const grpc = createGrpcServer(store);
await listenGrpc(grpc, Number(process.env.GRPC_PORT ?? 50051));
const http = createHttpServer(store);
http.listen(Number(process.env.HTTP_PORT ?? 3003));
const close = async () => {
  consumer.stop();
  http.close();
  grpc.forceShutdown();
  await index.close();
  await store.close();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
