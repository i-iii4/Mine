import { listen } from "@tauri-apps/api/event";

import { audioAssetUrl } from "@/lib/assets";
import {
  deleteArticleAudio,
  generateArticleAudio,
  getArticleAudioState,
  setArticleAudioPosition,
} from "@/lib/commands";
import type { ArticleAudioState } from "@/types";

import type {
  ArticleAudioGateway,
  ArticleAudioPlaybackSource,
  ArticleAudioUpdatedEvent,
} from "./articleAudioGateway";

const ARTICLE_AUDIO_UPDATED_EVENT = "article-audio-updated";

function resolveDesktopPlaybackSource(
  state: ArticleAudioState,
): ArticleAudioPlaybackSource | null {
  if (state.status !== "ready" || !state.audio_path) {
    return null;
  }
  return {
    url: audioAssetUrl(state.audio_path),
  };
}

/** Desktop article-audio gateway backed by Tauri IPC and asset protocol URLs. */
export const desktopArticleAudioGateway: ArticleAudioGateway = {
  getState: getArticleAudioState,
  generate: generateArticleAudio,
  remove: deleteArticleAudio,
  setPosition: setArticleAudioPosition,
  resolvePlaybackSource: resolveDesktopPlaybackSource,
  subscribe: async (onUpdated) =>
    listen<ArticleAudioUpdatedEvent>(ARTICLE_AUDIO_UPDATED_EVENT, (event) => {
      onUpdated(event.payload);
    }),
};
