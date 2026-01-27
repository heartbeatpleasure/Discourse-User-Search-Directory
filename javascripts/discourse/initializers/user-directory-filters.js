import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";

let optionsCache = null;
let optionsPromise = null;

// Directory load state
let directoryFullyLoaded = false;
let directoryLoadPromise = null;

// Active filter state (used by MutationObserver)
let activeForm = null;
let activeMatchSet = null; // Set(lowercase usernames) OR null when no filters
let directoryObserver = null;
let scheduledReapply = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------
// Options for dropdowns
// ----------------------

function fetchOptions() {
  if (optionsCache) {
    return Promise.resolve(optionsCache);
  }

  if (optionsPromise) {
    return optionsPromise;
  }

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
      optionsCache = {
        gender: [],
        country: [],
        listen: [],
        share: [],
      };
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
  if (!root) {
    return null;
  }

  return (
    root.querySelector(".user-card-directory") ||
    root.querySelector("section.user-card-directory") ||
    root.querySelector(".directory-table tbody") ||
    root.querySelector(".directory-table")
  );
}

function findLoadMoreButton(directoryRoot) {
  const root = directoryRoot || findDirectoryRoot();
  if (!root) {
    return null;
  }

  return (
    root.querySelector(".directory .load-more button, .directory .btn.load-more") ||
    root.querySelector(".load-more button") ||
    root.querySelector(".load-more.btn, button.load-more")
  );
}

// ----------------------
// Load all users (load more) - robust
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

    // No usable button: wait for settle and then stop
    if (!btn || btn.disabled || btn.classList.contains("disabled")) {
      if (Date.now() - lastGrowthAt >= settleMs) {
        break;
      }
      await sleep(pollMs);
      continue;
    }

    // Click and wait for growth
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

      // If the button disappeared, the list may still be rendering; settle logic handles it.
      const btnNow = findLoadMoreButton(rootNow);
      if (!btnNow) {
        break;
      }
    }
  }
}

function ensureDirectoryFullyLoadedOnce() {
  if (directoryFullyLoaded) {
    return Promise.resolve();
  }
  if (directoryLoadPromise) {
    return directoryLoadPromise;
  }

  directoryLoadPromise = ensureAllUsersLoaded(200)
    .then(() => {
      directoryFullyLoaded = true;
    })
    .catch(() => {
      // don't hard-fail; just stop trying
      directoryFullyLoaded = true;
    });

  return directoryLoadPromise;
}

// ----------------------
// Extract username from card
// ----------------------

function extractUsernameFromCard(card) {
  if (!card) {
    return null;
  }

  const dataUsername =
    (card.dataset && card.dataset.username) || card.getAttribute("data-username");
  if (dataUsername) {
    return dataUsername;
  }

  const link =
    card.querySelector(".user-card-name a") ||
    card.querySelector("a[href^='/u/']") ||
    card.querySelector("a[href*='/u/']") ||
    card.querySelector("a[data-user-card]") ||
    card.querySelector("a.user-link");

  if (link) {
    const dataUserCard = link.getAttribute("data-user-card");
    if (dataUserCard) {
      return dataUserCard;
    }

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
    if (text) {
      return text.replace(/^@/, "");
    }
  }

  const textEl = card.querySelector(
    ".username, .user-info .username, .user-card-name, .names span"
  );
  if (textEl) {
    const t = (textEl.textContent || "").trim();
    if (t) {
      return t.replace(/^@/, "");
    }
  }

  return null;
}

// ----------------------
// Fetch matching usernames from plugin (server-side truth)
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
  // If no filters -> null means "show all"
  if (!filters || !filters.hasAnyFilter) {
    return null;
  }

  const perPage = 100;
  let page = 1;
  let safety = 0;

  const set = new Set();

  while (true) {
    safety += 1;
    if (safety > 300) {
      break;
    }

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
      if (u && u.username) {
        set.add(u.username.toLowerCase());
      }
    });

    if (users.length < perPage) {
      break;
    }

    page += 1;
  }

  return set;
}

// ----------------------
// Apply filters (by allowed username set)
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

    // filters active:
    if (!username) {
      card.style.display = "none";
      return;
    }

    const allowed = allowedSetOrNull && allowedSetOrNull.has(username.toLowerCase());
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
// MutationObserver to keep filters applied while Ember updates DOM
// ----------------------

function stopObservingDirectory() {
  if (directoryObserver) {
    directoryObserver.disconnect();
  }
  directoryObserver = null;

  if (scheduledReapply) {
    clearTimeout(scheduledReapply);
  }
  scheduledReapply = null;
}

function scheduleReapplyFilters() {
  if (scheduledReapply) return;

  scheduledReapply = setTimeout(() => {
    scheduledReapply = null;

    if (!activeForm) return;

    if (!document.contains(activeForm)) {
      activeForm = null;
      activeMatchSet = null;
      stopObservingDirectory();
      return;
    }

    applyFiltersBySet(activeForm, activeMatchSet);
  }, 100);
}

function startObservingDirectory() {
  stopObservingDirectory();

  if (!activeForm) return;

  const root = findDirectoryRoot();
  if (!root) return;

  directoryObserver = new MutationObserver(() => {
    scheduleReapplyFilters();
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
    if (container.querySelector(".hb-user-search-filters")) return;

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

        // If no filters: show all and stop observing
        if (!filters.hasAnyFilter) {
          if (loading) loading.style.display = "none";
          activeForm = null;
          activeMatchSet = null;
          stopObservingDirectory();
          applyFiltersBySet(form, null);
          return;
        }

        // Load all users in the directory first (your "all users" requirement)
        await ensureDirectoryFullyLoadedOnce();

        // Fetch allowed usernames from server-side plugin filtering
        const matchSet = await fetchMatchingUsernames(filters);

        if (loading) loading.style.display = "none";

        activeForm = form;
        activeMatchSet = matchSet || new Set(); // if fetch failed, show none rather than wrong users
        startObservingDirectory();

        applyFiltersBySet(form, activeMatchSet);
      });

      resetButton.addEventListener("click", () => {
        stopObservingDirectory();
        activeForm = null;
        activeMatchSet = null;
        window.location.reload();
      });
    });
  }

  api.onPageChange((url) => {
    stopObservingDirectory();
    activeForm = null;
    activeMatchSet = null;

    const cleanUrl = (url || "").split("#")[0];
    const isDirectory =
      /^\/u\/?(\?.*)?$/.test(cleanUrl) ||
      /^\/users\/?(\?.*)?$/.test(cleanUrl);

    if (!isDirectory) return;

    setTimeout(injectFilters, 0);
  });
});
