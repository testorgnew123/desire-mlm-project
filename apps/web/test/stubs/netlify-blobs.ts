// Stands in for @netlify/blobs under test (see vitest.config.ts). The real
// package only works inside Netlify's runtime and throws MissingBlobsEnvironmentError
// anywhere else; the backup job's tests need it to accept a write.
const written = new Map<string, unknown>();

export function getStore(_name: string) {
  return {
    set: async (key: string, value: unknown) => void written.set(key, value),
    setJSON: async (key: string, value: unknown) => void written.set(key, value),
    get: async (key: string) => written.get(key) ?? null,
    list: async () => ({ blobs: [...written.keys()].map((key) => ({ key })) }),
    delete: async (key: string) => void written.delete(key),
  };
}

/** For a test to see what the job wrote. */
export const __written = written;
