import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";
import getURL from "discourse-common/lib/get-url";

let optionsCache = null;
let optionsPromise = null;

// Search mode state
let originalSection = null;
let originalSectionDisplay = "";
let templateNode = null;
let resultsSection = null;

let searchActive = false;
let searchFilters = null;
let searchPage = 1;
let searchPerPage = 30;
let searchHasMore = false;
let searchLoading = false;

let loadMoreBtn = null;
let loadMoreCaptureHandler = null;
let activeForm = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------
// Options for dropdowns
// ----------------------

function fetchOptions() {
  if (optionsCache) return Promise.resolve(optionsCache);
  if (optionsPromise) return optionsPromise;

  optionsPromise = ajax("/user-search/options.json")
    .then((result) => {
      optionsCache = {
        gender: result.gender || [],
        country: result.country || [],
        listen: result.listen || [],
        share: result.share || [],
      };
      return optionsCache;
    })
    .catch(() => {
      optionsCache = { gender: [], country: [], listen: [], share: [] };
      return optionsCache;
    });

  return optionsPromise;
}

function withDoNotConsider(list) {
  return ["Do not consider", ...(list || [])];
}

// ----------------------
// DOM helpers
// ----------------------

function findDirectoryRoot() {
  return (
    document.querySelector(".users-directory") ||
    document.querySelector(".directory.users") ||
    document.querySelector(".users-directory.directory") ||
    document.querySelector(".users-directory-container") ||
    document.querySelector(".users-directory-wrapper") ||
    document.querySelector(".directory") ||
    document.querySelector("#main-outlet")
  );
}

function findDirectorySection(directoryRoot) {
  const root = directoryRoot || findDirectoryRoot();
  if (!root) return null;

  return (
    root.querySelector(".user-card-directory") ||
    root.querySelector("section.user-card-directory") ||
    root.querySelector(".directory-table tbody") ||
    root.querySelector(".directory-table")
  );
}

function findLoadMoreButton(directoryRoot) {
  const root = directoryRoot || findDirectoryRoot();
  if (!root) return null;

  return (
    root.querySelector(
      ".directory .load-more button, .directory .btn.load-more"
    ) ||
    root.querySelector(".load-more button") ||
    root.querySelector(".load-more.btn, button.load-more")
  );
}

// ----------------------
// Filters
// ----------------------

function buildFiltersFromForm(form) {
  const fd = new FormData(form);
  const gender = (fd.get("gender") || "").toString().trim();
  const country = (fd.get("country") || "").toString().trim();
  const listen = (fd.get("listen") || "").toString().trim();
  const share = (fd.get("share") || "").toString().trim();

  const hasAnyFilter = !!(gender || country || listen || share);
  return { gender, country, listen, share, hasAnyFilter };
}

// ----------------------
// Search API
// ----------------------

async function fetchUsersPage(filters, page) {
  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("per_page", String(searchPerPage));
  // Keep behavior consistent with the old implementation (sorted by most recent last seen)
  params.set("order", "last_seen");
  params.set("asc", "false");

  if (filters.gender) params.set("gender", filters.gender);
  if (filters.country) params.set("country", filters.country);
  if (filters.listen) params.set("listen", filters.listen);
  if (filters.share) params.set("share", filters.share);

  const result = await ajax(`/user-search.json?${params.toString()}`);
  const users = (result && result.users) || [];
  const hasMore = users.length === searchPerPage;
  return { users, hasMore };
}

// ----------------------
// Rendering helpers
// ----------------------

function ensureSections() {
  const root = findDirectoryRoot();
  if (!root) return null;

  const section = findDirectorySection(root);
  if (!section) return null;

  // Cache the original section once
  if (!originalSection) {
    originalSection = section;
    originalSectionDisplay = originalSection.style.display || "";

    // Cache a template card/row if present
    if (originalSection.children && originalSection.children.length > 0) {
      templateNode = originalSection.children[0].cloneNode(true);
    }
  }

  // Create results container if needed
  if (!resultsSection) {
    resultsSection = document.createElement(originalSection.tagName);
    resultsSection.className = `${originalSection.className} hb-user-search-results`;
    resultsSection.style.display = "none";

    const parent = originalSection.parentElement;
    if (parent) {
      parent.insertBefore(resultsSection, originalSection.nextSibling);
    }
  }

  return { root, originalSection, resultsSection };
}

function showEmptyMessage(root, show) {
  if (!root) return;

  let emptyEl = root.querySelector(".hb-user-search-empty");
  if (!emptyEl) {
    emptyEl = document.createElement("div");
    emptyEl.className = "hb-user-search-empty";
    emptyEl.textContent = "No users found for these filters.";
    emptyEl.style.display = "none";
    root.appendChild(emptyEl);
  }

  emptyEl.style.display = show ? "block" : "none";
}

