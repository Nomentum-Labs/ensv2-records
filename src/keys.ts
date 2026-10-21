/**
 * Where to learn which text-record keys a name actually has. The UniversalResolver can't
 * enumerate keys, so without this only the default key list is fetched. The records indexer
 * (phase 2) will implement this from TextUpdated/TextChanged events.
 */
export interface KeySource {
  keysFor(name: string): Promise<string[]>;
}

export const noExtraKeys: KeySource = {
  async keysFor() {
    return [];
  },
};
