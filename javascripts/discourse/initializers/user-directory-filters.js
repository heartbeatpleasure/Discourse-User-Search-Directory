import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";
import DiscourseURL from "discourse/lib/url";

let optionsCache = null;
let optionsPromise = null;

const HB_KEYS = ["hb_gender", "hb_country", "hb_listen", "hb_share"];

const SORT_FIELDS = [
  { value: "last_seen", label: "Last seen" },
  { value: "username", label: "Username" },
  { value: "joined", label: "Join date" },
];

function normalizeSortOrder(order) {
  const o = (order || "").toString().trim();
  return SORT_FIELDS.some((f) => f.value === o) ? o : "last_seen";
}

function setSelectValueIfPresent(selectEl, desiredValue, fallbackValue) {
  if (!selectEl) return;
  const desired = (desiredValue || "").toString();
  const fallback = (fallbackValue || "").toString();
  const hasDesired = Array.from(selectEl.options).some((o) => o.value === desired);
  selectEl.value = hasDesired ? desired : fallback;
}

// ----------------------
// Options for dropdowns
// ----------------------

function fetchOptions() {
  if (optionsCache) return Promise.resolve(optionsCache);
  if (optionsPromise) return optionsPromise;

  // NOTE: hyphen, not underscore
  optionsPromise = ajax("/user-search/options.json")
    .then((res) => {
      optionsCache = res || {};
      return optionsCache;
    })
    .catch(() => {
      optionsCache = { gender: [], country: [], listen: [], share: [] };
      return optionsCache;
    });

  return optionsPromise;
}

function withDoNotConsider(arr) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  return ["Do not consider", ...list];
}

function readHbParams(url = window.location.href) {
  const u = new URL(url, window.location.origin);
  const sp = u.searchParams;

  const out = {};
  HB_KEYS.forEach((k) => {
    const v = sp.get(k);
    if (v) out[k] = v;
  });
  return out;
}

function filtersPresent(url = window.location.href) {
  const hb = readHbParams(url);
  return HB_KEYS.some((k) => (hb[k] || "").trim().length > 0);
}

function readSortParams(url = window.location.href) {
  const u = new URL(url, window.location.origin);
  const sp = u.searchParams;

  const order = (sp.get("order") || "").trim() || "last_seen";
  const direction = sp.has("asc") ? "asc" : "desc";

  return { order, direction };
}

function defaultDirectionFor(order) {
  switch (order) {
    case "username":
      return "asc";
    case "joined":
    case "last_seen":
    default:
      return "desc";
  }
}

function directionLabelsFor(order) {
  if (order === "username") {
    return { asc: "A → Z", desc: "Z → A" };
  }
  return { desc: "Newest first", asc: "Oldest first" };
}

function buildUrlWithParams({ hb, sort }, baseUrl = window.location.href) {
  const u = new URL(baseUrl, window.location.origin);
  const sp = u.searchParams;

  // Apply hb_*
  HB_KEYS.forEach((k) => {
    const v = (hb?.[k] || "").toString().trim();
    if (v) sp.set(k, v);
    else sp.delete(k);
  });

  // Apply sorting
  const order = (sort?.order || "").toString().trim() || "last_seen";
  sp.set("order", order);

  const direction = sort?.direction === "asc" ? "asc" : "desc";
  if (direction === "asc") sp.set("asc", "1");
  else sp.delete("asc");

  // Keep URL pretty
  u.search = sp.toString();

  // NOTE: URL.search already includes the leading `?` when present.
  // Returning `?${u.search}` would create a `??` prefix, which breaks query param parsing
  // (the first param becomes `?param=` and gets ignored by Discourse/Ember).
  return u.pathname + u.search;
}

function applyDirectoryParams({ hb, sort }) {
  DiscourseURL.routeTo(buildUrlWithParams({ hb, sort }));
  setTimeout(updateEmptyStateMessage, 0);
  setTimeout(updateEmptyStateMessage, 250);
  setTimeout(updateEmptyStateMessage, 900);
}

function ensureDefaultSortInUrl(url) {
  const u = new URL(url || window.location.href, window.location.origin);
  const sp = u.searchParams;

  // If no explicit order yet, set default order=last_seen (desc)
  if (!sp.get("order")) {
    const next = buildUrlWithParams(
      { hb: readHbParams(u.href), sort: { order: "last_seen", direction: "desc" } },
      u.href
    );

    // routeTo only if it would change anything (avoid loops)
    if (next !== (u.pathname + u.search)) {
      DiscourseURL.routeTo(next);
      return true;
    }
  }
  return false;
}

