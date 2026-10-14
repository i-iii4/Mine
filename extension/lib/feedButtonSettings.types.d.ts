/** Whether the Mine buttons stand on the posts of X and of Instagram. */
export interface FeedButtonSettings {
  x: boolean;
  instagram: boolean;
}

declare global {
  var MineFeedButtonSettings: {
    /** The `chrome.storage.local` key of the switches. */
    readonly STORAGE_KEY: string;
    readonly DEFAULTS: Readonly<FeedButtonSettings>;
    normalize(value: unknown): FeedButtonSettings;
    read(local: Pick<chrome.storage.StorageArea, "get">): Promise<FeedButtonSettings>;
    watch(
      storage: Pick<typeof chrome.storage, "onChanged">,
      onChange: (settings: FeedButtonSettings) => void,
    ): () => void;
  };
}
