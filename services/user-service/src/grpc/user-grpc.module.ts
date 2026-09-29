import { Module } from '@nestjs/common';
import { UserGrpcServer } from './user-grpc.server.js';
import { UserQueriesService } from './user-queries.service.js';

@Module({ providers: [UserGrpcServer, UserQueriesService] })
export class UserGrpcModule {}
