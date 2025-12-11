import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";

let optionsCache = null;
let optionsPromise = null;

let userMetaCache = null;
let userMetaPromise = null;
let preparePromise = null;
let prepared = false;

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

// ----------------------
// User meta (custom fields)
// ----------------------

function fetchUserMeta() {
  if (userMetaCache) {
    return Promise.resolve(userMetaCache);
  }

  if (userMetaPromise) {
    return userMetaPromise;
  }

  userMetaPromise = ajax("/user-search.json")
    .then((result) => {
      const map = Object.create(null);
      const users = (result && result.users) || [];

      users.forEach((u) => {
        if (!u || !u.username) {
          return;
        }

        const userFields = u.user_fields || {};
        const key = u.username.toLowerCase();

        map[key] = {
          username: u.username,
          gender: userFields["1"] || "",
          country: userFields["3"] || "",
          listen: userFields["5"] || "",
          share: userFields["6"] || "",
          favorite: userFields["7"] || "",
        };
      });

      userMetaCache = map;
      return userMetaCache;
    })
    .catch(() => {
      userMetaCache = Object.create(null);
      return userMetaCache;
    });

  return userMetaPromise;
}

function withDoNotConsider(list) {
  return ["Do not consider", ...(list || [])];
}

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

// ----------------------
// Load all users (load more)
// ----------------------

function ensureAllUsersLoaded(maxLoops) {
  maxLoops = maxLoops || 30;

  return new Promise((resolve) => {
    let loops = 0;

    function step() {
      const btn =
        document.querySelector(
          ".directory .load-more button, .directory .btn.load-more"
        ) ||
        document.querySelector(".load-more button") ||
        document.querySelector(".load-more.btn, button.load-more");

      if (
        !btn ||
        btn.disabled ||
        btn.classList.contains("disabled") ||
        loops >= maxLoops
      ) {
        resolve();
        return;
      }

      btn.click();
      loops += 1;

      setTimeout(step, 800);
    }

    step();
  });
}

function ensurePrepared() {
  if (prepared && userMetaCache) {
    return Promise.resolve(userMetaCache);
  }

  if (preparePromise) {
    return preparePromise;
  }

  preparePromise = Promise.all([ensureAllUsersLoaded(30), fetchUserMeta()]).then(
    (results) => {
      const meta = results[1] || Object.create(null);
      prepared = true;
      return meta;
    }
  );

  return preparePromise;
}

// ----------------------
// Get username from card
// ----------------------

function extractUsernameFromCard(card) {
  if (!card) {
    return null;
  }

  let link =
    card.querySelector(".user-card-name a") ||
    card.querySelector("a[href^='/u/']");

  if (!link) {
    return null;
  }

  const href = link.getAttribute("href") || "";
  const match = href.match(/\/u\/([^\/\?]+)/i);
  if (match && match[1]) {
    return match[1];
  }

  const text = (link.textContent || "").trim();
  return text || null;
}

// ----------------------
// Apply filters
// ----------------------

function applyFilters(form, userMeta) {
  const directoryRoot = findDirectoryRoot();
  if (!directoryRoot) {
    return;
  }

  const directorySection =
    directoryRoot.querySelector(".user-card-directory") ||
    directoryRoot.querySelector("section.user-card-directory");

  if (!directorySection) {
    return;
  }

  const formData = new FormData(form);
  const genderFilter = formData.get("gender") || "";
  const countryFilter = formData.get("country") || "";
  const listenFilter = formData.get("listen") || "";
  const shareFilter = formData.get("share") || "";

  const hasAnyFilter =
    genderFilter || countryFilter || listenFilter || shareFilter;

  const cards = Array.from(directorySection.children || []);
  let visibleCount = 0;

  cards.forEach((card) => {
    const username = extractUsernameFromCard(card);
    if (!username) {
      return;
    }

    const meta = userMeta[username.toLowerCase()] || {};
    let visible = true;

    if (genderFilter && meta.gender !== genderFilter) {
      visible = false;
    }

    if (countryFilter && meta.country !== countryFilter) {
      visible = false;
    }

    if (listenFilter && meta.listen !== listenFilter) {
      visible = false;
    }

    if (shareFilter && meta.share !== shareFilter) {
      visible = false;
    }

    if (!hasAnyFilter) {
      card.style.display = "";
      visibleCount += 1;
    } else if (visible) {
      card.style.display = "";
      visibleCount += 1;
    } else {
      card.style.display = "none";
    }
  });

 // Empty message (no users found)
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
// Initializer
// ----------------------

export default apiInitializer("0.11.1", (api) => {
  function injectFilters() {
    const directoryRoot = findDirectoryRoot();
    if (!directoryRoot) {
      return;
    }

// This is the block that contains "2 users • filter by username • icons"
    const controls =
      directoryRoot.querySelector(".directory-controls") ||
      directoryRoot.querySelector(".users-directory-controls");

    if (!controls) {
      return;
    }

    const container = controls.parentElement || directoryRoot;

    // Do not inject twice
    if (container.querySelector(".hb-user-search-filters")) {
      return;
    }

    fetchOptions().then((opt) => {
      // Do NOT show "No preference" as a filter option
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
            <button type="button" class="btn btn-flat hb-user-search-reset">
              Reset</button>
          </div>
        </form>
      `;

      // Place filter block DIRECTLY under the controls
      if (controls.nextSibling) {
        container.insertBefore(wrapper, controls.nextSibling);
      } else {
        container.appendChild(wrapper);
      }

      const form = wrapper.querySelector(".hb-user-search-form");
      const resetButton = wrapper.querySelector(".hb-user-search-reset");

      form.addEventListener("submit", (event) => {
        event.preventDefault();

        const directoryRootNow = findDirectoryRoot();
        if (directoryRootNow) {
          let loading = directoryRootNow.querySelector(
            ".hb-user-search-loading"
          );
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

        ensurePrepared().then((userMeta) => {
          const directoryRootAfter = findDirectoryRoot();
          const loadingAfter = directoryRootAfter
            ? directoryRootAfter.querySelector(".hb-user-search-loading")
            : null;
          if (loadingAfter) {
            loadingAfter.style.display = "none";
          }

          applyFilters(form, userMeta);
        });
      });

      resetButton.addEventListener("click", () => {
        window.location.reload();
      });
    });
  }

  api.onPageChange((url) => {
    if (!url || !url.startsWith("/u")) {
      return;
    }
    // Wait until Ember has fully rendered the /u page
    setTimeout(injectFilters, 0);
  });
});
