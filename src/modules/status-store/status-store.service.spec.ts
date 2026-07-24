import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';

jest.mock('archiver', () => ({ default: jest.fn() }));

import { StorageService } from '../../common/storage/storage.service';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
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

  it('ingest writes a text row with expiresAt = postedAt + 24h, flagged as created', async () => {
    const postedAt = Date.now();
    const { row, created } = await service.ingest('sess', {
      waStatusId: 'w1',
      contactJid: '628111@c.us',
      type: 'text',
      caption: 'hi',
      postedAt,
    });
    expect(created).toBe(true);
    expect(row.expiresAt).toBe(postedAt + 24 * 60 * 60 * 1000);
    expect(row.mediaOmitted).toBe(false);
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest persists text-status styling and serves it back in the API shape', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'styled',
      contactJid: '628111@c.us',
      type: 'text',
      caption: 'hi',
      backgroundColor: '#25d366',
      font: 2,
      postedAt: Date.now(),
    });
    expect(row.backgroundColor).toBe('#25d366');
    expect(row.font).toBe(2);

    const styled = (await service.list('sess')).find(s => s.id === 'styled')!;
    expect(styled.backgroundColor).toBe('#25d366');
    expect(styled.font).toBe(2);
  });

  it('ingest persists media to a file under the cap and records mediaPath', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'w2',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('x').toString('base64') },
      postedAt: Date.now(),
    });
    expect(row.mediaPath).toBeTruthy();
    expect(row.mediaMimetype).toBe('image/jpeg');
    expect(row.mediaOmitted).toBe(false);
    expect(row.mediaPath!.endsWith('.jpg')).toBe(true);
    // The file was actually written under the storage root.
    expect(fs.readFileSync(path.join(baseDir, 'media', row.mediaPath!), 'utf8')).toBe('x');
  });

  it('ingest marks media omitted when the engine already omitted it', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'w3',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', omitted: true, sizeBytes: 99 },
      postedAt: Date.now(),
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('engine_omitted');
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest marks media omitted when sizeBytes exceeds STATUS_MEDIA_MAX_BYTES', async () => {
    const { row } = await service.ingest('sess', {
      waStatusId: 'w4',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: '...', sizeBytes: 999_999_999 },
      postedAt: Date.now(),
    });
    expect(row.mediaOmitted).toBe(true);
    expect(row.omitReason).toBe('over_cap');
    expect(row.mediaPath).toBeFalsy();
  });

  it('ingest is idempotent on (sessionId, waStatusId), flagged as not created on the duplicate', async () => {
    await service.ingest('sess', { waStatusId: 'dup', contactJid: '628111@c.us', type: 'text', postedAt: 1 });
    const second = await service.ingest('sess', {
      waStatusId: 'dup',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: 1,
    });
    const rows = await repository.find({ where: { sessionId: 'sess', waStatusId: 'dup' } });
    expect(rows).toHaveLength(1);
    expect(second.row.id).toBe(rows[0].id);
    expect(second.created).toBe(false);
  });

  it('list maps rows to the Status shape newest-first, media path -> mediaUrl endpoint', async () => {
    const out = await service.list('sess');
    expect(out[0].contact.id).toBe('628111@c.us');
    expect(out[0].timestamp).toBeInstanceOf(Date);
    expect(out[0].expiresAt).toBeInstanceOf(Date);
    // Sorted newest (highest postedAt) first.
    const postedOrder = out.map(s => s.timestamp.getTime());
    expect(postedOrder).toEqual([...postedOrder].sort((a, b) => b - a));

    const withMedia = out.find(s => s.id === 'w2')!;
    expect(withMedia.mediaUrl).toBe('/api/sessions/sess/status/w2/media');
    const omitted = out.find(s => s.id === 'w3')!;
    expect(omitted.mediaUrl).toBeUndefined();
    const textOnly = out.find(s => s.id === 'w1')!;
    expect(textOnly.mediaUrl).toBeUndefined();
  });

  it('list and listByContact exclude already-expired rows (the purge sweep only runs every 15 min)', async () => {
    await service.ingest('sess', {
      waStatusId: 'stale',
      contactJid: '628111@c.us',
      type: 'text',
      postedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h old — past the 24h TTL
    });
    expect((await service.list('sess')).map(s => s.id)).not.toContain('stale');
    expect((await service.listByContact('sess', '628111@c.us')).map(s => s.id)).not.toContain('stale');
  });

  it('getMedia treats an expired row as absent (404, matching "not found or expired")', async () => {
    await service.ingest('sess', {
      waStatusId: 'stale-media',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('old').toString('base64') },
      postedAt: Date.now() - 25 * 60 * 60 * 1000,
    });
    expect(await service.getMedia('sess', 'stale-media')).toBeNull();
  });

  it('listByContact filters to only that contact', async () => {
    await service.ingest('sess', { waStatusId: 'w5', contactJid: '628222@c.us', type: 'text', postedAt: Date.now() });
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
    const { row } = await failingService.ingest('sess', {
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
    const { row } = await strictService.ingest('sess', {
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

describe('StatusStoreService ingest race (unique-constraint loser)', () => {
  let baseDir: string;
  let storageService: StorageService;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-race-'));
    storageService = makeStorageService(path.join(baseDir, 'media'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const mediaDir = (): string[] => fs.readdirSync(path.join(baseDir, 'media', 'statuses', 'sess'));

  it('reaps the media file it wrote when a concurrent ingest wins the unique constraint', async () => {
    // The winner committed its own media file; the loser must not leave a second, orphaned one.
    fs.mkdirSync(path.join(baseDir, 'media', 'statuses', 'sess'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'media', 'statuses', 'sess', 'winner.jpg'), 'winner');
    const winner = new StatusUpdate();
    winner.mediaPath = 'statuses/sess/winner.jpg';
    // First findOne (top of ingest) sees nothing; the post-save-failure re-read returns the winner.
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      save: jest.fn().mockRejectedValue(new Error('UNIQUE constraint failed')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    const { row, created } = await service.ingest('sess', {
      waStatusId: 'raced',
      contactJid: '628111@c.us',
      type: 'image',
      media: { mimetype: 'image/jpeg', data: Buffer.from('loser').toString('base64') },
      postedAt: 1000,
    });

    expect(row).toBe(winner);
    expect(created).toBe(false);
    expect(mediaDir()).toEqual(['winner.jpg']);
  });

  it('reaps the file it wrote when the save fails with no winner row, then rethrows', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockRejectedValue(new Error('database is locked')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    await expect(
      service.ingest('sess', {
        waStatusId: 'raced',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('loser').toString('base64') },
        postedAt: 1000,
      }),
    ).rejects.toThrow('database is locked');

    expect(mediaDir()).toHaveLength(0);
  });

  it('keeps the file but still rethrows when the re-read row is this very insert (driver errored on a commit that landed)', async () => {
    const repo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(null)
        // The row that "landed" references exactly the file this ingest just wrote.
        .mockImplementation(() => {
          const selfRow = new StatusUpdate();
          selfRow.mediaPath = `statuses/sess/${mediaDir()[0]}`;
          return Promise.resolve(selfRow);
        }),
      save: jest.fn().mockRejectedValue(new Error('driver reported failure after commit')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    // Not a unique-constraint error, so the failure surfaces even though a row exists — but the
    // file is kept: the re-read row IS this insert, so its media is still referenced.
    await expect(
      service.ingest('sess', {
        waStatusId: 'raced',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('self').toString('base64') },
        postedAt: 1000,
      }),
    ).rejects.toThrow('driver reported failure after commit');

    expect(mediaDir()).toHaveLength(1);
  });

  it('rethrows a non-unique save error even when a coincidental winner row exists', async () => {
    fs.mkdirSync(path.join(baseDir, 'media', 'statuses', 'sess'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'media', 'statuses', 'sess', 'winner.jpg'), 'winner');
    const winner = new StatusUpdate();
    winner.mediaPath = 'statuses/sess/winner.jpg';
    const repo = {
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
      save: jest.fn().mockRejectedValue(new Error('database is locked')),
    } as unknown as Repository<StatusUpdate>;
    const service = new StatusStoreService(repo, storageService, fakeConfigService());

    // A genuine persistence failure must not be swallowed into an idempotent return just because
    // a matching row happens to exist — and this call's own file is still reaped.
    await expect(
      service.ingest('sess', {
        waStatusId: 'raced',
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from('loser').toString('base64') },
        postedAt: 1000,
      }),
    ).rejects.toThrow('database is locked');

    expect(mediaDir()).toEqual(['winner.jpg']);
  });
});

describe('StatusStoreService contact identity (read-time lid resolution)', () => {
  let baseDir: string;
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;
  let storageService: StorageService;

  beforeEach(async () => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-lid-'));
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
    storageService = makeStorageService(path.join(baseDir, 'media'));
  });

  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const lidStore = (mappings: Record<string, string | null>): LidMappingStoreService =>
    ({
      getCached: (lid: string) => (lid in mappings ? mappings[lid] : undefined),
      lidsForPhone: (phone: string) =>
        Object.entries(mappings)
          .filter(([, p]) => p === phone)
          .map(([l]) => l),
    }) as unknown as LidMappingStoreService;

  it('resolves a @lid contact to the mapped phone at read time, so both forms group together', async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '111': '628111' }));
    const now = Date.now();
    await svc.ingest('sess', { waStatusId: 'l1', contactJid: '111@lid', type: 'text', postedAt: now });
    await svc.ingest('sess', { waStatusId: 'l2', contactJid: '628111@c.us', type: 'text', postedAt: now + 1 });

    const contacts = new Set((await svc.list('sess')).map(s => s.contact.id));
    expect(contacts).toEqual(new Set(['628111@c.us']));
  });

  it('leaves unknown and known-unresolved lids untouched', async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '222': null }));
    const now = Date.now();
    await svc.ingest('sess', { waStatusId: 'u1', contactJid: '222@lid', type: 'text', postedAt: now });
    await svc.ingest('sess', { waStatusId: 'u2', contactJid: '333@lid', type: 'text', postedAt: now + 1 });

    const contacts = (await svc.list('sess')).map(s => s.contact.id);
    expect(contacts).toContain('222@lid');
    expect(contacts).toContain('333@lid');
  });

  it("listByContact matches rows stored under the contact's lid when queried by phone", async () => {
    const svc = new StatusStoreService(repository, storageService, fakeConfigService(), lidStore({ '111': '628111' }));
    await svc.ingest('sess', { waStatusId: 'l3', contactJid: '111@lid', type: 'text', postedAt: Date.now() });

    const out = await svc.listByContact('sess', '628111@c.us');
    expect(out).toHaveLength(1);
    expect(out[0].contact.id).toBe('628111@c.us');
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

  const ingestWithMedia = async (waStatusId: string, postedAt: number): Promise<StatusUpdate> =>
    (
      await service.ingest('sess', {
        waStatusId,
        contactJid: '628111@c.us',
        type: 'image',
        media: { mimetype: 'image/jpeg', data: Buffer.from(waStatusId).toString('base64') },
        postedAt,
      })
    ).row;

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
