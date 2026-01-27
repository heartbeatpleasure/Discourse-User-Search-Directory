import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";

let optionsCache = null;
let optionsPromise = null;

// Directory load state (used to show ALL matches after filtering)
let directoryFullyLoaded = false;
let directoryLoadPromise = null;

// Active filter state (used by MutationObserver)
let activeForm = null;
let activeMatchSet = null; // Set(lowercase usernames) OR null when no filters

let directoryObserver = null;
let scheduledReapply = null;

// Prevent observer feedback loop while we reorder DOM
let isReordering = false;

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
    root.querySelector(".directory .load-more button, .directory .btn.load-more") ||
    root.querySelector(".load-more button") ||
    root.querySelector(".load-more.btn, button.load-more")
  );
}

// ----------------------
// Load all users (load more) - robust
// (used ONLY to show ALL matches after filter submit)
// ----------------------

async function ensureAllUsersLoaded(maxLoops) {
  const max = maxLoops || 200;
  const perClickTimeoutMs = 10000;
  const pollMs = 200;
  const settleMs = 800;

  let loops = 0;
  let lastGrowthAt = Date.now();
  let lastCount = -1;

  while (loops < max) {
    const root = findDirectoryRoot();
    const section = findDirectorySection(root);
    const btn = findLoadMoreButton(root);

    const count = section && section.children ? section.children.length : 0;
    if (count !== lastCount) {
      lastCount = count;
      lastGrowthAt = Date.now();
    }

    if (!btn || btn.disabled || btn.classList.contains("disabled")) {
      if (Date.now() - lastGrowthAt >= settleMs) break;
      await sleep(pollMs);
      continue;
    }

    const startCount = count;
    btn.click();
    loops += 1;

    const startTime = Date.now();
    while (Date.now() - startTime < perClickTimeoutMs) {
      await sleep(pollMs);

      const rootNow = findDirectoryRoot();
      const sectionNow = findDirectorySection(rootNow);
      const countNow =
        sectionNow && sectionNow.children ? sectionNow.children.length : 0;

      if (countNow > startCount) {
        lastGrowthAt = Date.now();
        lastCount = countNow;
        break;
      }

      const btnNow = findLoadMoreButton(rootNow);
      if (!btnNow) break;
    }
  }
}

function ensureDirectoryFullyLoadedOnce() {
  if (directoryFullyLoaded) return Promise.resolve();
  if (directoryLoadPromise) return directoryLoadPromise;

  directoryLoadPromise = ensureAllUsersLoaded(200)
    .then(() => {
      directoryFullyLoaded = true;
    })
    .catch(() => {
      directoryFullyLoaded = true;
    });

  return directoryLoadPromise;
}

// ----------------------
// Extract username from card
// ----------------------

