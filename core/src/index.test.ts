
import { it, expect } from 'vitest'

it('should declare global object core when importing the module and then deleting it', async () => {
  // Await the import: an un-awaited one can still be loading modules when
  // the environment tears down, which vitest 5 reports as an error.
  await import('./index');
  delete globalThis.core;
  expect(typeof globalThis.core).toBe('undefined');
});
