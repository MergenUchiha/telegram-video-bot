import { Module } from '@nestjs/common';
import { JokesParserService } from './jokes-parser.service';
import { UsedJokesService } from './used-jokes.service';
import { JokesCacheService } from './jokes-cache.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [JokesParserService, UsedJokesService, JokesCacheService],
  exports: [JokesParserService, UsedJokesService, JokesCacheService],
})
export class JokesModule {}
