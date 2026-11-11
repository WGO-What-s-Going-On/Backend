import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { createLogger } from '../observability/logging.js';
import {
  contentDecision,
  parseEnforcementPolicy,
  policyFingerprint,
  type EnforcementPolicy,
  DEFAULT_ENFORCEMENT_POLICY_VERSION,
} from './enforcement-policy.js';
import type { StoredModerationResult } from './moderation-result.js';

@Injectable()
export class ContentEnforcementService implements OnModuleDestroy {
  private readonly redis;
  private readonly stream: string;
  private readonly policy: EnforcementPolicy | undefined;
  private connecting: Promise<unknown> | undefined;
  private readonly logger = createLogger(
    'moderation-service',
    'content-enforcement',
  );

  constructor(config: ConfigService) {
    const enabled = config.get<string>('contentEnforcement.enabled') ?? 'false';
    if (!['true', 'false'].includes(enabled))
      throw new Error('Content enforcement enabled must be true or false');
    this.stream =
      config.get<string>('redis.contentDecisionStream') ??
      'moderation:content-decisions';
    if (enabled === 'true') {
      this.policy = parseEnforcementPolicy(
        config.get<string>('contentEnforcement.policyVersion') ??
          DEFAULT_ENFORCEMENT_POLICY_VERSION,
      );
      if (!config.get<string>('redis.url'))
        throw new Error('Content enforcement requires explicit Redis URL');
      if (
        !this.stream.trim() ||
        [
          config.get<string>('redis.postEventStream') ?? 'post:events',
          config.get<string>('redis.moderationEventStream') ??
            'moderation:events',
          config.get<string>('redis.contentEventStream') ??
            'moderation:content-events',
          config.get<string>('reports.eventStream') ??
            'moderation:report-events',
        ].includes(this.stream)
      )
        throw new Error('Content decisions require a separate stream');
    }
    // Disabled deployments never connect, observe versions or publish decisions.
    this.redis = createClient({
      url: config.get<string>('redis.url') ?? 'redis://localhost:6383',
      disableOfflineQueue: true,
      commandOptions: { timeout: 2000 },
      commandsQueueMaxLength: 1000,
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.redis.on('error', () => undefined);
  }

  private async ready() {
    if (!this.redis.isReady) {
      this.connecting ??= this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
      await this.connecting;
    }
  }

  async observeComment(
    postId: string,
    commentId: string,
    version: number,
    deleted = false,
  ): Promise<void> {
    await this.observeVersion(
      this.targetKey(postId, commentId),
      version,
      deleted,
    );
  }

  async observePost(postId: string, version: number): Promise<void> {
    await this.observeVersion(this.postTargetKey(postId), version, false);
  }

  private async observeVersion(
    key: string,
    version: number,
    deleted: boolean,
  ): Promise<void> {
    if (!this.policy) return;
    if (!Number.isSafeInteger(version) || version < 1)
      throw new Error('Content version required');
    await this.ready();
    // Observe edits before waiting for OpenAI. An older in-flight response must
    // not publish a new actionable decision after a newer body was observed.
    await this.redis.eval(
      `
      local t=redis.call('TYPE',KEYS[1]).ok
      if t~='none' and t~='string' then return redis.error_reply('WRONGTYPE content target') end
      local old=redis.call('GET',KEYS[1]); local next=tonumber(ARGV[1]); local deleted=ARGV[2]=='1'
      if old then
        local p=cjson.decode(old)
        if p.deleted or tonumber(p.version)>next then return 0 end
        if tonumber(p.version)==next and not deleted then return 0 end
      end
      -- Keep safe integers as decimal strings; cjson's default precision is 14 digits.
      redis.call('SET',KEYS[1],cjson.encode({version=ARGV[1],deleted=deleted})); return 1
    `,
      {
        keys: [key],
        arguments: [String(version), deleted ? '1' : '0'],
      },
    );
  }

  async observePostTerminal(postId: string): Promise<void> {
    if (!this.policy) return;
    await this.ready();
    await this.redis.eval(
      `
      local t=redis.call('TYPE',KEYS[1]).ok
      if t~='none' and t~='string' then return redis.error_reply('WRONGTYPE content post terminal') end
      return redis.call('SET',KEYS[1],'1')
    `,
      { keys: [`moderation:content-post-terminal:${postId}`], arguments: [] },
    );
  }

  async decide(result: StoredModerationResult): Promise<void> {
    if (!this.policy) return;
    const decision = contentDecision(result, this.policy);
    if (!decision) return;
    const version =
      result.targetType === 'POST'
        ? result.postVersion
        : result.activityVersion!;
    try {
      await this.ready();
      const outcome = await this.redis.eval(
        `
        for i=1,5 do
          local t=redis.call('TYPE',KEYS[i]).ok
          if t~='none' and t~='string' then return redis.error_reply('WRONGTYPE content decision state') end
        end
        local st=redis.call('TYPE',KEYS[6]).ok
        if st~='none' and st~='stream' then return redis.error_reply('WRONGTYPE content decision stream') end
        local policy=redis.call('GET',KEYS[5])
        if policy and policy~=ARGV[2] then return redis.error_reply('CONTENT_POLICY_VERSION_REUSED') end
        if redis.call('EXISTS',KEYS[3])==1 then return 'DUPLICATE' end
        local target=redis.call('GET',KEYS[1]); local incoming=cjson.decode(ARGV[1])
        if redis.call('EXISTS',KEYS[4])==1 then return 'POST_TERMINAL' end
        if not target then return redis.error_reply('CONTENT_TARGET_UNOBSERVED') end
        local state=cjson.decode(target)
        local version=incoming.postVersion or incoming.activityVersion
        if state.deleted or tonumber(state.version)~=tonumber(version) then return 'STALE' end
        local raw=redis.call('GET',KEYS[2]) or ARGV[1]
        if raw~=ARGV[1] then return redis.error_reply('CONTENT_DECISION_CONFLICT') end
        redis.call('SET',KEYS[5],ARGV[2])
        redis.call('SET',KEYS[2],raw)
        local added=redis.pcall('XADD',KEYS[6],'*','eventId',incoming.eventId,'eventType',incoming.eventType,'data',raw)
        if type(added)=='table' and added.err then return redis.error_reply('CONTENT_DECISION_PUBLICATION_FAILED') end
        redis.call('SET',KEYS[3],incoming.eventId)
        return 'PUBLISHED'
      `,
        {
          keys: [
            result.targetType === 'POST'
              ? this.postTargetKey(result.postId)
              : this.targetKey(result.postId, result.commentId),
            `moderation:content-decision:${decision.moderationDecisionId}`,
            `moderation:content-decision-published:${decision.moderationDecisionId}`,
            `moderation:content-post-terminal:${result.postId}`,
            `moderation:content-policy:${this.policy.policyVersion}`,
            this.stream,
          ],
          arguments: [JSON.stringify(decision), policyFingerprint(this.policy)],
        },
      );
      const fields = {
        eventId: decision.eventId,
        postId: result.postId,
        commentId: result.commentId,
        correlationId: decision.correlationId,
        entityVersion: version,
        status: outcome,
      };
      if (outcome === 'PUBLISHED')
        this.logger.success(
          'content_decision_published',
          'Content decision published; Post application is unconfirmed',
          fields,
        );
      else
        this.logger.skipped(
          'content_decision_skipped',
          String(outcome),
          fields,
        );
    } catch (error) {
      this.logger.failure(
        'content_decision_publication_failed',
        error,
        'CONTENT_DECISION_PUBLICATION_FAILED',
        'Content decision publication failed; input must remain pending',
        {
          eventId: decision.eventId,
          postId: result.postId,
          commentId: result.commentId,
          correlationId: decision.correlationId,
        },
      );
      throw error;
    }
  }

  private targetKey(postId: string, commentId: string) {
    return `moderation:content-target:${postId}:${commentId}`;
  }

  private postTargetKey(postId: string) {
    return `moderation:content-post-target:${postId}`;
  }

  async isReady(): Promise<boolean> {
    if (!this.policy) return true;
    await this.ready();
    const type = await this.redis.type(this.stream);
    const fingerprint = await this.redis.get(
      `moderation:content-policy:${this.policy.policyVersion}`,
    );
    return (
      (type === 'none' || type === 'stream') &&
      (!fingerprint || fingerprint === policyFingerprint(this.policy))
    );
  }

  async onModuleDestroy() {
    if (this.redis.isOpen) await this.redis.quit();
  }
}
