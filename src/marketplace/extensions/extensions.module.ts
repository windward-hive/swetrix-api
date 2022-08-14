import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Extension } from './extension.entity'
import { ExtensionsController } from './extensions.controller'
import { ExtensionsService } from './extensions.service'

@Module({
  imports: [TypeOrmModule.forFeature([Extension])],
  controllers: [ExtensionsController],
  providers: [ExtensionsService],
})
export class ExtensionsModule {}
