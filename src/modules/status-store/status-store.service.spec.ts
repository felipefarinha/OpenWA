import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

jest.mock('archiver', () => ({ default: jest.fn() }));

import { StorageService } from '../../common/storage/storage.service';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';

/** A ConfigService stub that returns each call's default unless overridden by `overrides`. */
function fakeConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => (key in overrides ? overrides[key] : defaultValue),
  } as unknown as ConfigService;
}

function makeStorageService(localPath: string): StorageService {
  return new StorageService(fakeConfigService({ 'storage.type': 'local', 'storage.localPath': localPath }));
}

describe('StatusStoreService (ingest / list / getMedia)', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;
  let service: StatusStoreService;

  beforeAll(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-store-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
    service = new StatusStoreService(repository, storageService, fakeConfigService());
  });

  afterAll(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('ingest writes a text row with expiresAt = postedAt + 24h', async () => {
    const row = await service.ingest('sess', {
      waStatusId: 'w1',
      contactJid: '628111@c.us',
      type: 'text',
      caption: 'hi',
      postedAt: 1000,
    });
    expect(row.expiresAt).toBe(1000 + 24 * 60 * 60 * 1000);
    expect(row.mediaOmitted).toBe(false);
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest persists media to a file under the cap and records mediaPath', async () => {
    const row = await service.ingest('sess', {
      waStatusId: 'w2',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('x').toString('base64') },
      postedAt: 2000,
    });
    expect(row.mediaPath).toBeTruthy();
    expect(row.mediaMimetype).toBe('image/jpeg');
    expect(row.mediaOmitted).toBe(false);
    expect(row.mediaPath!.endsWith('.jpg')).toBe(true);
    // The file was actually written under the storage root.
    expect(fs.readFileSync(path.join(baseDir, 'media', row.mediaPath!), 'utf8')).toBe('x');
  });

  it('ingest marks media omitted when the engine already omitted it', async () => {
    const row = await service.ingest('sess', {
      waStatusId: 'w3',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', omitted: true, sizeBytes: 99 },
      postedAt: 3000,
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('engine_omitted');
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest marks media omitted when sizeBytes exceeds STATUS_MEDIA_MAX_BYTES', async () => {
    const row = await service.ingest('sess', {
      waStatusId: 'w4',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: '...', sizeBytes: 999_999_999 },
      postedAt: 4000,
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('over_cap');
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest is idempotent on (sessionId, waStatusId)', async () => {
    await service.ingest('sess', { waStatusId: 'dup', contactJid: '628111@c.us', type: 'text', postedAt: 1 });
    const second = await service.ingest('sess', {
      waStatusId: 'dup',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: 1,
    });
    const rows = await repository.find({ where: { sessionId: 'sess', waStatusId: 'dup' } });
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(rows[0].id);
  });

  it('list maps rows to the Status shape newest-first, media path -> mediaUrl endpoint', async () => {
    const out = await service.list('sess');
    expect(out[0].contact.id).toBe('628111@c.us');
    expect(out[0].timestamp).toBeInstanceOf(Date);
    expect(out[0].expiresAt).toBeInstanceOf(Date);
    // Sorted newest (highest postedAt) first: w4 (4000) precedes w1 (1000).
    const postedOrder = out.map(s => s.timestamp.getTime());
    expect(postedOrder).toEqual([...postedOrder].sort((a, b) => b - a));

    const withMedia = out.find(s => s.id === 'w2')!;
    expect(withMedia.mediaUrl).toBe('/api/sessions/sess/status/w2/media');
    const omitted = out.find(s => s.id === 'w3')!;
    expect(omitted.mediaUrl).toBeUndefined();
    const textOnly = out.find(s => s.id === 'w1')!;
    expect(textOnly.mediaUrl).toBeUndefined();
  });

  it('listByContact filters to only that contact', async () => {
    await service.ingest('sess', { waStatusId: 'w5', contactJid: '628222@c.us', type: 'text', postedAt: 6000 });
    const out = await service.listByContact('sess', '628222@c.us');
    expect(out).toHaveLength(1);
    expect(out[0].contact.id).toBe('628222@c.us');
  });

  it('getMedia returns the path/mimetype for a status with kept media', async () => {
    const media = await service.getMedia('sess', 'w2');
    expect(media?.mimetype).toBe('image/jpeg');
    expect(media?.path).toContain('statuses/sess/');
  });

  it('getMedia returns null for an omitted-media status', async () => {
    expect(await service.getMedia('sess', 'w3')).toBeNull();
  });

  it('getMedia returns null for a text-only status', async () => {
    expect(await service.getMedia('sess', 'w1')).toBeNull();
  });

  it('getMedia returns null for an unknown status id', async () => {
    expect(await service.getMedia('sess', 'nope')).toBeNull();
  });

  it('ingest marks media write_failed when the storage backend throws', async () => {
    const failingStorage = {
      putFile: jest.fn().mockRejectedValue(new Error('disk full')),
    } as unknown as StorageService;
    const failingService = new StatusStoreService(repository, failingStorage, fakeConfigService());
    const row = await failingService.ingest('sess', {
      waStatusId: 'w6',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('y').toString('base64') },
      postedAt: 7000,
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('write_failed');
    expect(row.mediaPath).toBeFalsy();
  });

  it('respects a configured status.mediaMaxBytes cap', async () => {
    const strictService = new StatusStoreService(
      repository,
      storageService,
      fakeConfigService({ 'status.mediaMaxBytes': 0 }),
    );
    const row = await strictService.ingest('sess', {
      waStatusId: 'w7',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/png', data: Buffer.from('z').toString('base64') },
      postedAt: 8000,
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('over_cap');
  });
});

describe('StatusStoreService.purgeExpired', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;
  let service: StatusStoreService;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-purge-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
    service = new StatusStoreService(repository, storageService, fakeConfigService());
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const ingestWithMedia = (waStatusId: string, postedAt: number): Promise<StatusUpdate> =>
    service.ingest('sess', {
      waStatusId,
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from(waStatusId).toString('base64') },
      postedAt,
    });

  it('deletes expired rows and their media files, keeps live ones', async () => {
    const expiredWithMedia = await ingestWithMedia('expired-media', 1000);
    await service.ingest('sess', {
      waStatusId: 'expired-text',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: 2000,
    });
    const live = await ingestWithMedia('live-media', Date.now());

    const mediaFile = path.join(baseDir, 'media', expiredWithMedia.mediaPath!);
    expect(fs.existsSync(mediaFile)).toBe(true);

    const now = 2000 + 24 * 60 * 60 * 1000 + 1; // after both 1000/2000-posted rows expire, before `live`
    const removed = await service.purgeExpired(now);

    expect(removed).toBe(2);
    expect(fs.existsSync(mediaFile)).toBe(false);
    const remaining = await repository.find();
    expect(remaining.map(r => r.waStatusId)).toEqual(['live-media']);
    expect(fs.existsSync(path.join(baseDir, 'media', live.mediaPath!))).toBe(true);
  });

  it('returns 0 and touches nothing when no rows are expired', async () => {
    await ingestWithMedia('live', Date.now());
    const removed = await service.purgeExpired(0);
    expect(removed).toBe(0);
    expect(await repository.count()).toBe(1);
  });
});

describe('StatusStoreService onModuleInit/onModuleDestroy (purge scheduling)', () => {
  const mockDeps = (): { repo: Repository<StatusUpdate>; storage: StorageService; find: jest.Mock } => {
    const find = jest.fn().mockResolvedValue([]);
    const repo = { find } as unknown as Repository<StatusUpdate>;
    const storage = {} as StorageService;
    return { repo, storage, find };
  };

  it('purges once at startup and schedules a recurring sweep, cleared on destroy', () => {
    const { repo, storage } = mockDeps();
    const service = new StatusStoreService(repo, storage, fakeConfigService());

    jest.useFakeTimers();
    try {
      const purgeSpy = jest.spyOn(service, 'purgeExpired').mockResolvedValue(0);
      service.onModuleInit();
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      purgeSpy.mockClear();
      jest.advanceTimersByTime(15 * 60 * 1000);
      expect(purgeSpy).toHaveBeenCalledTimes(1);

      service.onModuleDestroy();
      purgeSpy.mockClear();
      jest.advanceTimersByTime(15 * 60 * 1000);
      expect(purgeSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