function updateEmptyStateMessage() {
  const directoryRoot = findDirectoryRoot();
  if (!directoryRoot) return;

  const empty = directoryRoot.querySelector(".empty-state-body p");
  if (!empty) return;

  // Replace Discourse's confusing "brand new community" copy with a neutral message.
  // We do this only on /u (directory) so other pages aren't affected.
  empty.textContent = "No results found.";
}

// ----------------------
// UI injection
// ----------------------

function findDirectoryRoot() {
  return (
    document.querySelector(".directory.users") ||
    document.querySelector(".users-directory.directory") ||
    document.querySelector(".users-directory-container") ||
    document.querySelector(".users-directory-wrapper") ||
    document.querySelector(".directory") ||
    document.querySelector("#main-outlet")
  );
}

function renderSortControls(currentSort) {
  const order = normalizeSortOrder(currentSort.order || "last_seen");
  const direction = currentSort.direction || defaultDirectionFor(order);
  const labels = directionLabelsFor(order);

  const sortOptions = SORT_FIELDS.map((f) => {
    const selected = f.value === order ? "selected" : "";
    return `<option value="${f.value}" ${selected}>${f.label}</option>`;
  }).join("");

  const directionOptions = [
    `<option value="desc" ${direction === "desc" ? "selected" : ""}>${labels.desc}</option>`,
    `<option value="asc" ${direction === "asc" ? "selected" : ""}>${labels.asc}</option>`,
  ].join("");

  return `
    <div class="hb-user-search-grid hb-user-search-grid--sort">
      <div class="hb-user-search-field">
        <label for="hb-search-sort-by">Sort by</label>
        <select name="sortBy" id="hb-search-sort-by">
          ${sortOptions}
        </select>
      </div>

      <div class="hb-user-search-field">
        <label for="hb-search-sort-direction">Sort direction</label>
        <select name="sortDirection" id="hb-search-sort-direction">
          ${directionOptions}
        </select>
      </div>
    </div>
  `;
}

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
    const existing = container.querySelector(".hb-user-search-form");
    if (existing) {
      const hb = readHbParams();
      const g = existing.querySelector("select[name='gender']");
      const c = existing.querySelector("select[name='country']");
      const l = existing.querySelector("select[name='listen']");
      const s = existing.querySelector("select[name='share']");
      if (g) g.value = hb.hb_gender || "";
      if (c) c.value = hb.hb_country || "";
      if (l) l.value = hb.hb_listen || "";
      if (s) s.value = hb.hb_share || "";

      const sortState = readSortParams();
      const sortBy = existing.querySelector("select[name='sortBy']");
      const sortDir = existing.querySelector("select[name='sortDirection']");
      if (sortBy) {
        setSelectValueIfPresent(
          sortBy,
          normalizeSortOrder(sortState.order || "last_seen"),
          "last_seen"
        );
      }

      if (sortDir) {
        const currentOrder = sortBy?.value || "last_seen";
        const desired = sortState.direction || defaultDirectionFor(currentOrder);
        setSelectValueIfPresent(sortDir, desired, defaultDirectionFor(currentOrder));
        const labels = directionLabelsFor(currentOrder);
        const opts = sortDir.querySelectorAll("option");
        opts.forEach((opt) => {
          if (opt.value === "asc") opt.textContent = labels.asc;
          if (opt.value === "desc") opt.textContent = labels.desc;
        });
      }
    }
    return;
  }

  fetchOptions().then((opt) => {
    const listenValues = (opt.listen || []).filter((o) => o !== "No preference");
    const shareValues = (opt.share || []).filter((o) => o !== "No preference");

    const genderOptions = withDoNotConsider(opt.gender);
    const countryOptions = withDoNotConsider(opt.country);
    const listenOptions = withDoNotConsider(listenValues);
    const shareOptions = withDoNotConsider(shareValues);

    const wrapper = document.createElement("div");
    wrapper.className = "hb-user-search-filters";

    const currentSort = readSortParams();

    wrapper.innerHTML = `
      <form class="hb-user-search-form">
        <div class="hb-user-search-grid">
          <div class="hb-user-search-field">
            <label for="hb-search-gender">Gender</label>
            <select name="gender" id="hb-search-gender">
              ${genderOptions
                .map(
                  (option) =>
                    `<option value="${option === "Do not consider" ? "" : option}">${option}</option>`
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
                    `<option value="${option === "Do not consider" ? "" : option}">${option}</option>`
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
                    `<option value="${option === "Do not consider" ? "" : option}">${option}</option>`
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
                    `<option value="${option === "Do not consider" ? "" : option}">${option}</option>`
                )
                .join("")}
            </select>
          </div>
        </div>

        ${renderSortControls(currentSort)}

        <div class="hb-user-search-actions">
          <button type="submit" class="btn btn-primary">Search users</button>
          <button type="button" class="btn btn-flat hb-user-search-reset">Reset</button>
        </div>
      </form>
    `;

    if (controls.nextSibling) {
      container.insertBefore(wrapper, controls.nextSibling);
    } else {
      container.appendChild(wrapper);
    }

    const form = wrapper.querySelector(".hb-user-search-form");
    const resetButton = wrapper.querySelector(".hb-user-search-reset");

    // Prefill from current URL query params
    const hb = readHbParams();
    const gender = form.querySelector("select[name='gender']");
    const country = form.querySelector("select[name='country']");
    const listen = form.querySelector("select[name='listen']");
    const share = form.querySelector("select[name='share']");
    if (gender) gender.value = hb.hb_gender || "";
    if (country) country.value = hb.hb_country || "";
    if (listen) listen.value = hb.hb_listen || "";
    if (share) share.value = hb.hb_share || "";

    // Sort prefill
    const sortBy = form.querySelector("select[name='sortBy']");
    const sortDirection = form.querySelector("select[name='sortDirection']");
    if (sortBy) sortBy.value = currentSort.order || "last_seen";
    if (sortDirection) sortDirection.value = currentSort.direction || defaultDirectionFor(sortBy.value);

    // Update direction option labels when sortBy changes
    if (sortBy && sortDirection) {
      sortBy.addEventListener("change", () => {
        const labels = directionLabelsFor(sortBy.value);
        const opts = sortDirection.querySelectorAll("option");
        opts.forEach((optEl) => {
          if (optEl.value === "asc") optEl.textContent = labels.asc;
          if (optEl.value === "desc") optEl.textContent = labels.desc;
        });
        sortDirection.value = defaultDirectionFor(sortBy.value);
      });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const fd = new FormData(form);
      const nextHb = {
        hb_gender: (fd.get("gender") || "").toString().trim(),
        hb_country: (fd.get("country") || "").toString().trim(),
        hb_listen: (fd.get("listen") || "").toString().trim(),
        hb_share: (fd.get("share") || "").toString().trim(),
      };

      const order = (fd.get("sortBy") || "last_seen").toString().trim() || "last_seen";
      const direction =
        (fd.get("sortDirection") || defaultDirectionFor(order)).toString().trim() === "asc"
          ? "asc"
          : "desc";

      applyDirectoryParams({ hb: nextHb, sort: { order, direction } });
    });

    resetButton.addEventListener("click", () => {
      // Do NOT refresh the page (e.g. livestream would stop).
      try {
        form.reset();
      } catch {
        // ignore
      }

      // Reset sort UI labels + values
      if (sortBy) sortBy.value = "last_seen";
      if (sortDirection) {
        const labels = directionLabelsFor("last_seen");
        const opts = sortDirection.querySelectorAll("option");
        opts.forEach((optEl) => {
          if (optEl.value === "asc") optEl.textContent = labels.asc;
          if (optEl.value === "desc") optEl.textContent = labels.desc;
        });
        sortDirection.value = "desc";
      }

      applyDirectoryParams({
        hb: { hb_gender: "", hb_country: "", hb_listen: "", hb_share: "" },
        sort: { order: "last_seen", direction: "desc" },
      });
    });
  });
}

