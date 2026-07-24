import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { In, LessThan, MoreThan, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { StatusUpdate } from './entities/status-update.entity';
import type { IncomingStatus } from './incoming-status';
import type { Status } from '../../engine/interfaces/whatsapp-engine.interface';
import { StorageService } from '../../common/storage/storage.service';
import { isUniqueConstraintError } from '../../common/utils/unique-constraint.util';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { userPart } from '../../engine/identity/wa-id';
import { createLogger } from '../../common/services/logger.service';

/** A status/story lives for 24h from posting, matching WhatsApp's own expiry. Exported for the
 * session service's seed, which skips backfilling statuses that have already run out their TTL. */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
/** How often the TTL purge sweeps expired rows. */
const PURGE_INTERVAL_MS = 15 * 60 * 1000;
/** Default per-file cap on persisted status media. Exported for the session service's seed, which
 * pre-gates history downloads at the same cap so over-cap blobs are never fetched. */
export const DEFAULT_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** Subtypes whose registered mimetype name differs from the conventional file extension. */
const MIME_SUBTYPE_EXT_OVERRIDES: Record<string, string> = { jpeg: 'jpg', quicktime: 'mov' };

/** File extension to store a status media blob under, derived from its mimetype; 'bin' when unrecognized. */
function extFromMimetype(mimetype: string): string {
  const subtype = mimetype.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!subtype || !/^[a-z0-9]+$/.test(subtype)) return 'bin';
  return MIME_SUBTYPE_EXT_OVERRIDES[subtype] ?? subtype;
}

/**
 * Persists inbound status/story broadcasts (`StatusUpdate` rows) with a 24h TTL, storing any attached
 * media through `StorageService`. Runs its own purge sweep (once at startup, then every 15 minutes) so
 * the store never accumulates stories past their WhatsApp-side expiry.
 */
