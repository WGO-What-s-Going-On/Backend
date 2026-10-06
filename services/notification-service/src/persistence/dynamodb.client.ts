import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { ConfigService } from '@nestjs/config';

export const DYNAMODB_DOCUMENT_CLIENT = Symbol('DYNAMODB_DOCUMENT_CLIENT');

export function createDynamoDocumentClient(config: ConfigService): DynamoDBDocumentClient {
  const endpoint = config.get<string>('dynamodb.endpoint');
  return DynamoDBDocumentClient.from(
    new DynamoDBClient({
      region: config.get<string>('dynamodb.region') ?? 'ap-northeast-2',
      ...(endpoint ? { endpoint } : {}),
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
}