// ----------------------
// Initializer
// ----------------------

export default apiInitializer("0.11.1", (api) => {
  // Make hb_* query params first-class for the /u route so changes trigger a
  // model refresh (and thus a fresh /directory_items.json request).
  api.modifyClass("route:users", {
    pluginId: "discourse-user-search-directory",
    init() {
      this._super(...arguments);
      this.queryParams = this.queryParams || {};
      this.queryParams.hb_gender = { refreshModel: true };
      this.queryParams.hb_country = { refreshModel: true };
      this.queryParams.hb_listen = { refreshModel: true };
      this.queryParams.hb_share = { refreshModel: true };
      // Sorting params should also refresh the model
      this.queryParams.order = { refreshModel: true };
      this.queryParams.asc = { refreshModel: true };
    },
  });

  api.modifyClass("controller:users", {
    pluginId: "discourse-user-search-directory",
    hb_gender: null,
    hb_country: null,
    hb_listen: null,
    hb_share: null,
    order: null,
    asc: null,
  });

  api.onPageChange((url) => {
    const cleanUrl = (url || "").split("#")[0];
    const isDirectory = /^\/u\/?(\?.*)?$/.test(cleanUrl) || /^\/users\/?(\?.*)?$/.test(cleanUrl);
    if (!isDirectory) return;

    // Ensure default sorting is applied once (no hard refresh, just route change).
    if (ensureDefaultSortInUrl(cleanUrl)) return;

    setTimeout(injectFilters, 0);
    setTimeout(updateEmptyStateMessage, 250);
  });
});