function relativeAgo(tsMs) {
  const diffMs = Date.now() - tsMs;
  if (diffMs < 30 * 1000) return "just now";

  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec} secs ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} mins ago`;

  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} hours ago`;

  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} days ago`;

  const week = Math.floor(day / 7);
  if (week < 5) return `${week} weeks ago`;

  const month = Math.floor(day / 30);
  if (month < 12) return `${month} months ago`;

  const year = Math.floor(day / 365);
  return `${year} years ago`;
}

function updateAvatar(card, avatarTemplate) {
  if (!card || !avatarTemplate) return;

  const imgs = card.querySelectorAll("img.avatar");
  imgs.forEach((img) => {
    const w = parseInt(img.getAttribute("width") || "", 10);
    const h = parseInt(img.getAttribute("height") || "", 10);
    const size = Number.isFinite(w) && w > 0 ? w : Number.isFinite(h) && h > 0 ? h : 45;

    const src1x = getURL(avatarTemplate.replace("{size}", String(size)));
    const src2x = getURL(avatarTemplate.replace("{size}", String(size * 2)));

    img.setAttribute("src", src1x);
    img.setAttribute("srcset", `${src1x} 1x, ${src2x} 2x`);
  });
}

function updateLinks(card, username) {
  if (!card || !username) return;

  // dataset on wrapper (often used by Discourse)
  try {
    card.dataset.username = username;
  } catch {
    // ignore
  }

  // data-user-card on any link
  card.querySelectorAll("a[data-user-card]").forEach((a) => {
    a.setAttribute("data-user-card", username);
  });

  // Update any /u/<user> or /users/<user> hrefs within the card
  card.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href) return;

    let updated = href;
    updated = updated.replace(/\/u\/([^\/\?#]+)/i, `/u/${encodeURIComponent(username)}`);
    updated = updated.replace(
      /\/users\/([^\/\?#]+)/i,
      `/users/${encodeURIComponent(username)}`
    );

    if (updated !== href) {
      a.setAttribute("href", updated);
    }
  });

  // Primary username link text
  const nameLink =
    card.querySelector(".user-card-name a") ||
    card.querySelector("a[href^='/u/']") ||
    card.querySelector("a[href^='/users/']") ||
    card.querySelector("a.user-link");

  if (nameLink) {
    // Keep '@' behavior if it was present
    const hadAt = (nameLink.textContent || "").trim().startsWith("@");
    nameLink.textContent = hadAt ? `@${username}` : username;
  }

  const usernameEls = card.querySelectorAll(".username");
  usernameEls.forEach((el) => {
    const hadAt = (el.textContent || "").trim().startsWith("@");
    el.textContent = hadAt ? `@${username}` : username;
  });
}

function updateNameAndTitle(card, user) {
  if (!card || !user) return;

  const name = (user.name || "").toString();
  const title = (user.title || "").toString();

  const nameEl =
    card.querySelector(".name") ||
    card.querySelector(".full-name") ||
    card.querySelector(".user-card-name .name");
  if (nameEl) {
    nameEl.textContent = name;
  }

  const titleEl =
    card.querySelector(".user-title") ||
    card.querySelector(".title") ||
    card.querySelector(".user-card-title");
  if (titleEl) {
    titleEl.textContent = title;
  }
}

function updateSeen(card, user) {
  if (!card || !user) return;

  const lastSeen = user.last_seen_at ? Date.parse(user.last_seen_at) : null;
  if (!Number.isFinite(lastSeen)) return;

  // Update any time elements/attributes
  const timeEls = card.querySelectorAll("[data-time], time[datetime]");
  timeEls.forEach((el) => {
    // Only touch ones that appear to be related to "Seen" text
    const parentText =
      (el.parentElement ? el.parentElement.textContent : el.textContent) || "";
    if (/seen/i.test(parentText)) {
      el.setAttribute("data-time", String(lastSeen));
      el.setAttribute("datetime", new Date(lastSeen).toISOString());
    }
  });

  // Update visible text if we can find a "Seen" node
  const candidates = Array.from(card.querySelectorAll("*")).filter((el) => {
    const t = (el.textContent || "").trim();
    return t && /\bseen\b/i.test(t) && t.length < 80;
  });

  if (candidates.length) {
    candidates.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    candidates[0].textContent = `Seen ${relativeAgo(lastSeen)}`;
  }
}

function buildFallbackCard(user) {
  const wrap = document.createElement("div");
  wrap.className = "user-card";

  const username = (user.username || "").toString();
  const name = (user.name || "").toString();
  const title = (user.title || "").toString();
  const avatar = user.avatar_template
    ? getURL(user.avatar_template.replace("{size}", "45"))
    : "";

  wrap.innerHTML = `
    <div class="user-card-name">
      <a href="/u/${encodeURIComponent(username)}">
        ${avatar ? `<img class="avatar" width="45" height="45" src="${avatar}" />` : ""}
        <span class="username">${username}</span>
      </a>
      ${name ? `<div class="name">${name}</div>` : ""}
      ${title ? `<div class="user-title">${title}</div>` : ""}
    </div>
  `;

  return wrap;
}

function buildCardFromUser(user) {
  if (!templateNode) return buildFallbackCard(user);

  const card = templateNode.cloneNode(true);
  const username = (user.username || "").toString();

  updateLinks(card, username);
  updateAvatar(card, user.avatar_template);
  updateNameAndTitle(card, user);
  updateSeen(card, user);

  // Update common dataset/attributes if present
  if (user.id && card.getAttribute("data-user-id") !== null) {
    card.setAttribute("data-user-id", String(user.id));
  }

  return card;
}

function setLoading(root, isLoading) {
  if (!root) return null;

  let loading = root.querySelector(".hb-user-search-loading");
  if (!loading) {
    loading = document.createElement("div");
    loading.className = "hb-user-search-loading";
    loading.textContent = "Preparing user search…";
    loading.style.display = "none";
    root.appendChild(loading);
  }

  loading.style.display = isLoading ? "block" : "none";
  return loading;
}

function updateLoadMoreButton(root) {
  loadMoreBtn = findLoadMoreButton(root);
  if (!loadMoreBtn) return;

  // In search mode, we intercept load-more clicks and use it for our pagination.
  if (searchActive && !loadMoreCaptureHandler) {
    loadMoreCaptureHandler = async (event) => {
      if (!searchActive) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (searchLoading || !searchHasMore) return;
      await loadNextPage();
    };
    loadMoreBtn.addEventListener("click", loadMoreCaptureHandler, true);
  }

  // Keep the button state in sync
  if (searchActive) {
    loadMoreBtn.style.display = searchHasMore ? "" : "none";
    loadMoreBtn.disabled = !!searchLoading;
  } else {
    loadMoreBtn.style.display = "";
    loadMoreBtn.disabled = false;
  }
}

function detachLoadMoreInterceptor() {
  if (loadMoreBtn && loadMoreCaptureHandler) {
    loadMoreBtn.removeEventListener("click", loadMoreCaptureHandler, true);
  }
  loadMoreBtn = null;
  loadMoreCaptureHandler = null;
}

async function renderFirstPage() {
  const ctx = ensureSections();
  if (!ctx) return;

  const { root } = ctx;
  if (!searchFilters || !searchFilters.hasAnyFilter) return;

  searchLoading = true;
  setLoading(root, true);
  showEmptyMessage(root, false);

  // Ensure template is available (directory may have rendered after initial inject)
  if (!templateNode && originalSection && originalSection.children?.length) {
    templateNode = originalSection.children[0].cloneNode(true);
  }

  // Switch UI to search mode
  searchActive = true;
  originalSection.style.display = "none";
  resultsSection.style.display = "";
  resultsSection.innerHTML = "";

  searchPage = 1;

  try {
    const { users, hasMore } = await fetchUsersPage(searchFilters, searchPage);
    searchHasMore = hasMore;

    users.forEach((u) => {
      resultsSection.appendChild(buildCardFromUser(u));
    });

    showEmptyMessage(root, users.length === 0);
  } catch {
    searchHasMore = false;
    showEmptyMessage(root, true);
  } finally {
    searchLoading = false;
    setLoading(root, false);
    updateLoadMoreButton(root);
  }
}

async function loadNextPage() {
  const ctx = ensureSections();
  if (!ctx) return;
  const { root } = ctx;

  if (!searchActive || !searchFilters || !searchHasMore) return;

  searchLoading = true;
  updateLoadMoreButton(root);

  try {
    await sleep(150); // small debounce to avoid double clicks
    const next = searchPage + 1;
    const { users, hasMore } = await fetchUsersPage(searchFilters, next);

    users.forEach((u) => {
      resultsSection.appendChild(buildCardFromUser(u));
    });

    searchPage = next;
    searchHasMore = hasMore;
  } catch {
    searchHasMore = false;
  } finally {
    searchLoading = false;
    updateLoadMoreButton(root);
  }
}

function exitSearchMode() {
  const ctx = ensureSections();
  if (!ctx) return;
  const { root } = ctx;

  searchActive = false;
  searchFilters = null;
  searchPage = 1;
  searchHasMore = false;
  searchLoading = false;

  if (originalSection) {
    originalSection.style.display = originalSectionDisplay;
  }
  if (resultsSection) {
    resultsSection.style.display = "none";
    resultsSection.innerHTML = "";
  }

  setLoading(root, false);
  showEmptyMessage(root, false);
  detachLoadMoreInterceptor();
  updateLoadMoreButton(root);
}

// ----------------------
// Initializer
// ----------------------

export default apiInitializer("0.11.1", (api) => {
  function injectFilters() {
    const directoryRoot = findDirectoryRoot();
    if (!directoryRoot) return;

    const controls =
      directoryRoot.querySelector(".directory-controls") ||
      directoryRoot.querySelector(".users-directory-controls");

    if (!controls) return;

    const container = controls.parentElement || directoryRoot;

    // Prevent double inject
    if (container.querySelector(".hb-user-search-filters")) {
      // Ensure we have cached sections/buttons
      ensureSections();
      updateLoadMoreButton(directoryRoot);
      return;
    }

    fetchOptions().then((opt) => {
      const listenValues = (opt.listen || []).filter(
        (option) => option !== "No preference"
      );
      const shareValues = (opt.share || []).filter(
        (option) => option !== "No preference"
      );

      const genderOptions = withDoNotConsider(opt.gender);
      const countryOptions = withDoNotConsider(opt.country);
      const listenOptions = withDoNotConsider(listenValues);
      const shareOptions = withDoNotConsider(shareValues);

      const wrapper = document.createElement("div");
      wrapper.className = "hb-user-search-filters";

      wrapper.innerHTML = `
        <form class="hb-user-search-form">
          <div class="hb-user-search-grid">
            <div class="hb-user-search-field">
              <label for="hb-search-gender">Gender</label>
              <select name="gender" id="hb-search-gender">
                ${genderOptions
                  .map(
                    (option) =>
                      `<option value="${
                        option === "Do not consider" ? "" : option
                      }">${option}</option>`
                  )
                  .join("")}
              </select>
            </div>

            <div class="hb-user-search-field">
              <label for="hb-search-country">Country</label>
              <select name="country" id="hb-search-country">
                ${countryOptions
                  .map(
                    (option) =>
                      `<option value="${
                        option === "Do not consider" ? "" : option
                      }">${option}</option>`
                  )
                  .join("")}
              </select>
            </div>

            <div class="hb-user-search-field">
              <label for="hb-search-listen">Users who prefer to listen to</label>
              <select name="listen" id="hb-search-listen">
                ${listenOptions
                  .map(
                    (option) =>
                      `<option value="${
                        option === "Do not consider" ? "" : option
                      }">${option}</option>`
                  )
                  .join("")}
              </select>
            </div>

            <div class="hb-user-search-field">
              <label for="hb-search-share">Users who prefer to share with</label>
              <select name="share" id="hb-search-share">
                ${shareOptions
                  .map(
                    (option) =>
                      `<option value="${
                        option === "Do not consider" ? "" : option
                      }">${option}</option>`
                  )
                  .join("")}
              </select>
            </div>
          </div>

          <div class="hb-user-search-actions">
            <button type="submit" class="btn btn-primary">Search users</button>
            <button type="button" class="btn btn-flat hb-user-search-reset">Reset</button>
          </div>
        </form>
      `;

      // Place directly under controls
      if (controls.nextSibling) {
        container.insertBefore(wrapper, controls.nextSibling);
      } else {
        container.appendChild(wrapper);
      }

      const form = wrapper.querySelector(".hb-user-search-form");
      const resetButton = wrapper.querySelector(".hb-user-search-reset");

      activeForm = form;
      ensureSections();
      updateLoadMoreButton(directoryRoot);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const filters = buildFiltersFromForm(form);

        // No filters: restore original directory (no client-side hiding)
        if (!filters.hasAnyFilter) {
          exitSearchMode();
          return;
        }

        searchFilters = filters;
        await renderFirstPage();
      });

      resetButton.addEventListener("click", () => {
        // Keep the existing behavior (full reload) to reset core directory state
        window.location.reload();
      });
    });
  }

  api.onPageChange((url) => {
    const cleanUrl = (url || "").split("#")[0];
    const isDirectory =
      /^\/u\/?(\?.*)?$/.test(cleanUrl) ||
      /^\/users\/?(\?.*)?$/.test(cleanUrl);

    // Leave directory: cleanup
    if (!isDirectory) {
      activeForm = null;
      detachLoadMoreInterceptor();
      // Best-effort: remove any injected results container
      document.querySelectorAll(".hb-user-search-results").forEach((el) => el.remove());
      exitSearchMode();
      return;
    }

    // Directory: reset caches and inject
    originalSection = null;
    templateNode = null;
    // Remove any previous results section so we never duplicate containers
    document.querySelectorAll(".hb-user-search-results").forEach((el) => el.remove());
    resultsSection = null;
    detachLoadMoreInterceptor();
    searchActive = false;
    searchFilters = null;

    setTimeout(injectFilters, 0);
  });
});
