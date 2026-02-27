import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";
import DiscourseURL from "discourse/lib/url";

let optionsCache = null;
let optionsPromise = null;

const HB_KEYS = ["hb_gender", "hb_country", "hb_listen", "hb_share"];

const SORT_FIELDS = [
  { value: "last_seen_at", label: "Last seen", defaultDir: "desc" },
  { value: "username", label: "Username", defaultDir: "asc" },
  { value: "created_at", label: "Join date", defaultDir: "desc" },
];

const DEFAULT_ORDER = "last_seen_at";
const DEFAULT_DIR = "desc";

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
// Sort helpers
// ----------------------

function defaultDirFor(order) {
  const found = SORT_FIELDS.find((f) => f.value === order);
  return found?.defaultDir || DEFAULT_DIR;
}

function readDirParams() {
  const sp = new URLSearchParams(window.location.search);

  const hb = {};
  HB_KEYS.forEach((k) => {
    hb[k] = (sp.get(k) || "").toString();
  });

  const order = (sp.get("order") || "").toString();
  const asc = (sp.get("asc") || "").toString() === "true";
  const dir = asc ? "asc" : "desc";

  return { hb, order, dir };
}

// ----------------------
// URL helpers
// ----------------------

function buildUrlWithParams({ hb, order, dir } = {}) {
  const url = new URL(window.location.href);

  // hb_* filters
  if (hb) {
    HB_KEYS.forEach((k) => {
      const v = (hb && hb[k]) || "";
      if (v) {
        url.searchParams.set(k, v);
      } else {
        url.searchParams.delete(k);
      }
    });
  }

  // sort
  if (order !== undefined) {
    const v = (order || "").toString();
    if (v) {
      url.searchParams.set("order", v);
    } else {
      url.searchParams.delete("order");
    }
  }

  if (dir !== undefined) {
    const d = (dir || "").toString();
    if (d === "asc") {
      url.searchParams.set("asc", "true");
    } else {
      url.searchParams.delete("asc"); // default in Discourse is DESC when omitted
    }
  }

  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

function applyParams(next, { replace } = {}) {
  const nextUrl = buildUrlWithParams(next);

  // Prefer replaceState to avoid adding a history entry for "default sort" normalization
  if (replace && typeof DiscourseURL.replaceState === "function") {
    DiscourseURL.replaceState(nextUrl);
    // replaceState doesn't refresh the model, so we still need a transition
    DiscourseURL.routeTo(nextUrl);
    return;
  }

  DiscourseURL.routeTo(nextUrl);
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

function ensureDefaultSort() {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get("order")) return;

  // Default sort: last seen (newest first)
  applyParams({ order: DEFAULT_ORDER, dir: DEFAULT_DIR }, { replace: true });
}

function syncFormFromUrl(form) {
  if (!form) return;

  const { hb, order, dir } = readDirParams();

  const g = form.querySelector("select[name='gender']");
  const c = form.querySelector("select[name='country']");
  const l = form.querySelector("select[name='listen']");
  const s = form.querySelector("select[name='share']");
  const sb = form.querySelector("select[name='sort_by']");
  const sd = form.querySelector("select[name='sort_dir']");

  if (g) g.value = hb.hb_gender || "";
  if (c) c.value = hb.hb_country || "";
  if (l) l.value = hb.hb_listen || "";
  if (s) s.value = hb.hb_share || "";

  const effectiveOrder = order || DEFAULT_ORDER;
  const effectiveDir = order ? dir : defaultDirFor(effectiveOrder);

  if (sb) sb.value = effectiveOrder;
  if (sd) sd.value = effectiveDir;
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
  const existingWrapper = container.querySelector(".hb-user-search-filters");
  if (existingWrapper) {
    const existingForm = existingWrapper.querySelector(".hb-user-search-form");
    syncFormFromUrl(existingForm);
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

    const sortOptionsHtml = SORT_FIELDS.map(
      (f) => `<option value="${f.value}">${f.label}</option>`
    ).join("");

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

          <div class="hb-user-search-field">
            <label for="hb-search-sort-by">Sort by</label>
            <select name="sort_by" id="hb-search-sort-by">
              ${sortOptionsHtml}
            </select>
          </div>

          <div class="hb-user-search-field">
            <label for="hb-search-sort-dir">Direction</label>
            <select name="sort_dir" id="hb-search-sort-dir">
              <option value="asc">ASC</option>
              <option value="desc">DESC</option>
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

    // Prefill from current URL query params
    syncFormFromUrl(form);

    const sortBy = form.querySelector("select[name='sort_by']");
    const sortDir = form.querySelector("select[name='sort_dir']");

    if (sortBy && sortDir) {
      // When sort field changes, set its expected default direction.
      sortBy.addEventListener("change", () => {
        sortDir.value = defaultDirFor(sortBy.value);
      });
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const fd = new FormData(form);
      const hb = {
        hb_gender: (fd.get("gender") || "").toString().trim(),
        hb_country: (fd.get("country") || "").toString().trim(),
        hb_listen: (fd.get("listen") || "").toString().trim(),
        hb_share: (fd.get("share") || "").toString().trim(),
      };

      const order = (fd.get("sort_by") || DEFAULT_ORDER).toString().trim();
      const dir =
        (fd.get("sort_dir") || defaultDirFor(order)).toString().trim() ||
        defaultDirFor(order);

      applyParams({ hb, order, dir });
    });

    resetButton.addEventListener("click", () => {
      // Do NOT refresh the page (e.g. livestream would stop).
      // Just clear fields + remove hb_* query params.
      try {
        form.reset();
      } catch {
        // ignore
      }

      // Reset sort to defaults too
      if (sortBy) sortBy.value = DEFAULT_ORDER;
      if (sortDir) sortDir.value = DEFAULT_DIR;

      applyParams({
        hb: { hb_gender: "", hb_country: "", hb_listen: "", hb_share: "" },
        order: DEFAULT_ORDER,
        dir: DEFAULT_DIR,
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

      // Ensure sorting changes refresh the directory model as well.
      this.queryParams.order = this.queryParams.order || { refreshModel: true };
      this.queryParams.asc = this.queryParams.asc || { refreshModel: true };
    },
  });

  // Defensive: define properties on the controller so Ember doesn't warn.
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
    const isDirectory =
      /^\/u\/?(\?.*)?$/.test(cleanUrl) || /^\/users\/?(\?.*)?$/.test(cleanUrl);

    if (!isDirectory) return;

    // Default sort to "last seen" if none is specified
    ensureDefaultSort();

    // Let the page render first.
    setTimeout(injectFilters, 0);
  });
});
