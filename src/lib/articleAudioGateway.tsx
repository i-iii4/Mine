import { createContext, useContext, type ReactNode } from "react";

import type { ArticleAudioState } from "@/types";

export interface ArticleAudioUpdatedEvent {
  slug: string;
}

export interface ArticleAudioPlaybackSource {
  url: string;
}

export interface ArticleAudioGateway {
  getState(slug: string): Promise<ArticleAudioState>;
  generate(slug: string): Promise<ArticleAudioState>;
  remove(slug: string): Promise<void>;
  setPosition(
    slug: string,
    positionMs: number,
    durationMs: number | null,
    completed: boolean,
  ): Promise<void>;
  resolvePlaybackSource(state: ArticleAudioState): ArticleAudioPlaybackSource | null;
  subscribe(
    onUpdated: (event: ArticleAudioUpdatedEvent) => void,
  ): Promise<() => void>;
}

const ArticleAudioGatewayContext = createContext<ArticleAudioGateway | null>(null);

interface ArticleAudioGatewayProviderProps {
  gateway: ArticleAudioGateway;
  children: ReactNode;
}

/** Provides the active article-audio transport implementation to the UI tree. */
export function ArticleAudioGatewayProvider({
  gateway,
  children,
}: ArticleAudioGatewayProviderProps) {
  return (
    <ArticleAudioGatewayContext.Provider value={gateway}>
      {children}
    </ArticleAudioGatewayContext.Provider>
  );
}

/** Returns the current article-audio gateway. */
export function useArticleAudioGateway(): ArticleAudioGateway {
  const gateway = useContext(ArticleAudioGatewayContext);
  if (!gateway) {
    throw new Error("ArticleAudioGatewayProvider is missing from the React tree.");
  }
  return gateway;
}
