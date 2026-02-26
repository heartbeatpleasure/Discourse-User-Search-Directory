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

// Core (Ember) load-more UI
let coreLoadMoreContainer = null;
let coreLoadMoreDisplay = "";

// Our own load-more UI in search mode (to avoid triggering Ember's loadMore)
let searchLoadMoreContainer = null;
let searchLoadMoreBtn = null;
let searchLoadMoreHandler = null;

let activeForm = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------
// Template detection
// ----------------------

function hasSkeletonMarkers(node) {
  if (!node || node.nodeType !== 1) return false;

  const cls = (node.className || "").toString();
  if (/\bskeleton\b/i.test(cls)) return true;
  if (/\bplaceholder\b/i.test(cls)) return true;
  if (/\bis-loading\b/i.test(cls)) return true;
  if (/\bloading-skeleton\b/i.test(cls)) return true;

  // Look for common skeleton elements inside
  return !!node.querySelector?.(
    "[class*='skeleton'], [class*='placeholder'], .skeleton, .skeleton-line"
  );
}

function isUsableTemplate(node) {
  if (!node || node.nodeType !== 1) return false;

  // A real directory card should have an avatar img.
  const hasAvatarImg = !!node.querySelector?.("img.avatar");
  if (!hasAvatarImg) return false;

  // And something that clearly indicates a username.
  const hasUsername =
    !!node.querySelector?.(".username") ||
    !!node.querySelector?.("a[data-user-card]") ||
    !!node.querySelector?.("a[href^='/u/']") ||
    !!node.querySelector?.("a[href^='/users/']");

  if (!hasUsername) return false;

  // Avoid caching skeleton/loading placeholders.
  if (hasSkeletonMarkers(node)) return false;

  // If there is a .username, it should contain something non-empty.
  const u = node.querySelector?.(".username");
  if (u && !(u.textContent || "").trim()) return false;

  return true;
}

function stripSkeletonMarkers(node) {
  if (!node || node.nodeType !== 1) return;

  const stripFrom = (el) => {
    const classes = (el.className || "").toString();
    if (!classes) return;

    // Only remove very specific loading markers to avoid visual regressions.
    const cleaned = classes
      .split(/\s+/)
      .filter(
        (c) =>
          !/^(skeleton|placeholder|is-loading|loading-skeleton)$/i.test(c)
      )
      .join(" ");

    if (cleaned !== classes) {
      el.className = cleaned;
    }

    if (el.getAttribute && el.getAttribute("aria-busy") === "true") {
      el.removeAttribute("aria-busy");
    }
  };

  stripFrom(node);
  node.querySelectorAll?.("*")?.forEach(stripFrom);
}

function findBestTemplateCandidate(section) {
  if (!section || !section.children) return null;
  const children = Array.from(section.children);
  return children.find((c) => isUsableTemplate(c)) || null;
}

async function ensureUsableTemplate(maxWaitMs = 2500) {
  // If we already have a good template, we're done.
  if (templateNode && isUsableTemplate(templateNode)) return true;

  const ctx = ensureSections();
  if (!ctx) return false;

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const candidate = findBestTemplateCandidate(ctx.originalSection);
    if (candidate) {
      templateNode = candidate.cloneNode(true);
      stripSkeletonMarkers(templateNode);
      return true;
    }

    // Directory still loading, try again shortly.
    await sleep(50);
  }

  return false;
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

function findLoadMoreContainer(directoryRoot) {
  const root = directoryRoot || findDirectoryRoot();
  if (!root) return null;

  const btn = findLoadMoreButton(root);
  if (!btn) return null;

  let container = btn.closest(".load-more") || btn.parentElement;

  // If the button itself matches `.load-more`, we want its wrapper.
  if (container === btn && btn.parentElement) {
    container = btn.parentElement;
  }

  return container;
}