@Injectable()
export class StatusStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('StatusStoreService');
  private purgeTimer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectRepository(StatusUpdate, 'data')
    private readonly repository: Repository<StatusUpdate>,
    private readonly storageService: StorageService,
    private readonly configService: ConfigService,
    // Optional, mirroring WebhookService: resolution is a best-effort display concern — without the
    // store, contacts just show under whichever JID the status arrived with.
    @Optional() private readonly lidMappingStore?: LidMappingStoreService,
  ) {}

  onModuleInit(): void {
    const runPurge = (): void => {
      this.purgeExpired(Date.now()).catch(err =>
        this.logger.error('Status purge failed', err instanceof Error ? err.stack : String(err)),
      );
    };
    runPurge(); // sweep once at startup
    this.purgeTimer = setInterval(runPurge, PURGE_INTERVAL_MS);
    this.purgeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
  }

  /**
   * Insert a status row (idempotent on `(sessionId, waStatusId)`), persisting any attached media.
   * `created` tells the caller whether this call actually inserted the row — false for a duplicate
   * delivery or a lost insert race — so a once-per-status side effect (the status.received webhook)
   * doesn't fire again for a status consumers already saw.
   */
  async ingest(sessionId: string, s: IncomingStatus): Promise<{ row: StatusUpdate; created: boolean }> {
    const existing = await this.repository.findOne({ where: { sessionId, waStatusId: s.waStatusId } });
    if (existing) return { row: existing, created: false };

    const row = new StatusUpdate();
    row.sessionId = sessionId;
    row.contactJid = s.contactJid;
    row.contactName = s.contactName;
    row.contactPushName = s.contactPushName;
    row.waStatusId = s.waStatusId;
    row.type = s.type;
    row.caption = s.caption;
    row.backgroundColor = s.backgroundColor;
    row.font = s.font;
    row.postedAt = s.postedAt;
    row.expiresAt = s.postedAt + STATUS_TTL_MS;
    await this.attachMedia(row, sessionId, s);

    try {
      return { row: await this.repository.save(row), created: true };
    } catch (error) {
      // The unique (sessionId, waStatusId) index is the idempotency backstop for a concurrent ingest
      // of the same status racing past the findOne check above; on a unique-constraint violation the
      // loser re-reads and returns the row the winner just inserted instead of surfacing the
      // constraint error to the caller. Any OTHER save error is a genuine persistence failure and
      // must propagate — never be masked by a coincidentally matching row.
      const winner = await this.repository.findOne({ where: { sessionId, waStatusId: s.waStatusId } });
      // This call's row was never saved, so the file attachMedia wrote for it (its own random key)
      // is referenced by no row, and purgeExpired — which only sweeps expired rows' files — could
      // never reap it. Delete it here or a failed ingest leaks one orphan per failure. The guard
      // skips the pathological case where the re-read row is this very insert (driver errored on a
      // commit that landed): there the file IS the persisted row's media. deleteFile treats an
      // already-missing file as success.
      if (row.mediaPath && row.mediaPath !== winner?.mediaPath) {
        await this.storageService.deleteFile(row.mediaPath).catch(() => undefined);
      }
      if (winner && isUniqueConstraintError(error)) return { row: winner, created: false };
      throw error;
    }
  }

  /** Sets the row's media* / mediaOmitted / omitReason fields, writing the file via StorageService when kept. */
  private async attachMedia(row: StatusUpdate, sessionId: string, s: IncomingStatus): Promise<void> {
    const media = s.media;
    if (!media) {
      row.mediaOmitted = false;
      return;
    }

    const maxBytes = this.configService.get<number>('status.mediaMaxBytes', DEFAULT_MEDIA_MAX_BYTES);
    const sizeBytes = media.sizeBytes ?? (media.data ? Buffer.byteLength(media.data, 'base64') : undefined);
    const withinCap = sizeBytes !== undefined && sizeBytes <= maxBytes;

    if (!media.omitted && media.data && withinCap) {
      const key = `statuses/${sessionId}/${randomUUID()}.${extFromMimetype(media.mimetype)}`;
      try {
        await this.storageService.putFile(key, Buffer.from(media.data, 'base64'));
        row.mediaPath = key;
        row.mediaMimetype = media.mimetype;
        row.mediaOmitted = false;
        return;
      } catch (error) {
        this.logger.error(
          `Failed to persist status media for session ${sessionId}, status ${s.waStatusId}`,
          error instanceof Error ? error.stack : String(error),
        );
        row.mediaOmitted = true;
        row.omitReason = 'write_failed';
        return;
      }
    }

    row.mediaOmitted = true;
    // A blob the engine skipped precisely because the caller tightened the cap below it (the status
    // seed's pre-gate) is over the STORE's cap — keep the reason truthful on both arrival paths.
    row.omitReason =
      sizeBytes !== undefined && sizeBytes > maxBytes ? 'over_cap' : media.omitted ? 'engine_omitted' : 'over_cap';
  }

  // Reads exclude already-expired rows: WhatsApp hides a status the moment its 24h are up, but the
  // purge sweep only reaps rows every 15 minutes — without the filter an expired status would stay
  // visible in the gap.
  async list(sessionId: string): Promise<Status[]> {
    const rows = await this.repository.find({
      where: { sessionId, expiresAt: MoreThan(Date.now()) },
      order: { postedAt: 'DESC' },
    });
    return rows.map(row => this.toStatus(row));
  }

  async listByContact(sessionId: string, contactJid: string): Promise<Status[]> {
    // The same person may hold rows under both a @lid and their @c.us (the mapping was learned
    // mid-window) — match every candidate so a resolved-form query doesn't silently miss lid rows.
    const candidates = new Set<string>([contactJid]);
    if (this.lidMappingStore) {
      const phone = userPart(contactJid);
      candidates.add(`${phone}@c.us`);
      // Forward-resolve a @lid query to its phone too, or rows ingested after the mapping was
      // learned (stored under @c.us) are missed by a consumer querying the raw lid.
      const resolved = this.lidMappingStore.getCached(phone);
      if (resolved) candidates.add(`${resolved}@c.us`);
      for (const lid of this.lidMappingStore.lidsForPhone(phone)) candidates.add(`${lid}@lid`);
    }
    const rows = await this.repository.find({
      where: { sessionId, contactJid: In([...candidates]), expiresAt: MoreThan(Date.now()) },
      order: { postedAt: 'DESC' },
    });
    return rows.map(row => this.toStatus(row));
  }

  /**
   * Canonical display form of a contact JID: resolve a @lid to its phone via the shared mapping.
   * Read-time (not ingest-time) on purpose: a mapping learned after the status arrived still merges
   * the contact's rows into one group. Only @lid inputs go through the map — its keys are raw digit
   * strings, so resolving a phone-shaped JID could collide with an unrelated lid. Unknown or
   * known-unresolved lids stay as-is.
   */
  private canonicalContactJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const phone = this.lidMappingStore?.getCached(userPart(jid));
    return phone ? `${phone}@c.us` : jid;
  }

  private toStatus(row: StatusUpdate): Status {
    return {
      id: row.waStatusId,
      contact: { id: this.canonicalContactJid(row.contactJid), name: row.contactName, pushName: row.contactPushName },
      type: row.type,
      caption: row.caption,
      mediaUrl:
        row.mediaPath && !row.mediaOmitted
          ? `/api/sessions/${row.sessionId}/status/${row.waStatusId}/media`
          : undefined,
      backgroundColor: row.backgroundColor,
      font: row.font,
      timestamp: new Date(row.postedAt),
      expiresAt: new Date(row.expiresAt),
    };
  }

  async getMedia(sessionId: string, statusId: string): Promise<{ path: string; mimetype: string } | null> {
    const row = await this.repository.findOne({
      where: { sessionId, waStatusId: statusId, expiresAt: MoreThan(Date.now()) },
    });
    if (!row || row.mediaOmitted || !row.mediaPath || !row.mediaMimetype) return null;
    return { path: row.mediaPath, mimetype: row.mediaMimetype };
  }

  /** Deletes rows (and their media files) whose `expiresAt` is before `now`. Returns the count removed. */
  async purgeExpired(now: number): Promise<number> {
    const expired = await this.repository.find({ where: { expiresAt: LessThan(now) } });
    if (expired.length === 0) return 0;

    await Promise.all(
      expired
        .filter((row): row is StatusUpdate & { mediaPath: string } => !!row.mediaPath)
        .map(row =>
          this.storageService
            .deleteFile(row.mediaPath)
            .catch(err =>
              this.logger.warn(`Failed to delete expired status media ${row.mediaPath}`, { error: String(err) }),
            ),
        ),
    );

    const result = await this.repository.delete(expired.map(row => row.id));
    return result.affected ?? expired.length;
  }
}
