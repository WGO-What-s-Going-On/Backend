import { TitleService } from './title.service.js';
import { RegionalRankingWorker } from './regional-ranking.worker.js';
import { TITLE_SETTINGS, loadTitleSettings } from './title-policy.js';
import { RewardMaintenanceWorker } from './reward-maintenance.worker.js';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityService } from './activity.service.js';
import { RewardEngine } from './reward-engine.js';
import { REWARD_POLICY, loadPolicy } from './reward-policy.js';
import { RewardsController } from './rewards.controller.js';
import { PostRewardsConsumer } from './post-rewards.consumer.js';

@Module({
  controllers: [RewardsController],
  providers: [
    ActivityService,
    TitleService,
    RegionalRankingWorker,
    { provide: TITLE_SETTINGS, useFactory: () => loadTitleSettings() },
    RewardEngine,
    PostRewardsConsumer,
    RewardMaintenanceWorker,
    {
      provide: REWARD_POLICY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const raw = config.get<string>('rewards.policy');
        return loadPolicy(raw, process.env.NODE_ENV);
      },
    },
  ],
})
export class RewardsModule {}