function removeEmberActionAttributes(node) {
  if (!node || node.nodeType !== 1) return;

  // Ember/Discourse commonly uses these to bind actions.
  const attrsToRemove = [
    "data-ember-action",
    "data-action",
    "data-action-id",
    "data-action-outer-html",
  ];

  const strip = (el) => {
    attrsToRemove.forEach((attr) => {
      if (el.hasAttribute && el.hasAttribute(attr)) {
        el.removeAttribute(attr);
      }
    });

    // Remove any inline handlers that could have been cloned.
    if (el.getAttributeNames) {
      el.getAttributeNames()
        .filter((n) => /^on/i.test(n))
        .forEach((n) => el.removeAttribute(n));
    }
  };

  strip(node);
  node.querySelectorAll?.("*")?.forEach(strip);
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
  if (sec < 60) return `${sec} ${sec === 1 ? "sec" : "secs"} ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} ${min === 1 ? "min" : "mins"} ago`;

  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} ${hour === 1 ? "hour" : "hours"} ago`;

  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} ${day === 1 ? "day" : "days"} ago`;

  const week = Math.floor(day / 7);
  if (week < 5) return `${week} ${week === 1 ? "week" : "weeks"} ago`;

  const month = Math.floor(day / 30);
  if (month < 12) return `${month} ${month === 1 ? "month" : "months"} ago`;

  const year = Math.floor(day / 365);
  return `${year} ${year === 1 ? "year" : "years"} ago`;
}

