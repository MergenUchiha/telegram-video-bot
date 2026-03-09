import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BackgroundLibraryService } from './background-library.service';
import { MusicLibraryService } from './music-library.service';
import { LibraryAdminService } from './library-admin.service';

@Module({
  imports: [StorageModule],
  providers: [
    BackgroundLibraryService,
    MusicLibraryService,
    LibraryAdminService,
  ],
  exports: [BackgroundLibraryService, MusicLibraryService, LibraryAdminService],
})
export class LibraryModule {}
