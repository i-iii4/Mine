// Provider identity shared by content scripts, the clipper and desktop rendering.
(function (root) {
  "use strict";

  function parse(value) {
    if (typeof value !== "string") return null;
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    let videoId = null;
    if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") {
      videoId = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/)?.[1] ?? null;
    } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
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

  root.MineYoutubeSource = Object.freeze({ parse });
})(globalThis);
