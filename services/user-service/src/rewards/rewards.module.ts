import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityService } from './activity.service.js';
import { RewardEngine } from './reward-engine.js';
import {
  REWARD_POLICY,
  DISABLED_POLICY,
  validatePolicy,
} from './reward-policy.js';
import { RewardsController } from './rewards.controller.js';
import { PostRewardsConsumer } from './post-rewards.consumer.js';

@Module({
  controllers: [RewardsController],
  providers: [
    ActivityService,
    RewardEngine,
    PostRewardsConsumer,
    {
      provide: REWARD_POLICY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const raw = config.get<string>('rewards.policy');
        return raw ? validatePolicy(JSON.parse(raw)) : DISABLED_POLICY;
      },
    },
  ],
})
export class RewardsModule {}
