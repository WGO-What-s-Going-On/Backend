import 'reflect-metadata';
import { Controller, Get, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { installHttpLogging } from '../src/observability/nest.js';
import { getLogContext } from '../src/observability/logging.js';

@Controller('/api/v1/test')
class ProbeController {
  @Get()
  get() {
    return { requestId: getLogContext().requestId };
  }
  @Get('/failure')
  fail() {
    throw new HttpException(
      { code: 'PROBE_UNAVAILABLE', message: 'private provider payload' },
      503,
    );
  }
}
@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Nest structured logging', () => {
  it('preserves response contracts and emits correlated completion and failure logs', async () => {
    const lines: string[] = [];
    const output = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((line: string | Uint8Array) => {
        lines.push(String(line));
        return true;
      });
    const app = await NestFactory.create(ProbeModule, { logger: false });
    installHttpLogging(app, 'user-service');
    try {
      await app.init();
      const response = await request(app.getHttpServer())
        .get('/api/v1/test?token=secret')
        .set('x-request-id', 'probe-123')
        .expect(200);
      expect(response.body).toEqual({ requestId: 'probe-123' });
      expect(response.headers['x-request-id']).toBe('probe-123');
      await request(app.getHttpServer())
        .get('/api/v1/test/failure')
        .set('x-request-id', 'probe-fail')
        .expect(503)
        .expect({
          code: 'PROBE_UNAVAILABLE',
          message: 'private provider payload',
        });
      const logs = lines.map((line) => JSON.parse(line));
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        service: 'user-service',
        outcome: 'success',
        requestId: 'probe-123',
        path: '/api/v1/test',
      });
      expect(logs[1]).toMatchObject({
        severity: 'ERROR',
        outcome: 'failure',
        statusCode: 503,
        requestId: 'probe-fail',
        error: { code: 'PROBE_UNAVAILABLE' },
      });
      expect(lines.join('')).not.toMatch(
        /private provider payload|token=secret/,
      );
    } finally {
      await app.close();
      output.mockRestore();
    }
  });
});
