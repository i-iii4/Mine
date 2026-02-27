// Popup logic: auto-detect content type, channel picker, save.

(() => {
  "use strict";

  // -- State ------------------------------------------------------------------

  let metadata = null;
  let articleData = null;
  let channels = [];
  let selectedTags = [];
  let recentTags = [];
  let currentType = "content";
  let contextMenuData = null;

  // -- DOM refs ---------------------------------------------------------------

  const $ = (sel) => document.querySelector(sel);

  const loadingState = $("#loading-state");
  const errorState = $("#error-state");
  const errorMessage = $("#error-message");
  const mainState = $("#main-state");

  const previewCard = $("#preview-card");
  const previewThumb = $("#preview-thumb");
  const previewDomain = $("#preview-domain");
  const titleInput = $("#title-input");
  const imagePreview = $("#image-preview");
  const imagePreviewImg = $("#image-preview-img");
  const typeSwitcher = $("#type-switcher");
  const previewText = $("#preview-text");
  const channelSearch = $("#channel-search");
  const channelList = $("#channel-list");
  const channelsLabel = $("#channels-label");
  const saveBtn = $("#save-btn");
  const saveLabel = $("#save-label");
  const saveSpinner = $("#save-spinner");
  const statusBar = $("#status-bar");
  const statusText = $("#status-text");

  // -- Native messaging -------------------------------------------------------

  async function sendToNative(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { target: "background", action: "nativeMessage", payload },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: "No response" });
          }
        }
      );
    });
  }

  // -- Initialization ---------------------------------------------------------

  async function init() {
    try {
      // Clear any pending badge from context menu fallback
      chrome.action.setBadgeText({ text: "" });

      // Load recent channels from local storage
      const stored = await chrome.storage.local.get("recentChannels");
      recentTags = stored.recentChannels || [];

      // Check native host status
      const status = await sendToNative({ action: "get_status" });
      if (!status.ok) {
        showError(status.error || "Cannot connect to Local Arena");
        return;
      }

      // Load channels/tags
      const chResult = await sendToNative({ action: "list_channels" });
      if (chResult.ok) {
        channels = chResult.channels || [];
      }

      // Check for context menu data
      contextMenuData = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { target: "background", action: "getContextMenuData" },
          (data) => resolve(data)
        );
      });

      // Extract metadata from current page
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showError("Cannot access current tab");
        return;
      }

      metadata = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: "extractMetadata" }, (resp) => {
          if (chrome.runtime.lastError || !resp) {
            resolve({
              url: tab.url || "",
              title: tab.title || "",
              description: "",
              image: null,
              author: null,
              ogType: null,
              favicon: null,
              selection: "",
              detectedType: "link",
              isArticle: false,
            });
          } else {
            resolve(resp);
          }
        });
      });

      // Eager article extraction (parallel with UI setup)
      const articlePromise = new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: "extractArticle" }, (resp) => {
          resolve(resp || { title: "", content: "", byline: null, excerpt: "" });
        });
      });

      // Handle context menu overrides
      if (contextMenuData) {
        await applyContextMenu(contextMenuData, tab);
      }

      // Set domain in preview card
      try {
        const url = new URL(metadata.url);
        previewDomain.textContent = url.hostname.replace(/^www\./, "");
      } catch {
        previewDomain.textContent = "";
      }

      // Map detected type to UI type
      let detectedType = metadata.detectedType || "link";
      if (detectedType === "article" || detectedType === "selection") {
        detectedType = "content";
      }

      // Show thumbnail in preview card
      if (detectedType === "image" && metadata.imageToSave) {
        // For image type, hide the card thumb (full preview shown separately)
        previewThumb.classList.add("hidden");
      } else if (metadata.image) {
        previewThumb.src = metadata.image;
        previewThumb.classList.remove("hidden");
      } else if (metadata.favicon) {
        previewThumb.src = metadata.favicon;
        previewThumb.classList.remove("hidden");
      }

      // Build type switcher
      buildTypeSwitcher(detectedType);
      setType(detectedType);

      // Wait for article extraction
      articleData = await articlePromise;

      // Populate fields
      titleInput.value = metadata.title || "";
      updatePreview();

      // Show channel list immediately
      renderChannelList("");

      // Show main UI
      loadingState.classList.add("hidden");
      mainState.classList.remove("hidden");
    } catch (e) {
      showError("Failed to initialize: " + e.message);
    }
  }

  async function applyContextMenu(ctx, tab) {
    switch (ctx.menuItemId) {
      case "save-image":
        metadata.detectedType = "image";
        metadata.imageToSave = ctx.srcUrl;
        // Try to get image info (alt, dimensions)
        if (tab?.id && ctx.srcUrl) {
          try {
            const imgInfo = await new Promise((resolve) => {
              chrome.tabs.sendMessage(
                tab.id,
                { action: "getImageInfo", src: ctx.srcUrl },
                (resp) => resolve(resp || {})
              );
            });
            if (imgInfo.alt) metadata.imageAlt = imgInfo.alt;
            if (imgInfo.width) metadata.imageWidth = imgInfo.width;
            if (imgInfo.height) metadata.imageHeight = imgInfo.height;
          } catch {
            // Ignore — info is optional
          }
        }
        break;
      case "save-selection":
        metadata.detectedType = "selection";
        metadata.selection = ctx.selectionText || metadata.selection;
        break;
      case "save-link":
        metadata.detectedType = "link";
        if (ctx.linkUrl) {
          metadata.url = ctx.linkUrl;
        }
        break;
      case "save-page":
        // Use detected type
        break;
    }
  }

  function showError(msg) {
    loadingState.classList.add("hidden");
    mainState.classList.add("hidden");
    errorState.classList.remove("hidden");
    errorMessage.textContent = msg;
  }

  // -- Type switcher ----------------------------------------------------------

  const TYPE_LABELS = {
    content: "Content",
    link: "Link",
    image: "Image",
    video: "Video",
  };

  function buildTypeSwitcher(detectedType) {
    // For image/video, hide the switcher (type is fixed)
    if (detectedType === "image" || detectedType === "video") {
      typeSwitcher.classList.add("hidden");
      return;
    }

    // Content | Link
    const types = ["content", "link"];
    typeSwitcher.innerHTML = "";
    for (const type of types) {
      const btn = document.createElement("button");
      btn.className = "type-btn";
      btn.dataset.type = type;
      btn.textContent = TYPE_LABELS[type];
      btn.addEventListener("click", () => setType(type));
      typeSwitcher.appendChild(btn);
    }
    typeSwitcher.classList.remove("hidden");
  }

  function setType(type) {
    currentType = type;

    // Update switcher button styles
    typeSwitcher.querySelectorAll(".type-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.type === type);
    });

    updatePreview();
  }

  function updatePreview() {
    if (!metadata) return;

    previewText.classList.add("hidden");
    imagePreview.classList.add("hidden");

    if (currentType === "image") {
      // Full-width image preview
      const imgUrl = metadata.imageToSave || metadata.image;
      if (imgUrl) {
        imagePreviewImg.src = imgUrl;
        imagePreview.classList.remove("hidden");
      }
      // Use alt text as title if title is empty
      if (!titleInput.value && metadata.imageAlt) {
        titleInput.value = metadata.imageAlt;
      }
    } else if (currentType === "content") {
      // Text excerpt preview
      let text = "";
      if (metadata.selection && metadata.selection.length > 0) {
        text = metadata.selection;
      } else if (articleData?.content) {
        text = articleData.content.slice(0, 200);
      }
      if (text) {
        previewText.textContent = text + (text.length >= 200 ? "..." : "");
        previewText.classList.remove("hidden");
      }
    }
    // For "link" and "video": only the compact card shows (thumbnail + title + domain)
  }

  // -- Channel list -----------------------------------------------------------

  function renderChannelList(filter) {
    const lc = filter.toLowerCase();
    const filtered = lc
      ? channels.filter(
          (ch) =>
            ch.title.toLowerCase().includes(lc) ||
            ch.tag.toLowerCase().includes(lc)
        )
      : channels.slice();

    // Sort: recent channels first, then by block_count DESC
    const recentSet = new Set(recentTags);
    filtered.sort((a, b) => {
      const aRecent = recentSet.has(a.tag);
      const bRecent = recentSet.has(b.tag);
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) {
        return recentTags.indexOf(a.tag) - recentTags.indexOf(b.tag);
      }
      return b.block_count - a.block_count;
    });

    // Update section header
    channelsLabel.textContent = lc ? "Channels" : "Recent";

    let html = "";
    for (const ch of filtered) {
      const isSelected = selectedTags.includes(ch.tag);
      const checkmark = isSelected ? "&#10003;" : "";
      html += `
        <div class="channel-item ${isSelected ? "selected" : ""}" data-tag="${ch.tag}">
          <span class="check">${checkmark}</span>
          <span class="channel-title">${ch.title}</span>
          <span class="count">${ch.block_count}</span>
        </div>
      `;
    }

    // Offer to create a new channel if the search doesn't match any existing
    if (filter && !filtered.some((ch) => ch.tag === slugify(filter))) {
      const newTag = slugify(filter);
      if (newTag) {
        html += `
          <div class="channel-item create-new" data-new-tag="${newTag}" data-new-title="${filter}">
            <span class="check">+</span>
            <span>Create "${filter}"</span>
          </div>
        `;
      }
    }

    channelList.innerHTML =
      html || '<div class="channel-empty">No channels yet</div>';

    // Bind click events
    channelList.querySelectorAll(".channel-item[data-tag]").forEach((el) => {
      el.addEventListener("click", () => toggleTag(el.dataset.tag));
    });

    channelList.querySelectorAll(".channel-item[data-new-tag]").forEach((el) => {
      el.addEventListener("click", async () => {
        const tag = el.dataset.newTag;
        const title = el.dataset.newTitle;
        await sendToNative({ action: "create_channel", tag, title });
        channels.push({ tag, title, block_count: 0 });
        toggleTag(tag);
        channelSearch.value = "";
        renderChannelList("");
      });
    });
  }

  function toggleTag(tag) {
    const idx = selectedTags.indexOf(tag);
    if (idx >= 0) {
      selectedTags.splice(idx, 1);
    } else {
      selectedTags.push(tag);
    }
    renderChannelList(channelSearch.value);
    updateSaveButton();
  }

  function updateSaveButton() {
    const n = selectedTags.length;
    if (n === 0) {
      saveLabel.textContent = "Save";
    } else if (n === 1) {
      saveLabel.textContent = "Save to 1 channel";
    } else {
      saveLabel.textContent = `Save to ${n} channels`;
    }
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/[\s_]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
  }

  // -- Save -------------------------------------------------------------------

  async function save() {
    if (!metadata) return;

    saveBtn.disabled = true;
    saveLabel.classList.add("hidden");
    saveSpinner.classList.remove("hidden");

    // Re-query selection right before saving (user may have changed it)
    if (currentType === "content" && metadata.selection?.length > 0) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab?.id) {
        const fresh = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            tab.id,
            { action: "extractMetadata" },
            (resp) => resolve(resp)
          );
        });
        if (fresh?.selection?.length > 0) {
          metadata.selection = fresh.selection;
        }
      }
    }

    // Determine block_type for backend
    let blockType;
    if (currentType === "content") {
      blockType = "article";
    } else if (currentType === "image") {
      blockType = "image";
    } else {
      blockType = currentType;
    }

    const payload = {
      action: "save_block",
      block_type: blockType,
      title: titleInput.value || null,
      description: null,
      url: metadata.url || null,
      body: "",
      tags: selectedTags.length > 0 ? selectedTags : null,
      image_url: null,
      author: metadata.author || null,
      width: null,
      height: null,
    };

    // Set body for content type (selection priority, then article)
    if (currentType === "content") {
      if (metadata.selection && metadata.selection.length > 0) {
        payload.body = metadata.selection;
      } else if (articleData?.content) {
        payload.body = articleData.content;
        if (articleData.byline) payload.author = articleData.byline;
      }
    }

    // Set image_url for types that need it
    if (currentType === "image" && metadata.imageToSave) {
      payload.image_url = metadata.imageToSave;
      payload.width = metadata.imageWidth || null;
      payload.height = metadata.imageHeight || null;
    } else if (metadata.image && (currentType === "link" || currentType === "video")) {
      payload.image_url = metadata.image;
    }

    const result = await sendToNative(payload);

    saveSpinner.classList.add("hidden");
    saveLabel.classList.remove("hidden");
    saveBtn.disabled = false;

    if (result.ok) {
      // Persist recent channels
      if (selectedTags.length > 0) {
        const updated = [
          ...selectedTags,
          ...recentTags.filter((t) => !selectedTags.includes(t)),
        ];
        recentTags = updated.slice(0, 10);
        chrome.storage.local.set({ recentChannels: recentTags });
      }
      showStatus("Saved!", "success");
      setTimeout(() => window.close(), 1200);
    } else {
      showStatus(result.error || "Failed to save", "error");
    }
  }

  function showStatus(msg, type) {
    statusBar.classList.remove("hidden", "success", "error");
    statusBar.classList.add(type);
    statusText.textContent = msg;
  }

  // -- Event listeners --------------------------------------------------------

  channelSearch.addEventListener("input", () => {
    renderChannelList(channelSearch.value);
  });

  saveBtn.addEventListener("click", save);

  // Cmd+Enter to save, Esc to close
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") {
      window.close();
    }
  });

  // -- Start ------------------------------------------------------------------

  init();
})();
