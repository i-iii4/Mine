// Provider identity shared by content scripts, the clipper and desktop rendering.
(function (root) {
  "use strict";

  const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com"];
  const OEMBED_ENDPOINT = "https://www.youtube.com/oembed";
  // How long the clipper waits for a video's channel: the background request
  // and the Save that needs its answer share this bound
  // (SPEC_CARD_ASSOCIATIONS.md, «Клиппер: канал YouTube»).
  const YOUTUBE_CHANNEL_TIMEOUT_MS = 3000;

  function parse(value) {
    if (typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let videoId = null;
    if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
      videoId = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
    } else if (YOUTUBE_HOSTS.includes(url.hostname)) {
      if (url.pathname === "/watch") {
        const values = url.searchParams.getAll("v");
        if (values.length === 1) videoId = values[0];
      } else {
        videoId = url.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
      }
    }
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    return {
      provider: "youtube",
      videoId,
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
      embedUrl: `https://www.youtube.com/embed/${videoId}`,
      posterUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    };
  }

  // The oEmbed request for the video of an address. It names the video by
  // its id, so the answer belongs to exactly that video, whatever the page's
  // markup still shows after an in-page navigation.
  function youtubeOEmbedUrl(value) {
    const source = parse(value);
    if (!source) return null;
    return `${OEMBED_ENDPOINT}?format=json&url=${encodeURIComponent(source.sourceUrl)}`;
  }

  // `@handle` of a channel page address `https://<youtube host>/@handle`.
  function channelHandle(value) {
    if (typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!YOUTUBE_HOSTS.includes(url.hostname)) return null;
    const encoded = url.pathname.match(/^\/@([^/]+)\/?$/)?.[1];
    if (!encoded) return null;
    let handle;
    // A malformed escape is not a handle; the channel name stands in.
    try { handle = decodeURIComponent(encoded); } catch { return null; }
    return handle && !/[\s/@]/.test(handle) ? `@${handle}` : null;
  }

  // The channel of an oEmbed answer, written the way X and Instagram authors
  // are: `@handle` from `author_url`, else the channel name.
  function youtubeChannelFromOEmbed(payload) {
    if (!payload || typeof payload !== "object") return null;
    const handle = channelHandle(payload.author_url);
    if (handle) return handle;
    const name = typeof payload.author_name === "string" ? payload.author_name.trim() : "";
    return name || null;
  }

  root.MineYoutubeSource = Object.freeze({
    parse,
    youtubeOEmbedUrl,
    youtubeChannelFromOEmbed,
    YOUTUBE_CHANNEL_TIMEOUT_MS,
  });
})(globalThis);
