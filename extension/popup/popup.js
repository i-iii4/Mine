// Popup logic: auto-detect content type, channel/tag picker, save.

(() => {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────────

  let metadata = null;
  let articleData = null;
  let channels = [];
  let selectedTags = [];
  let currentType = "link";
  let contextMenuData = null;

  // ── DOM refs ──────────────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);

  const loadingState = $("#loading-state");
  const errorState = $("#error-state");
  const errorMessage = $("#error-message");
  const mainState = $("#main-state");

  const typeSwitcher = $("#type-switcher");
  const previewImage = $("#preview-image");
  const previewText = $("#preview-text");
  const titleInput = $("#title-input");
  const descriptionInput = $("#description-input");
  const descriptionField = $("#description-field");
  const channelSearch = $("#channel-search");
  const channelList = $("#channel-list");
  const selectedChannels = $("#selected-channels");
  const saveBtn = $("#save-btn");
  const saveLabel = $("#save-label");
  const saveSpinner = $("#save-spinner");
  const cancelBtn = $("#cancel-btn");
  const statusBar = $("#status-bar");
  const statusText = $("#status-text");

  // ── Native messaging ─────────────────────────────────────────────────────

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

  // ── Initialization ────────────────────────────────────────────────────────

  async function init() {
    try {
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

      // Eager article extraction — runs in parallel with UI setup
      const articlePromise = new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { action: "extractArticle" }, (resp) => {
          resolve(resp || { title: "", content: "", byline: null, excerpt: "" });
        });
      });

      // Handle context menu overrides
      if (contextMenuData) {
        applyContextMenu(contextMenuData);
      }

      // Set type and build switcher
      const detectedType = metadata.detectedType || "link";
      buildTypeSwitcher(detectedType);
      setType(detectedType);

      // Wait for eager article extraction to complete
      articleData = await articlePromise;

      // Populate fields
      titleInput.value = metadata.title || "";
      descriptionInput.value = metadata.description || "";
      updatePreview();

      // Show main UI
      loadingState.classList.add("hidden");
      mainState.classList.remove("hidden");
    } catch (e) {
      showError("Failed to initialize: " + e.message);
    }
  }

  function applyContextMenu(ctx) {
    switch (ctx.menuItemId) {
      case "save-image":
        metadata.detectedType = "image";
        metadata.imageToSave = ctx.srcUrl;
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

  // ── Type switcher ─────────────────────────────────────────────────────────

  const TYPE_LABELS = {
    link: "Link",
    article: "Article",
    video: "Video",
    image: "Image",
    selection: "Selection",
  };

  function buildTypeSwitcher(detectedType) {
    // Always show Link and Article; add Selection only when text is selected
    const types = ["link", "article"];
    if (metadata.selection && metadata.selection.length > 0) {
      types.push("selection");
    }

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

    // Show/hide description for non-image types
    descriptionField.classList.toggle("hidden", type === "image");

    updatePreview();
  }

  async function updatePreview() {
    if (!metadata) return;

    previewImage.classList.add("hidden");
    previewText.classList.add("hidden");

    if (currentType === "article" || currentType === "selection") {
      // Show text preview
      let text = "";
      if (currentType === "selection" && metadata.selection) {
        text = metadata.selection;
      } else if (currentType === "article") {
        text = articleData?.content?.slice(0, 300) || "";
      }

      if (text) {
        previewText.textContent = text + (text.length >= 300 ? "..." : "");
        previewText.classList.remove("hidden");
      }
    } else if (metadata.image || metadata.imageToSave) {
      // Show image preview
      const imgUrl = metadata.imageToSave || metadata.image;
      previewImage.src = imgUrl;
      previewImage.classList.remove("hidden");
    }
  }

  // ── Channel picker ────────────────────────────────────────────────────────

  function renderChannelList(filter = "") {
    const lc = filter.toLowerCase();
    const filtered = channels.filter((ch) =>
      ch.title.toLowerCase().includes(lc) || ch.tag.toLowerCase().includes(lc)
    );

    let html = "";

    for (const ch of filtered) {
      const isSelected = selectedTags.includes(ch.tag);
      const checkmark = isSelected ? "&#10003;" : "";
      html += `
        <div class="channel-item ${isSelected ? "selected" : ""}" data-tag="${ch.tag}">
          <span class="check">${checkmark}</span>
          <span>${ch.title}</span>
          <span class="count">${ch.block_count}</span>
        </div>
      `;
    }

    // Offer to create a new tag if the search doesn't match any existing
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

    channelList.innerHTML = html;
    channelList.classList.toggle("hidden", html === "");

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
        renderChannelList();
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
    renderSelectedTags();
    renderChannelList(channelSearch.value);
  }

  function renderSelectedTags() {
    selectedChannels.innerHTML = selectedTags
      .map(
        (tag) => `
        <span class="tag-chip" data-tag="${tag}">
          ${tag}
          <span class="remove" data-remove="${tag}">&times;</span>
        </span>
      `
      )
      .join("");

    selectedChannels.querySelectorAll(".remove").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTag(el.dataset.remove);
      });
    });
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

  // ── Save ──────────────────────────────────────────────────────────────────

  async function save() {
    if (!metadata) return;

    saveBtn.disabled = true;
    saveLabel.classList.add("hidden");
    saveSpinner.classList.remove("hidden");

    // Re-query selection right before saving (user may have changed it)
    if (currentType === "selection") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        const fresh = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tab.id, { action: "extractMetadata" }, (resp) => resolve(resp));
        });
        if (fresh?.selection?.length > 0) {
          metadata.selection = fresh.selection;
        }
      }
    }

    const blockType =
      currentType === "selection" ? "article" : currentType === "image" ? "image" : currentType;

    const payload = {
      action: "save_block",
      block_type: blockType,
      title: titleInput.value || null,
      description: descriptionInput.value || null,
      url: metadata.url || null,
      body: "",
      tags: selectedTags.length > 0 ? selectedTags : null,
      image_url: null,
      author: metadata.author || null,
      width: null,
      height: null,
    };

    // Set body for article/selection
    if (currentType === "article" && articleData?.content) {
      payload.body = articleData.content;
      if (articleData.byline) payload.author = articleData.byline;
    } else if (currentType === "selection" && metadata.selection) {
      payload.body = metadata.selection;
    }

    // Set image_url for types that need it
    if (currentType === "image" && metadata.imageToSave) {
      payload.image_url = metadata.imageToSave;
    } else if (metadata.image && (currentType === "link" || currentType === "video")) {
      payload.image_url = metadata.image;
    }

    const result = await sendToNative(payload);

    saveSpinner.classList.add("hidden");
    saveLabel.classList.remove("hidden");
    saveBtn.disabled = false;

    if (result.ok) {
      showStatus("Saved!", "success");
      setTimeout(() => window.close(), 1500);
    } else {
      showStatus(result.error || "Failed to save", "error");
    }
  }

  function showStatus(msg, type) {
    statusBar.classList.remove("hidden", "success", "error");
    statusBar.classList.add(type);
    statusText.textContent = msg;
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  channelSearch.addEventListener("input", () => {
    renderChannelList(channelSearch.value);
  });

  channelSearch.addEventListener("focus", () => {
    renderChannelList(channelSearch.value);
  });

  // Close channel list when clicking outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".channel-picker")) {
      channelList.classList.add("hidden");
    }
  });

  cancelBtn.addEventListener("click", () => window.close());

  saveBtn.addEventListener("click", save);

  // Cmd+Enter to save
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") {
      window.close();
    }
  });

  // ── Start ─────────────────────────────────────────────────────────────────

  init();
})();
