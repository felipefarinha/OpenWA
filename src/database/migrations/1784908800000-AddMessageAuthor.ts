import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `author` column to the `messages` table. For a group message this stores the participant
 * JID who actually posted (the row's `from` is the group JID), giving the chat view a stable
 * sender identity — two participants who share a pushName no longer collapse into one attribution
 * run. Null for one-to-one messages, outgoing echoes, and legacy rows.
 *
 * Hand-authored because `synchronize` is off for the `data` connection on PostgreSQL (and optional
 * on SQLite via DATABASE_SYNCHRONIZE=false). Idempotent: checks for column existence first.
 */
export class AddMessageAuthor1784908800000 implements MigrationInterface {
  name = 'AddMessageAuthor1784908800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('messages');
    const col = table?.findColumnByName('author');
    if (col) return; // already added by synchronize or a previous run

    await queryRunner.query(`ALTER TABLE "messages" ADD COLUMN "author" varchar NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const table = await queryRunner.getTable('messages');
    const col = table?.findColumnByName('author');
    if (!col) return;
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "author"`);
  }
}
