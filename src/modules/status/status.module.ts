import { Module } from '@nestjs/common';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';
import { SessionModule } from '../session/session.module';
import { StatusStoreModule } from '../status-store/status-store.module';

@Module({
  imports: [SessionModule, StatusStoreModule],
  controllers: [StatusController],
  providers: [StatusService],
  exports: [StatusService],
})
export class StatusModule {}