function extractUsernameFromCard(card) {
  if (!card) return null;

  const dataUsername =
    (card.dataset && card.dataset.username) || card.getAttribute("data-username");
  if (dataUsername) return dataUsername;

  const link =
    card.querySelector(".user-card-name a") ||
    card.querySelector("a[href^='/u/']") ||
    card.querySelector("a[href*='/u/']") ||
    card.querySelector("a[data-user-card]") ||
    card.querySelector("a.user-link");

  if (link) {
    const dataUserCard = link.getAttribute("data-user-card");
    if (dataUserCard) return dataUserCard;

    const href = link.getAttribute("href") || "";
    const match =
      href.match(/\/u\/([^\/\?#]+)/i) || href.match(/\/users\/([^\/\?#]+)/i);
    if (match && match[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }

    const text = (link.textContent || "").trim();
    if (text) return text.replace(/^@/, "");
  }

  const textEl = card.querySelector(
    ".username, .user-info .username, .user-card-name, .names span"
  );
  if (textEl) {
    const t = (textEl.textContent || "").trim();
    if (t) return t.replace(/^@/, "");
  }

  return null;
}

// ----------------------
// Filters: server-side truth (AND)
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

async function fetchMatchingUsernames(filters) {
  // AND-filters are applied in the plugin endpoint itself by passing multiple params.
  if (!filters || !filters.hasAnyFilter) return null;

  const perPage = 100;
  let page = 1;
  let safety = 0;

  const set = new Set();

  while (true) {
    safety += 1;
    if (safety > 300) break;

    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("per_page", String(perPage));
    params.set("order", "username");
    params.set("asc", "true");

    if (filters.gender) params.set("gender", filters.gender);
    if (filters.country) params.set("country", filters.country);
    if (filters.listen) params.set("listen", filters.listen);
    if (filters.share) params.set("share", filters.share);

    let result;
    try {
      result = await ajax(`/user-search.json?${params.toString()}`);
    } catch {
      break;
    }

    const users = (result && result.users) || [];
    users.forEach((u) => {
      if (u && u.username) set.add(u.username.toLowerCase());
    });

    if (users.length < perPage) break;
    page += 1;
  }

  return set;
}

// ----------------------
// Apply filter: show/hide by allowed username set
// ----------------------

function applyFiltersBySet(form, allowedSetOrNull) {
  const directoryRoot = findDirectoryRoot();
  if (!directoryRoot) return;

  const directorySection = findDirectorySection(directoryRoot);
  if (!directorySection) return;

  const { hasAnyFilter } = buildFiltersFromForm(form);

  const cards = Array.from(directorySection.children || []);
  let visibleCount = 0;

  cards.forEach((card) => {
    const username = extractUsernameFromCard(card);

    if (!hasAnyFilter) {
      card.style.display = "";
      visibleCount += 1;
      return;
    }

    if (!username) {
      card.style.display = "none";
      return;
    }

    const allowed =
      allowedSetOrNull && allowedSetOrNull.has(username.toLowerCase());
    if (allowed) {
      card.style.display = "";
      visibleCount += 1;
    } else {
      card.style.display = "none";
    }
  });

  // Empty message
  let emptyEl = directoryRoot.querySelector(".hb-user-search-empty");
  if (!emptyEl) {
    emptyEl = document.createElement("div");
    emptyEl.className = "hb-user-search-empty";
    emptyEl.textContent = "No users found for these filters.";
    emptyEl.style.display = "none";
    directoryRoot.appendChild(emptyEl);
  }

  if (hasAnyFilter && visibleCount === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
  }
}

// ----------------------
// Sorting: by LAST SEEN on the card itself
// - Most recent first
// - No "Seen ..." => bottom
// ----------------------

function extractSeenTimestampFromCard(card) {
  if (!card) return null;

  // 1) Prefer a real timestamp if present (Discourse often uses data-time / datetime)
  // Try to find an element whose surrounding text contains "Seen"
  const timeCandidates = Array.from(card.querySelectorAll("[data-time], time[datetime]"));

  for (const el of timeCandidates) {
    const parentText = (el.parentElement ? el.parentElement.textContent : el.textContent) || "";
    if (/seen/i.test(parentText)) {
      // data-time is often ms since epoch in Discourse
      const dt = el.getAttribute("data-time");
      if (dt && /^\d+$/.test(dt)) {
        const n = Number(dt);
        if (Number.isFinite(n) && n > 0) return n;
      }

      const datetime = el.getAttribute("datetime");
      if (datetime) {
        const ts = Date.parse(datetime);
        if (Number.isFinite(ts)) return ts;
      }
    }
  }

  // 2) Fallback: parse from visible text e.g. "Seen just now", "Seen 7 mins ago"
  const text = (card.textContent || "").replace(/\s+/g, " ");
  const seenMatch = text.match(/Seen\s+(just now|\d+\s+\w+\s+ago)/i);
  if (!seenMatch) return null;

  const seenPart = seenMatch[1].toLowerCase();
  const now = Date.now();

  if (seenPart === "just now") return now;

  // Examples:
  // "1 min ago", "7 mins ago", "2 hours ago", "3 days ago"
  const m = seenPart.match(/^(\d+)\s+(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)\s+ago$/i);
  if (!m) return null;

  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = m[2].toLowerCase();

  let deltaMs = 0;
  if (unit.startsWith("sec")) deltaMs = amount * 1000;
  else if (unit.startsWith("min")) deltaMs = amount * 60 * 1000;
  else if (unit.startsWith("hour")) deltaMs = amount * 60 * 60 * 1000;
  else if (unit.startsWith("day")) deltaMs = amount * 24 * 60 * 60 * 1000;
  else if (unit.startsWith("week")) deltaMs = amount * 7 * 24 * 60 * 60 * 1000;
  else if (unit.startsWith("month")) deltaMs = amount * 30 * 24 * 60 * 60 * 1000;
  else if (unit.startsWith("year")) deltaMs = amount * 365 * 24 * 60 * 60 * 1000;

  return now - deltaMs;
}

function sortCardsByLastSeen() {
  const directoryRoot = findDirectoryRoot();
  if (!directoryRoot) return;

  const directorySection = findDirectorySection(directoryRoot);
  if (!directorySection) return;

  const children = Array.from(directorySection.children || []);
  if (children.length <= 1) return;

  const decorated = children.map((node, idx) => {
    const ts = extractSeenTimestampFromCard(node);
    // null => never seen -> bottom
    return { node, idx, ts };
  });

  decorated.sort((a, b) => {
    const aHas = a.ts !== null && Number.isFinite(a.ts);
    const bHas = b.ts !== null && Number.isFinite(b.ts);

    // Both missing => keep original order
    if (!aHas && !bHas) return a.idx - b.idx;

    // Missing goes to bottom
    if (!aHas && bHas) return 1;
    if (aHas && !bHas) return -1;

    // Both present => most recent first (DESC)
    if (b.ts !== a.ts) return b.ts - a.ts;

    // Tie-breaker stable
    return a.idx - b.idx;
  });

  isReordering = true;
  const frag = document.createDocumentFragment();
  decorated.forEach((d) => frag.appendChild(d.node));
  directorySection.appendChild(frag);
  setTimeout(() => {
    isReordering = false;
  }, 0);
}

// ----------------------
// MutationObserver: keep filter + sorting applied
// ----------------------

function stopObservingDirectory() {
  if (directoryObserver) directoryObserver.disconnect();
  directoryObserver = null;

  if (scheduledReapply) clearTimeout(scheduledReapply);
  scheduledReapply = null;
}

function reapplyAll() {
  if (!activeForm) return;
  applyFiltersBySet(activeForm, activeMatchSet);
  sortCardsByLastSeen();
}

function scheduleReapply() {
  if (scheduledReapply) return;

  scheduledReapply = setTimeout(() => {
    scheduledReapply = null;

    if (isReordering) return;

    if (!activeForm) return;

    if (!document.contains(activeForm)) {
      activeForm = null;
      activeMatchSet = null;
      stopObservingDirectory();
      return;
    }

    reapplyAll();
  }, 120);
}

function startObservingDirectory() {
  stopObservingDirectory();

  const root = findDirectoryRoot();
  if (!root) return;

  directoryObserver = new MutationObserver(() => {
    if (isReordering) return;
    scheduleReapply();
  });

  directoryObserver.observe(root, { childList: true, subtree: true });
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
      // Still ensure observer + sorting are active
      if (activeForm) {
        startObservingDirectory();
        sortCardsByLastSeen();
      }
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

      // Keep state for sorting and observer
      activeForm = form;
      activeMatchSet = null;

      // Start observer and apply initial sort
      startObservingDirectory();
      setTimeout(() => sortCardsByLastSeen(), 0);

      form.addEventListener("submit", async (event) => {
        event.preventDefault();

        const directoryRootNow = findDirectoryRoot();
        let loading = directoryRootNow
          ? directoryRootNow.querySelector(".hb-user-search-loading")
          : null;

        if (directoryRootNow) {
          if (!loading) {
            loading = document.createElement("div");
            loading.className = "hb-user-search-loading";
            loading.textContent = "Preparing user search…";
            loading.style.display = "block";
            directoryRootNow.appendChild(loading);
          } else {
            loading.style.display = "block";
          }
        }

        const filters = buildFiltersFromForm(form);

        // No filters: show all, keep sorting
        if (!filters.hasAnyFilter) {
          if (loading) loading.style.display = "none";
          activeForm = form;
          activeMatchSet = null;
          reapplyAll();
          return;
        }

        // Load all users so we can show ALL matches
        await ensureDirectoryFullyLoadedOnce();

        // Fetch allowed usernames from server-side plugin filtering (AND)
        const matchSet = await fetchMatchingUsernames(filters);

        if (loading) loading.style.display = "none";

        activeForm = form;
        // If fetch fails: show none rather than wrong users
        activeMatchSet = matchSet || new Set();

        reapplyAll();
      });

      resetButton.addEventListener("click", () => {
        // Reset directory load cache so future searches can re-load
        directoryFullyLoaded = false;
        directoryLoadPromise = null;

        activeMatchSet = null;
        window.location.reload();
      });
    });
  }

  api.onPageChange((url) => {
    stopObservingDirectory();

    const cleanUrl = (url || "").split("#")[0];
    const isDirectory =
      /^\/u\/?(\?.*)?$/.test(cleanUrl) || /^\/users\/?(\?.*)?$/.test(cleanUrl);

    if (!isDirectory) {
      activeForm = null;
      activeMatchSet = null;
      return;
    }

    directoryFullyLoaded = false;
    directoryLoadPromise = null;

    setTimeout(injectFilters, 0);
  });
});
