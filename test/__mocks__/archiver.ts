/**
 * Unit-test stub for `archiver` (ESM-only). ts-jest runs in CommonJS mode, so any source file that
 * imports it — directly (StorageService) or transitively (anything that injects StorageService or a
 * module built on it, e.g. StatusStoreService) — fails to parse without this stub once pulled into the
 * unit test graph. None of the unit suites exercise the tar/zip export path itself (that's covered by
 * the e2e config's real `archiver` via transformIgnorePatterns), so stubs for TarArchive and default
 * export are sufficient.
 */

export const TarArchive = jest.fn(() => ({
  on: jest.fn(function () {
    return this;
  }),
  pipe: jest.fn(function () {
    return this;
  }),
  append: jest.fn(function () {
    return this;
  }),
  finalize: jest.fn(() => Promise.resolve()),
}));

export default jest.fn();
