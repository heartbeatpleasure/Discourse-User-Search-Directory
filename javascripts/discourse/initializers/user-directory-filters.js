import { apiInitializer } from "discourse/lib/api";
import { ajax } from "discourse/lib/ajax";
import DiscourseURL from "discourse/lib/url";

let optionsCache = null;
let optionsPromise = null;

const HB_KEYS = ["hb_gender", "hb_country", "hb_listen", "hb_share"];

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
// URL helpers
// ----------------------

function readHbParams() {
  const sp = new URLSearchParams(window.location.search);
  const out = {};
  HB_KEYS.forEach((k) => {
    out[k] = (sp.get(k) || "").toString();
  });
  return out;
}

function buildUrlWithHbParams(nextHb) {
  const url = new URL(window.location.href);
  HB_KEYS.forEach((k) => {
    const v = (nextHb && nextHb[k]) || "";
    if (v) {
      url.searchParams.set(k, v);
    } else {
      url.searchParams.delete(k);
    }
  });

  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

function applyHbParams(nextHb) {
  const nextUrl = buildUrlWithHbParams(nextHb);
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
    // Update form values from URL (e.g. back/forward navigation)
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

    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const fd = new FormData(form);
      const nextHb = {
        hb_gender: (fd.get("gender") || "").toString().trim(),
        hb_country: (fd.get("country") || "").toString().trim(),
        hb_listen: (fd.get("listen") || "").toString().trim(),
        hb_share: (fd.get("share") || "").toString().trim(),
      };

      applyHbParams(nextHb);
    });

    resetButton.addEventListener("click", () => {
      // Do NOT refresh the page (e.g. livestream would stop).
      // Just clear fields + remove hb_* query params.
      try {
        form.reset();
      } catch {
        // ignore
      }

      applyHbParams({ hb_gender: "", hb_country: "", hb_listen: "", hb_share: "" });
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
    },
  });

  // Defensive: define properties on the controller so Ember doesn't warn.
  api.modifyClass("controller:users", {
    pluginId: "discourse-user-search-directory",
    hb_gender: null,
    hb_country: null,
    hb_listen: null,
    hb_share: null,
  });

  api.onPageChange((url) => {
    const cleanUrl = (url || "").split("#")[0];
    const isDirectory =
      /^\/u\/?(\?.*)?$/.test(cleanUrl) || /^\/users\/?(\?.*)?$/.test(cleanUrl);

    if (!isDirectory) return;

    // Let the page render first.
    setTimeout(injectFilters, 0);
  });
});