function isRelativeTimeText(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  if (t === "just now") return true;
  if (t.includes(" ago")) return true;
  // defensive for compact formats like "3m" or "2h" (in case they render like that)
  return /^\d+\s*(s|m|h|d|w|mo|y)$/.test(t);
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

  // IMPORTANT:
  // Don't set `textContent` on the whole <a> element because it can contain
  // nested avatar <img> markup. That would delete the avatar and leave only the
  // username link (exactly the issue you saw).

  const usernameEls = card.querySelectorAll(".username");
  usernameEls.forEach((el) => {
    const hadAt = (el.textContent || "").trim().startsWith("@");
    el.textContent = hadAt ? `@${username}` : username;
  });

  // Fallback: if no explicit .username elements exist, update a likely name link
  // but ONLY when it has no element children (so we never destroy avatars).
  if (!usernameEls.length) {
    const nameLink =
      card.querySelector(".user-card-name a") ||
      card.querySelector("a[href^='/u/']") ||
      card.querySelector("a[href^='/users/']") ||
      card.querySelector("a.user-link");

    if (nameLink) {
      const hasElementChildren = Array.from(nameLink.childNodes || []).some(
        (n) => n && n.nodeType === 1
      );
      if (!hasElementChildren) {
        const hadAt = (nameLink.textContent || "").trim().startsWith("@");
        nameLink.textContent = hadAt ? `@${username}` : username;
      }
    }
  }
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

  const agoText = relativeAgo(lastSeen);

  // Try to find the smallest element that contains the word "Seen"
  // (this should be the "Seen ..." line/container, not the whole card).
  const seenCandidates = Array.from(card.querySelectorAll("*")).filter((el) => {
    const t = (el.textContent || "").trim();
    if (!t) return false;
    if (!/\bseen\b/i.test(t)) return false;
    if (t.length > 160) return false;
    if (el === card) return false;
    return true;
  });

  let seenEl = null;
  if (seenCandidates.length) {
    seenCandidates.sort(
      (a, b) => (a.textContent || "").length - (b.textContent || "").length
    );
    seenEl = seenCandidates[0];
  }

  // 1) Prefer preserving existing relative-date markup if present.
  // Update the first time-like element inside the seen container.
  if (seenEl) {
    const timeLike =
      seenEl.querySelector(".relative-date") ||
      seenEl.querySelector("[data-time]") ||
      seenEl.querySelector("time[datetime]");

    if (timeLike) {
      if (timeLike.hasAttribute?.("data-time")) {
        timeLike.setAttribute("data-time", String(lastSeen));
      }
      if (timeLike.tagName === "TIME" || timeLike.hasAttribute?.("datetime")) {
        timeLike.setAttribute("datetime", new Date(lastSeen).toISOString());
      }

      // If Discourse doesn't re-render the relative-date (e.g. in our cloned nodes),
      // ensure the visible text is correct.
      if (isRelativeTimeText(timeLike.textContent)) {
        timeLike.textContent = agoText;
      }

      // Ensure the container still starts with "Seen"
      const containerText = (seenEl.textContent || "").trim();
      if (!/^seen\b/i.test(containerText)) {
        // Keep minimal change: prepend label if it got lost.
        seenEl.insertAdjacentText("afterbegin", "Seen ");
      }
    } else {
      // 2) Fallback: set plain text
      seenEl.textContent = `Seen ${agoText}`;
    }

    // Remove the common duplicate trailing relative time node (e.g. "... just now")
    // that can remain from the cloned template.
    const parent = seenEl.parentElement;
    if (parent) {
      const children = Array.from(parent.childNodes || []);
      const idx = children.indexOf(seenEl);

      for (let i = idx + 1; i < children.length; i++) {
        const node = children[i];
        if (!node) continue;

        // skip whitespace
        if (node.nodeType === 3 && !(node.textContent || "").trim()) continue;

        const text = (node.textContent || "").trim();
        if (!text) continue;

        const isTimeishElement =
          node.nodeType === 1 &&
          (node.matches?.(".relative-date, time, [data-time]") ||
            /relative-date/i.test((node.className || "").toString()));

        if (isTimeishElement && isRelativeTimeText(text)) {
          node.remove();
          continue;
        }

        // sometimes it's a text node like " just now"
        if (node.nodeType === 3 && isRelativeTimeText(text)) {
          node.remove();
          continue;
        }

        // Stop once we hit something else (next meta item)
        break;
      }
    }

    return;
  }

  // Last resort: update any time elements/attributes whose nearby text mentions "seen"
  const timeEls = card.querySelectorAll("[data-time], time[datetime]");
  timeEls.forEach((el) => {
    const parentText =
      (el.parentElement ? el.parentElement.textContent : el.textContent) || "";
    if (/seen/i.test(parentText)) {
      el.setAttribute("data-time", String(lastSeen));
      el.setAttribute("datetime", new Date(lastSeen).toISOString());
      if (isRelativeTimeText(el.textContent)) {
        el.textContent = agoText;
      }
    }
  });
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
  stripSkeletonMarkers(card);
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

function ensureSearchLoadMore(root) {
  const ctx = ensureSections();
  if (!ctx) return;
  const { resultsSection: rs } = ctx;

  // Track core container so we can hide/show it.
  const core = findLoadMoreContainer(root);
  if (core) {
    // If Discourse re-rendered, refresh reference.
    if (!coreLoadMoreContainer || coreLoadMoreContainer !== core) {
      coreLoadMoreContainer = core;
      coreLoadMoreDisplay = coreLoadMoreContainer.style.display || "";
    }
  }

  // Create our own load-more container for search mode.
  if (!searchLoadMoreContainer) {
    if (coreLoadMoreContainer) {
      searchLoadMoreContainer = coreLoadMoreContainer.cloneNode(true);
      removeEmberActionAttributes(searchLoadMoreContainer);
    } else {
      // Fallback if Discourse changes markup and we can't find the core container.
      searchLoadMoreContainer = document.createElement("div");
      searchLoadMoreContainer.className = "load-more";
      searchLoadMoreContainer.innerHTML =
        '<button type="button" class="btn btn-primary load-more">Load More</button>';
    }

    searchLoadMoreContainer.classList.add("hb-user-search-load-more");
    searchLoadMoreContainer.style.display = "none";

    // Insert directly after our results list so UI stays in the same place.
    const parent = rs?.parentElement || coreLoadMoreContainer?.parentElement;
    if (parent) {
      if (rs && rs.nextSibling) {
        parent.insertBefore(searchLoadMoreContainer, rs.nextSibling);
      } else {
        parent.appendChild(searchLoadMoreContainer);
      }
    }

    // Find the button inside our container
    searchLoadMoreBtn =
      searchLoadMoreContainer.querySelector("button") ||
      (searchLoadMoreContainer.tagName === "BUTTON" ? searchLoadMoreContainer : null);

    if (searchLoadMoreBtn) {
      // Ensure the clone can't trigger Ember's actions
      removeEmberActionAttributes(searchLoadMoreBtn);

      searchLoadMoreHandler = async (event) => {
        if (!searchActive) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (searchLoading || !searchHasMore) return;
        await loadNextPage();
      };

      // Important: regular listener is enough because this button is not Ember-managed
      searchLoadMoreBtn.addEventListener("click", searchLoadMoreHandler);
    }
  }
}

function syncLoadMoreUI(root) {
  ensureSearchLoadMore(root);

  // Hide Discourse's core load-more during search so its infinite scroll / actions
  // don't run (this was causing `this.model` / `loadMore` errors).
  if (coreLoadMoreContainer) {
    coreLoadMoreContainer.style.display = searchActive ? "none" : coreLoadMoreDisplay;
  }

  // Show our sanitized load-more only in search mode.
  if (searchLoadMoreContainer) {
    if (searchActive && searchHasMore) {
      searchLoadMoreContainer.style.display = "";
    } else {
      searchLoadMoreContainer.style.display = "none";
    }
  }

  if (searchLoadMoreBtn) {
    searchLoadMoreBtn.disabled = !!(searchActive && searchLoading);
  }
}

function cleanupSearchLoadMore() {
  if (searchLoadMoreBtn && searchLoadMoreHandler) {
    searchLoadMoreBtn.removeEventListener("click", searchLoadMoreHandler);
  }
  searchLoadMoreHandler = null;
  searchLoadMoreBtn = null;
  if (searchLoadMoreContainer) {
    searchLoadMoreContainer.remove();
  }
  searchLoadMoreContainer = null;
}

async function renderFirstPage() {
  const ctx = ensureSections();
  if (!ctx) return;

  const { root } = ctx;
  if (!searchFilters || !searchFilters.hasAnyFilter) return;

  searchLoading = true;
  setLoading(root, true);
  showEmptyMessage(root, false);

  // IMPORTANT: the directory often renders a skeleton first. If we cache that as a
  // template, our search results will look like they are "stuck loading".
  // Wait for a real rendered card to use as template.
  await ensureUsableTemplate(8000);

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
    syncLoadMoreUI(root);
  }
}

async function loadNextPage() {
  const ctx = ensureSections();
  if (!ctx) return;
  const { root } = ctx;

  if (!searchActive || !searchFilters || !searchHasMore) return;

  searchLoading = true;
  syncLoadMoreUI(root);

  // Ensure template is still usable (defensive)
  if (!templateNode) {
    await ensureUsableTemplate(8000);
  }

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
    syncLoadMoreUI(root);
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
  syncLoadMoreUI(root);
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
      syncLoadMoreUI(directoryRoot);
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
      syncLoadMoreUI(directoryRoot);

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
        // Do NOT refresh the page (e.g. livestream would stop).
        // Just clear fields + show the original directory again.
        try {
          form.reset();
        } catch {
          // ignore
        }

        exitSearchMode();
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
      cleanupSearchLoadMore();
      coreLoadMoreContainer = null;
      coreLoadMoreDisplay = "";
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
    cleanupSearchLoadMore();
    coreLoadMoreContainer = null;
    coreLoadMoreDisplay = "";
    searchActive = false;
    searchFilters = null;

    setTimeout(injectFilters, 0);
  });
});
