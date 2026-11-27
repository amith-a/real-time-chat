process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.AWS_REGION ??= 'ap-south-1';

// Suppress noisy JSON logger output written directly to stdout/stderr during unit tests.
// vi.spyOn(process.stdout, 'write') in logger.test.ts still records calls normally.
if (process.env.VITEST_VERBOSE_LOGS !== 'true') {
  process.stdout.write = () => true;
  process.stderr.write = () => true;
}
