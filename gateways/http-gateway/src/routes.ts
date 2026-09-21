import type { ServiceName } from './config.js';

export interface ProxyRoute {
  service: ServiceName;
  prefix: string;
}

export const proxyRoutes: readonly ProxyRoute[] = [
  { service: 'user', prefix: '/api/v1/auth' },
  { service: 'user', prefix: '/api/v1/users' },
  { service: 'post', prefix: '/api/v1/posts' },
  { service: 'map', prefix: '/api/v1/location' },
  { service: 'notification', prefix: '/api/v1/notifications' },
  { service: 'moderation', prefix: '/api/v1/moderation' },
];
