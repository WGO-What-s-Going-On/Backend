import { createGrpcServer, createHttpServer, listenGrpc } from './server.js';
import { CassandraLocationStore } from './store.js';

const store = new CassandraLocationStore();
await store.connect();
const grpc = createGrpcServer(store);
await listenGrpc(grpc, Number(process.env.GRPC_PORT ?? 50051));
const http = createHttpServer(store);
http.listen(Number(process.env.HTTP_PORT ?? 3003));
const close = async () => {
  http.close();
  grpc.forceShutdown();
  await store.close();
};
process.once('SIGTERM', close);
process.once('SIGINT', close);
