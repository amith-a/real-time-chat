// Suppress noisy JSON logger output written directly to stdout/stderr during unit tests.
// vi.spyOn(process.stdout, 'write') in logger.test.ts still records calls normally.
if (process.env.VITEST_VERBOSE_LOGS !== 'true') {
  process.stdout.write = () => true;
  process.stderr.write = () => true;
}
