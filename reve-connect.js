/*! Rêve Connect v1: "Rent it through Rêve" for partner product pages.
 *
 * Install on a partner product page (one tag):
 *   <script src="https://<host>/reve-connect.js" data-partner="eddy" defer></script>
 * Optional: data-config="<url of partner config>", data-product-handle="<handle>" (themes whose
 * product URLs are not /products/<handle>), and a <div data-reve-connect></div> placeholder where the
 * button should go (otherwise it goes after the partner's add-to-cart form).
 * Storefronts that render pages in the browser (Salesforce PWA Kit, 2026-10-19) put the product on the
 * placeholder instead, <div data-reve-connect data-product-handle="<id>">, one per buy box if the layout
 * has two; the button follows the placeholder from page to page without a reload.
 *
 * Flow: button -> panel (size, length, arrival date from Rêve's live calendar) -> Supercycle
 * /intents (exact cart inputs) -> Shopify Storefront API cart on Rêve -> Rêve checkout in a new tab.
 * Every Rêve endpoint used here answers cross-origin (Access-Control-Allow-Origin: *).
 * Contract for the config: contracts/partner-config.v1.schema.json.
 *
 * Analytics (2026-10-20): each product page view sends its events (page view, button seen, panel steps, checkout,
 * the partner's own Add to cart and Buy it now) to Rêve's collector at config reve.collect, in small text/plain
 * beacons. Contract: contracts/event.v1.schema.json. Nothing is stored on the device for it and nothing names the
 * shopper: the page-view id lives in memory and rides on the Rêve cart as _reve_pv, so a paid booking joins back
 * to its visit. Off for the shared demos (partner "demo") and when the store's consent banner says no to analytics.
 * A partner who sends these to their own Google Analytics (config partner.ga4, 2026-10-29) gets one more field per
 * batch: the store's own GA client and session ids, read from its _ga and _ga_<stream> cookies (never written), so
 * Rêve's services/ga4 can put the button's events and the paid rental on the same visitor in that partner's GA.
 */
(function (root, factory) {
  var core = factory();
  var isNode = typeof module === "object" && module.exports;
  if (isNode) module.exports = core;
  else root.ReveConnect = core;
  if (!isNode && typeof document !== "undefined") core.boot(document.currentScript);
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA = "reve-connect/partner-config/1";
  var VERSION = "1.2.0";

  // ---------------------------------------------------------------- pure helpers (unit-tested)

  function productHandleFromPath(pathname) {
    var m = /\/products\/([^/?#]+)/.exec(pathname || "");
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  }

  function parseIso(iso) {
    var p = iso.split("-");
    return Date.UTC(+p[0], +p[1] - 1, +p[2]);
  }

  function toIso(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    return toIso(parseIso(iso) + n * 86400000);
  }

  /* A start date works when Rêve's calendar shows a free unit on every day from arrival to the
   * send-back day. Supercycle's occupancy map already pads each booking with its shipping days. */
  function isBookable(occupancy, startIso, nights) {
    if (!occupancy) return false;
    for (var i = 0; i <= nights; i++) {
      var v = occupancy[addDays(startIso, i)];
      if (!(typeof v === "number" && v >= 1)) return false;
    }
    return true;
  }

  function bookableStarts(occupancy, nights) {
    var out = [];
    Object.keys(occupancy || {}).sort().forEach(function (d) {
      if (isBookable(occupancy, d, nights)) out.push(d);
    });
    return out;
  }

  /* Monday-first weeks for a month: [[iso|null x7], ...]. */
  function monthGrid(year, month) {
    var first = Date.UTC(year, month, 1);
    var lead = (new Date(first).getUTCDay() + 6) % 7;
    var days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    var cells = [];
    for (var i = 0; i < lead; i++) cells.push(null);
    for (var d = 1; d <= days; d++) cells.push(toIso(Date.UTC(year, month, d)));
    while (cells.length % 7) cells.push(null);
    var weeks = [];
    for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return weeks;
  }

  /* mount_after may list several selectors, comma-separated, tried in order (2026-10-19, La DoubleJ: one buy
   * box for computers and another for phones, each hidden on the other). Commas inside (...) or [...] belong
   * to a selector. */
  function splitSelectors(list) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < (list || "").length; i++) {
      var c = list.charAt(i);
      if (c === "(" || c === "[") depth++;
      else if ((c === ")" || c === "]") && depth > 0) depth--;
      if (c === "," && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /* The lowest buy price in the page's own schema.org product data (JSON-LD texts), in cents; 0 when there is
   * none. Salesforce storefronts have no /products/<handle>.js, but they render this (La DoubleJ: offers.price
   * "1390.00"). handle: when a Product's sku is this product, only such Products count (a storefront that swaps
   * pages in the browser can carry the last product's data for a moment). */
  function jsonLdPriceCents(texts, handle) {
    var best = 0, products = [];
    (texts || []).forEach(function (t) {
      var d;
      try { d = JSON.parse(t); } catch (e) { return; }
      [].concat(d && d["@graph"] ? d["@graph"] : d).forEach(function (n) {
        if (n && n["@type"] === "Product") products.push(n);
      });
    });
    var mine = products.filter(function (n) { return handle && String(n.sku || n.productID || "").toLowerCase() === handle; });
    (mine.length ? mine : products).forEach(function (n) {
        [].concat(n.offers || []).forEach(function (o) {
          var v = o && (o.price != null ? o.price : o.lowPrice);
          var c = Math.round(parseFloat(String(v == null ? "" : v).replace(/,/g, "")) * 100);
          if (c > 0 && (!best || c < best)) best = c;
        });
    });
    return best;
  }

  function unitForPartnerVariant(product, partnerVariantId) {
    if (!product || partnerVariantId == null) return -1;
    var id = Number(partnerVariantId);
    for (var i = 0; i < product.units.length; i++) {
      if (product.units[i].partner_variant_ids.indexOf(id) !== -1) return i;
    }
    return -1;
  }

  function fromPrice(product) {
    var min = null;
    product.units.forEach(function (u) {
      u.periods.forEach(function (p) {
        if (min === null || p.price_cents < min) min = p.price_cents;
      });
    });
    return min;
  }

  /* The small line under the button: the rental lengths, plus what the price covers when there are no fees. */
  function buttonNote(product) {
    var days = product.units[0].periods.map(function (x) { return x.days; });
    var free = product.fixed_fees.every(function (f) { return f.price_cents === 0; });
    var lengths = days.join(", ").replace(/, (\d+)$/, " or $1") + (days.length === 1 && days[0] === 1 ? " day" : " days");
    return lengths + (free ? " · shipping and cleaning included" : "");
  }

  function formatMoney(cents) {
    var whole = cents % 100 === 0;
    return "$" + (cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2
    });
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function formatDay(iso) {
    var d = new Date(parseIso(iso));
    return DAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
  }

  /* Supercycle's visible line properties read like "20 Nov 26". */
  function formatPropDate(iso) {
    var d = new Date(parseIso(iso));
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + String(d.getUTCFullYear()).slice(2);
  }

  function intentBody(unit, period, startIso) {
    return { variantId: unit.variant_id, option: { globalId: period.global_id, params: { rental_start: startIso } } };
  }

  /* /intents returns form-style keys ("properties[_cycle]", "selling_plan"); split them. */
  function splitIntent(attributes) {
    var props = {}, sellingPlan = null;
    Object.keys(attributes || {}).forEach(function (k) {
      var m = /^properties\[(.+)\]$/.exec(k);
      if (m) props[m[1]] = String(attributes[k]);
      else if (k === "selling_plan") sellingPlan = Number(attributes[k]);
    });
    return { properties: props, sellingPlan: sellingPlan };
  }

  function visibleProperties(startIso, nights) {
    return { "Start date": formatPropDate(startIso), "End date": formatPropDate(addDays(startIso, nights)) };
  }

  /* The rental line's hidden tags: the partner (payout), and the page view (opts.pv, when analytics is on) so the
   * booking joins back to its visit in services/report/funnel.py. */
  function lineTags(opts) {
    var tags = { _reve_partner: opts.partnerId };
    if (opts.pv) tags._reve_pv = opts.pv;
    return tags;
  }

  /* Storefront API CartInput for one rental line, tagged with the partner for reporting. */
  function cartInput(opts) {
    var intent = splitIntent(opts.intentAttributes);
    if (!intent.sellingPlan || !intent.properties._cycle) {
      throw new Error("intent is missing selling_plan or _cycle");
    }
    var props = Object.assign({}, intent.properties, visibleProperties(opts.startIso, opts.period.nights), lineTags(opts));
    var lineAttrs = Object.keys(props).map(function (k) { return { key: k, value: props[k] }; });
    var attributes = [
      { key: "_reve_partner", value: opts.partnerId },
      { key: "_reve_partner_product", value: opts.partnerHandle },
      { key: "_reve_connect", value: VERSION }
    ];
    if (opts.pv) attributes.push({ key: "_reve_pv", value: opts.pv });
    return {
      lines: [{
        merchandiseId: "gid://shopify/ProductVariant/" + opts.unit.variant_id,
        quantity: 1,
        sellingPlanId: "gid://shopify/SellingPlan/" + intent.sellingPlan,
        attributes: lineAttrs
      }],
      attributes: attributes
    };
  }

  /* Fallback path: the same inputs Supercycle puts on Rêve's own product form, posted to /cart/add. */
  function cartFormFields(opts) {
    var intent = splitIntent(opts.intentAttributes);
    var fields = { id: String(opts.unit.variant_id), quantity: "1", selling_plan: String(intent.sellingPlan), return_to: "/checkout" };
    var props = Object.assign({}, intent.properties, visibleProperties(opts.startIso, opts.period.nights), lineTags(opts));
    Object.keys(props).forEach(function (k) { fields["properties[" + k + "]"] = props[k]; });
    return fields;
  }

  var CART_CREATE = "mutation ReveConnectCart($input: CartInput!) { cartCreate(input: $input) { " +
    "cart { id checkoutUrl cost { totalAmount { amount currencyCode } } } " +
    "userErrors { field message code } warnings { code message } } }";

  /* Stable 0..1 bucket per visitor for the optional holdout (cannibalisation test). */
  function bucket(seed) {
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10000) / 10000;
  }

  /* Partner rule: hide the button when buying costs less than `ratio` x the cheapest rental
   * (deep-sale pages, where "rent from $50" next to "buy for $98" makes no sense). */
  function worthRenting(buyCents, rentCents, ratio) {
    if (!ratio || !(buyCents > 0) || !(rentCents > 0)) return true;
    return buyCents >= ratio * rentCents;
  }

  function localTodayIso() {
    var d = new Date();
    return toIso(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  function daysBetween(fromIso, toIsoDay) {
    return Math.round((parseIso(toIsoDay) - parseIso(fromIso)) / 86400000);
  }

  // ---------------------------------------------------------------- analytics, pure parts (contracts/event.v1.schema.json)

  var PV_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

  /* A page-view id: 16 random characters, kept in memory only. bytes: 16 random bytes (tests pass their own). */
  function pageViewId(bytes) {
    var s = "";
    for (var i = 0; i < 16; i++) s += PV_CHARS.charAt(bytes[i] % 36);
    return s;
  }

  function deviceOf(width) { return width < 768 ? "phone" : "computer"; }

  /* What the partner's own product data says, from Shopify's /products/<handle>.js (prices in cents): the lowest
   * available price, the compare-at price of that variant when it is higher (on sale), and every variant's name
   * and price by id, so Add to cart can say which size and price. null (no data) -> nulls and no variants. */
  function productFacts(pj) {
    var facts = { buy: null, compare: null, variants: {} };
    if (!pj || !pj.variants) return facts;
    pj.variants.forEach(function (v) {
      facts.variants[String(v.id)] = { title: v.title, price: typeof v.price === "number" ? v.price : null };
      if (v.available && typeof v.price === "number" && (facts.buy === null || v.price < facts.buy)) {
        facts.buy = v.price;
        facts.compare = typeof v.compare_at_price === "number" && v.compare_at_price > v.price ? v.compare_at_price : null;
      }
    });
    return facts;
  }

  /* The partner's name for a variant ("S", "Pink / S"); Shopify calls a product without options "Default Title". */
  function sizeLabel(variant) {
    var t = variant && variant.title;
    return t && t !== "Default Title" ? String(t).slice(0, 80) : null;
  }

  /* The store's own Google Analytics ids, for a partner whose config names its GA stream (partner.ga4): the client
   * id is _ga's last two parts (GA1.1.<c>), the session id the s part of _ga_<stream> (GS2.1.s<s>$o1$g1$t...; the
   * older GS1.1.<s>.<n>...). cookieText: document.cookie. -> { c, s } ({ c } before GA starts a session), or null
   * without a well-formed _ga. The page's cookies are read here, never written. */
  function gaIds(cookieText, measurementId) {
    var jar = Object.create(null);           // a cookie named __proto__ is just a name
    String(cookieText || "").split(";").forEach(function (part) {
      var i = part.indexOf("=");
      if (i > 0) { var k = part.slice(0, i).trim(); if (!has(jar, k)) jar[k] = part.slice(i + 1).trim(); }
    });
    var client = /^GA\d+\.\d+\.(\d{1,20}\.\d{1,20})$/.exec(jar._ga || "");
    if (!client) return null;
    var out = { c: client[1] };
    var stream = /^G-([A-Z0-9]{4,20})$/.exec(measurementId || "");
    var sess = (stream && jar["_ga_" + stream[1]]) || "";
    var sid = /^GS\d+\.\d+\.s(\d{1,20})\$/.exec(sess) || /^GS1\.\d+\.(\d{1,20})\./.exec(sess);
    if (sid) out.s = sid[1];
    return out;
  }

  /* One beacon's body: the page view's facts once, then its events (at most 50). */
  function batchBody(meta, events) {
    var b = { v: 1, partner: meta.partner, pv: meta.pv, widget: VERSION, device: meta.device };
    if (meta.wd) b.wd = true;
    if (meta.test) b.test = true;
    if (meta.ga) b.ga = meta.ga;
    b.events = events;
    return b;
  }

  // ---------------------------------------------------------------- option B3, future state (rent in the partner's cart)
  // Customer flow only: the rental goes into the partner's own bag and is paid at the partner's own
  // Shopify checkout; Rêve ships, collects and cleans it. In the demo the bag and checkout are
  // illustrations, the dates are checked live, and nothing is ordered or charged. The contract and
  // validConfig allow it for partner id "demo" only, like the shared demo's checkout mode (option A's
  // flow ending on the demo's illustrated /checkout page instead of a real cart).
  // Code between the demo-start and demo-end marker lines is stripped from the partner build
  // (services/catalog/build.py partner_widget); only the shared demo serves the full file.

  var CHECKOUTS = { rentwithreve: true };

  function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function validConfig(cfg) {
    if (!(cfg && cfg.schema === SCHEMA && cfg.partner && cfg.reve && cfg.products)) return false;
    var mode = cfg.partner.checkout || "rentwithreve";
    if (!has(CHECKOUTS, mode)) return false;
    // a preview piece has no Rêve variant behind it: it only ever rides in a preview config, and a preview
    // config carries nothing else
    var preview = mode === "rentwithreve_preview";
    for (var k in cfg.products) if (has(cfg.products, k) && !!(cfg.products[k] && cfg.products[k].preview) !== preview) return false;
    return mode === "rentwithreve" || cfg.partner.id === "demo";  // every other mode is demo-only
  }


  // ---------------------------------------------------------------- browser side

  function emit(name, detail) {
    try {
      if (window.Shopify && window.Shopify.analytics && typeof window.Shopify.analytics.publish === "function") {
        window.Shopify.analytics.publish(name, detail);
      }
    } catch (e) { /* analytics must never break the page */ }
    try { window.dispatchEvent(new CustomEvent("reve-connect:" + name.replace(/^reve_connect_/, ""), { detail: detail })); } catch (e) { }
  }

  function visitorSeed() {
    try {
      var k = "reve_connect_vid", v = localStorage.getItem(k);
      if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return "anon"; }
  }

  /* The shopper's analytics choice where the store asks for one: true, false, or null when the page has no way to
   * say (many US stores). A store's own cookie banner can set window.reveConnectAnalytics = true / false before
   * the script runs (Salesforce storefronts have no Shopify API); otherwise Shopify's Customer Privacy API. */
  function analyticsChoice() {
    try {
      if (window.reveConnectAnalytics === true || window.reveConnectAnalytics === false) return window.reveConnectAnalytics;
      var cp = window.Shopify && window.Shopify.customerPrivacy;
      if (cp && typeof cp.analyticsProcessingAllowed === "function") return !!cp.analyticsProcessingAllowed();
    } catch (e) { }
    return null;
  }

  /* The holdout keeps a visitor id on the device, so it only runs for shoppers who said yes to analytics:
   * "holdout" (no button), "exposed", or null (no holdout running, or no yes). */
  function holdoutCohort(cfg) {
    if (!(cfg.partner.holdout_share > 0) || analyticsChoice() !== true) return null;
    return bucket(visitorSeed() + ":" + cfg.partner.id) < cfg.partner.holdout_share ? "holdout" : "exposed";
  }

  function randomBytes() {
    var a = new Uint8Array(16);
    try { crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256); }
    return a;
  }

  /* One product page view's events, queued and sent to Rêve's collector in text/plain beacons (no preflight, and
   * the page can close: a beacon still goes). Off without a collector address, for the shared demos and when the
   * shopper said no to analytics. Keeps nothing on the device. track() never throws into the partner's page. */
  function Tracker(cfg, handle) {
    var self = this;
    this.url = (cfg.reve && cfg.reve.collect) || null;
    this.partner = cfg.partner.id; this.product = String(handle).slice(0, 200);
    this.pv = pageViewId(randomBytes()); this.seq = 0; this.queue = []; this.t0 = Date.now(); this.once = {};
    this.on = !!this.url && this.partner !== "demo" && analyticsChoice() !== false;
    this.ga4 = (cfg.partner && cfg.partner.ga4) || null;     // the partner's own GA stream: its ids ride on each batch
    if (!this.on) return;
    this.onHide = function () { if (document.visibilityState === "hidden") self.flush(); };
    this.onLeave = function () { self.flush(); };
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onLeave);
  }

  // the moments a shopper is about to leave (a checkout tab, their cart, a closed panel): sent at once, not batched
  var SEND_NOW = { checkout_start: 1, checkout: 1, buy_add_to_cart: 1, buy_now: 1, close: 1, error: 1 };

  /* once: a key; the event goes at most once per page view under it (button seen, no dates for a size). */
  Tracker.prototype.track = function (name, props, once) {
    if (!this.on || this.seq > 10000) return;
    if (once) { if (this.once[once]) return; this.once[once] = true; }
    var self = this;
    this.queue.push({ e: name, s: this.seq++, t: Math.max(0, Date.now() - this.t0), product: this.product, p: props || {} });
    try { window.dispatchEvent(new CustomEvent("reve-connect:event", { detail: { name: name, props: props || {}, pv: this.pv } })); } catch (e) { }
    if (this.queue.length >= 20 || SEND_NOW[name]) this.flush();
    else if (!this.timer) this.timer = setTimeout(function () { self.timer = null; self.flush(); }, 1500);
  };

  Tracker.prototype.flush = function () {
    clearTimeout(this.timer); this.timer = null;
    // read at each send, not once: the store's GA tag sets its cookies a moment after the page loads
    var ga = null;
    if (this.ga4 && this.queue.length) { try { ga = gaIds(document.cookie, this.ga4); } catch (e) { } }
    while (this.queue.length) {
      var body = JSON.stringify(batchBody({ partner: this.partner, pv: this.pv, device: deviceOf(window.innerWidth || 1024),
        wd: navigator.webdriver === true, test: window.__reveConnectTest === true, ga: ga }, this.queue.splice(0, 50)));
      var sent = false;
      try { sent = typeof navigator.sendBeacon === "function" && navigator.sendBeacon(this.url, new Blob([body], { type: "text/plain" })); } catch (e) { }
      if (!sent) {
        try { fetch(this.url, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(function () { }); } catch (e) { }
      }
    }
  };

  /* The shopper moved to another product without a reload: send what is left and stop listening. */
  Tracker.prototype.end = function () {
    if (!this.on) return;
    this.flush();
    this.on = false;
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onLeave);
  };

  // the partner's express checkout buttons (Shop Pay, Buy it now) as Shopify themes draw them
  var BUY_NOW = ".shopify-payment-button, shopify-accelerated-checkout, [data-shopify='payment-button']";

  /* The partner's own Add to cart and Buy it now on this page: their main product form's submit button (or the
   * partner's cart_button on a storefront without a form), counted once per press (a click and the form's submit
   * event within 1.5s are one press). -> a function that stops listening. */
  function watchBuys(cfg, tr, facts, form) {
    if (!tr || !tr.on) return function () { };
    var sel = cfg.partner.cart_button, last = 0;
    function variant(f) { return facts.variants[String(readPartnerVariant(f || form) || "")] || null; }
    function addPress(f) {
      var now = Date.now();
      if (now - last < 1500) return;
      last = now;
      var v = variant(f);
      tr.track("buy_add_to_cart", { partner_size: sizeLabel(v), buy_cents: v && v.price != null ? v.price : facts.buy });
    }
    function inForm(t) { return form && form.contains && form.contains(t); }
    function onClick(e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest(BUY_NOW)) { tr.track("buy_now", { partner_size: sizeLabel(variant()) }); return; }
      var add = sel ? t.closest(sel) : (inForm(t) && t.closest("button[type='submit'], input[type='submit'], [name='add']"));
      if (add && !add.disabled) addPress(add.form || null);
    }
    function onSubmit(e) {
      var f = e.target;
      if (!sel && f && (f === form || inForm(f))) addPress(f);
    }
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return function () {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === "text") n.textContent = v;
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  /* On screen and in the page's flow: not display:none (itself or an ancestor) and not inside a fixed bar
   * (La DoubleJ's phone layout floats its Add to bag over the page). A sticky buy column is in the flow. */
  function inFlow(e) {
    if (!e.getClientRects().length) return false;
    for (var n = e; n && n.nodeType === 1; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") return false;
    }
    return true;
  }

  /* The element the button goes after: the first selector in mount_after with a match in the flow wins, then
   * the first such match in the page. */
  function findAnchor(list) {
    var sels = splitSelectors(list);
    for (var i = 0; i < sels.length; i++) {
      var found;
      try { found = document.querySelectorAll(sels[i]); } catch (e) { continue; }
      for (var j = 0; j < found.length; j++) if (inFlow(found[j])) return found[j];
    }
    return null;
  }

  function readPartnerVariant(form) {
    var input = form && form.querySelector("input[name='id']:not([disabled]), select[name='id']");
    if (input && input.value) return input.value;
    var q = /[?&]variant=(\d+)/.exec(location.search);
    return q ? q[1] : null;
  }

  function findForm(cfg) {
    var sel = cfg.partner.mount_after;
    var form = sel ? findAnchor(sel) : null;
    if (!form) {
      var forms = document.querySelectorAll("form[action*='/cart/add']");
      for (var i = 0; i < forms.length; i++) if (forms[i].querySelector("[type='submit']")) { form = forms[i]; break; }
    }
    return form;
  }

  var CSS_BUTTON = [
    ":host{display:block;margin:12px 0 0;font:inherit;color:inherit;-webkit-font-smoothing:antialiased}",
    ".rc{--ink:#2b2326;--rose:#83545f;--blush:#f3e3e3;--sage:#98b3a6;--cream:#f4f0ec;",
    "  --serif:'Cormorant Garamond',Cormorant,'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif}",
    // quieter than the partner's Add to cart: one line, hairline border, the blush fill only on hover
    "button.cta{all:unset;box-sizing:border-box;display:flex;align-items:baseline;gap:8px;width:100%;cursor:pointer;",
    "  padding:10px 14px;background:transparent;color:var(--ink);border:1px solid rgba(43,35,38,.18);",
    "  font-size:13px;line-height:1.2;transition:background .2s ease,border-color .2s ease,transform .2s ease}",
    "button.cta:hover{background:var(--blush);border-color:rgba(131,84,95,.4)}",
    "button.cta:active{transform:translateY(1px)}",
    "button.cta:focus-visible{outline:2px solid var(--rose);outline-offset:3px}",
    ".lead{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.78}",
    ".mark{flex:none;font-family:var(--serif);font-size:16px;letter-spacing:.16em;line-height:1;color:var(--rose);font-weight:500}",
    ".price{flex:none;margin-left:auto;white-space:nowrap}",
    ".arrow{flex:none;color:var(--rose);transition:transform .25s ease}",
    "button.cta:hover .arrow{transform:translateX(2px)}",
    ".note{margin:6px 0 0;font-size:11.5px;opacity:.62}",
    // a narrow buy column keeps the mark and the price; the aria-label keeps the full name
    ".narrow .lead{display:none}",
    "@media (prefers-reduced-motion:reduce){*{transition:none!important}}"
  ].join("\n");

  var CSS_PANEL = [
    ":host{all:initial}",
    ".rc{--ink:#2b2326;--muted:#7b6e71;--rose:#83545f;--rose2:#af838e;--blush:#f3e3e3;--sage:#98b3a6;",
    "  --cream:#f4f0ec;--line:rgba(43,35,38,.12);",
    "  --serif:'Cormorant Garamond',Cormorant,'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;",
    "  font-family:var(--font,inherit);color:var(--ink);font-size:14px;line-height:1.45;-webkit-font-smoothing:antialiased}",
    ".scrim{position:fixed;inset:0;background:rgba(32,24,27,.38);opacity:0;transition:opacity .28s ease;z-index:2147483000;pointer-events:none}",
    ".open .scrim{pointer-events:auto}",
    ".sheet{position:fixed;top:0;right:0;height:100%;width:440px;max-width:100%;background:var(--cream);z-index:2147483001;",
    "  box-shadow:-24px 0 60px rgba(32,24,27,.18);transform:translateX(102%);transition:transform .32s cubic-bezier(.2,.8,.2,1);",
    "  display:flex;flex-direction:column;outline:none}",
    ".open .scrim{opacity:1}.open .sheet{transform:none}",
    // phones: pinned to both edges, never 100vw (a partner page that overflows sideways widens the
    // fixed containing block past 100vw and a vw-sized sheet would hang off the right edge)
    "@media (max-width:640px){.sheet{top:auto;bottom:0;left:0;right:0;width:auto;height:auto;max-height:92vh;transform:translateY(102%);",
    "  border-radius:14px 14px 0 0;box-shadow:0 -18px 50px rgba(32,24,27,.2)}}",
    ".head{padding:22px 24px 14px;border-bottom:1px solid var(--line);position:relative}",
    ".kicker{font-size:11px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}",
    "h2{font-family:var(--serif);font-weight:500;font-size:30px;line-height:1.05;margin:6px 0 6px;letter-spacing:.01em}",
    "h2 em{font-style:normal;color:var(--rose);letter-spacing:.14em}",
    ".lede{margin:0;color:var(--muted);font-size:13px;max-width:42ch;padding-right:28px}",
    ".x{all:unset;position:absolute;top:16px;right:16px;width:36px;height:36px;display:grid;place-items:center;cursor:pointer;",
    "  border-radius:50%;font-size:20px;color:var(--ink)}",
    ".x:hover{background:rgba(43,35,38,.06)}.x:focus-visible{outline:2px solid var(--rose)}",
    ".body{padding:18px 24px 8px;overflow:auto;flex:1}",
    ".piece{display:flex;gap:14px;align-items:center;padding:0 0 16px;border-bottom:1px solid var(--line);margin-bottom:16px}",
    ".piece img{width:64px;height:85px;object-fit:cover;background:#e9e1db}",
    ".piece .t{font-family:var(--serif);font-size:19px;line-height:1.15}",
    ".piece .s{color:var(--muted);font-size:12px;margin-top:3px}",
    ".sec{margin:0 0 18px}",
    ".enter .sec{animation:rise .45s both}",
    ".enter .sec:nth-child(4){animation-delay:.05s}.enter .sec:nth-child(5){animation-delay:.1s}",
    "@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
    ".lbl{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--muted);margin:0 0 8px;display:flex;justify-content:space-between}",
    ".chips{display:flex;flex-wrap:wrap;gap:8px}",
    ".chip{all:unset;box-sizing:border-box;cursor:pointer;padding:9px 14px;border:1px solid var(--line);background:#fbf9f7;",
    "  font-size:13px;min-width:46px;text-align:center;transition:border-color .15s,background .15s}",
    ".chip:hover{border-color:var(--rose2)}.chip:focus-visible{outline:2px solid var(--rose);outline-offset:2px}",
    ".chip[aria-pressed=true]{background:var(--ink);color:var(--cream);border-color:var(--ink)}",
    ".chip small{display:block;font-size:11px;opacity:.75;margin-top:1px}",
    ".hint{font-size:12px;color:var(--muted);margin:8px 0 0}",
    ".cal{border:1px solid var(--line);background:#fbf9f7;padding:12px 12px 8px}",
    ".calh{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}",
    ".calh b{font-family:var(--serif);font-weight:500;font-size:19px}",
    ".nav{all:unset;cursor:pointer;width:32px;height:32px;display:grid;place-items:center;border-radius:50%}",
    ".nav:hover{background:rgba(43,35,38,.06)}.nav[disabled]{opacity:.25;cursor:default;background:none}",
    ".nav:focus-visible{outline:2px solid var(--rose)}",
    ".grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px 0}",
    ".dow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);text-align:center;padding:4px 0}",
    ".day{all:unset;box-sizing:border-box;height:38px;display:grid;place-items:center;font-size:13px;cursor:pointer;position:relative}",
    ".day[disabled]{color:rgba(43,35,38,.28);cursor:default;text-decoration:line-through;text-decoration-color:rgba(43,35,38,.18)}",
    ".day:not([disabled]):hover span{background:rgba(152,179,166,.35)}",
    ".day span{width:34px;height:34px;display:grid;place-items:center;border-radius:50%;position:relative;z-index:1}",
    ".day.inrange{background:rgba(152,179,166,.28)}",
    ".day.first{background:linear-gradient(90deg,transparent 50%,rgba(152,179,166,.28) 50%)}",
    ".day.last{background:linear-gradient(90deg,rgba(152,179,166,.28) 50%,transparent 50%)}",
    ".day.first span{background:var(--ink);color:var(--cream)}",
    ".day.last span{background:var(--sage);color:var(--ink)}",
    ".day:focus-visible span{outline:2px solid var(--rose)}",
    ".legend{display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:8px}",
    ".legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}",
    ".sum{border-top:1px solid var(--line);padding-top:14px;display:grid;grid-template-columns:1fr auto;gap:6px 12px;font-size:13px}",
    ".sum .k{color:var(--muted)}.sum .v{text-align:right}",
    ".sum .tot{font-family:var(--serif);font-size:24px;line-height:1}",
    ".foot{padding:14px 24px 20px;border-top:1px solid var(--line);background:var(--cream)}",
    ".go{all:unset;box-sizing:border-box;display:flex;justify-content:center;align-items:center;gap:10px;width:100%;cursor:pointer;",
    "  padding:15px 18px;background:var(--rose);color:#fff;font-size:13px;letter-spacing:.16em;text-transform:uppercase;",
    "  transition:background .2s,opacity .2s}",
    ".go:hover{background:#6f4550}.go:focus-visible{outline:2px solid var(--ink);outline-offset:3px}",
    ".go[disabled]{opacity:.38;cursor:default;background:var(--rose)}",
    ".fine{font-size:11.5px;color:var(--muted);text-align:center;margin:10px 0 0}",
    ".err{background:#fbe9e7;color:#7a2e22;padding:10px 12px;font-size:12.5px;margin:0 0 12px}",
    ".skel{height:250px;display:grid;place-items:center;color:var(--muted);font-size:12px}",
    // option B3 future state: steps, bag, checkout preview, confirmation
    "@media (prefers-reduced-motion:reduce){.sheet,.scrim{transition:none}.enter .sec{animation:none}}"
  ].join("\n");

  function Widget(cfg, handle, product, form) {
    this.cfg = cfg; this.handle = handle; this.product = product; this.form = form;
    this.unit = 0; this.period = 0; this.start = null; this.month = null;
    this.timelines = {}; this.error = null; this.busy = false; this.lastFocus = null;
    this.step = "dates"; this.focusKey = null;
  }

  Widget.prototype.inPartnerCart = function () { return this.cfg.partner.checkout === "partner_cart_demo"; };


  Widget.prototype.reve = function (path) { return this.cfg.reve.storefront.replace(/\/$/, "") + path; };

  /* Analytics for this page view (boot gives the widget its Tracker; the demos' is off). */
  Widget.prototype.track = function (name, props, once) { if (this.tr) this.tr.track(name, props, once); };

  /* Seen = at least half the button on screen for a second, once per page view (any of its placeholders). */
  Widget.prototype.watchSeen = function () {
    var self = this;
    if (!this.tr || !this.tr.on || typeof IntersectionObserver !== "function") return;
    var showing = [], timer = null;
    this.seenIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var i = showing.indexOf(en.target), vis = en.isIntersecting && en.intersectionRatio >= 0.5;
        if (vis && i === -1) showing.push(en.target);
        if (!vis && i !== -1) showing.splice(i, 1);
      });
      if (showing.length && !timer) {
        timer = setTimeout(function () { self.track("button_seen", {}, "seen"); if (self.seenIO) self.seenIO.disconnect(); }, 1000);
      } else if (!showing.length && timer) { clearTimeout(timer); timer = null; }
    }, { threshold: [0, 0.5, 1] });
    this.hosts.forEach(function (h) { self.seenIO.observe(h); });
  };

  Widget.prototype.syncUnitFromPage = function () {
    var i = unitForPartnerVariant(this.product, readPartnerVariant(this.form));
    this.partnerSizeMatched = i !== -1;
    if (i !== -1 && i !== this.unit) { this.unit = i; this.start = null; this.month = null; }
  };

  /* The placeholders for this product: every [data-reve-connect] without a product, or with this one. */
  function placeholdersFor(handle) {
    return [].filter.call(document.querySelectorAll("[data-reve-connect]"), function (n) {
      var h = (n.getAttribute("data-product-handle") || "").toLowerCase();
      return !h || h === handle;
    });
  }

  Widget.prototype.mountButton = function () {
    var self = this;
    var placed = placeholdersFor(this.handle);
    this.placed = placed.length > 0;
    if (placed.length) this.hosts = placed;
    else {
      var host = el("div", { "data-reve-connect-host": "" });
      // the host is an empty div in the page's own DOM (its content lives in the shadow root): a theme rule such as
      // Staud's `.product__content div:empty{display:none!important}` (2026-10-22) hides it; the inline rule wins
      host.style.setProperty("display", "block", "important");
      this.form.insertAdjacentElement("afterend", host);
      // a theme that narrows its buy column on the form itself (Ulla Johnson: max-width 90%) would
      // leave the button sticking out past Add to cart; the host takes the form's cap
      var fs = getComputedStyle(this.form), cap = fs.maxWidth;
      if (cap && cap !== "none") {
        host.style.maxWidth = cap;
        // and a capped form centred in its column (Cara Cara: 325px, auto margins) has the button centred under it
        var ml = parseFloat(fs.marginLeft) || 0, mr = parseFloat(fs.marginRight) || 0;
        if (ml > 0 && Math.abs(ml - mr) < 1) { host.style.marginLeft = "auto"; host.style.marginRight = "auto"; }
      }
      this.hosts = [host];
    }
    this.hosts.forEach(function (h) { self.drawButton(h); });
    emit("reve_connect_view", { partner: this.cfg.partner.id, product: this.handle });
    this.watchSeen();
  };

  /* Still on the page: a storefront that swaps pages in the browser removes or reuses the placeholder. */
  Widget.prototype.attached = function () {
    return (this.hosts || []).some(function (h) {
      return h.isConnected && h.shadowRoot && h.shadowRoot.querySelector("button.cta");
    });
  };

  /* The shopper left this product (a page swapped in the browser): the button and the panel go. */
  Widget.prototype.destroy = function () {
    if (this.isOpen) this.close();
    clearInterval(this.syncTimer);
    if (this.seenIO) { this.seenIO.disconnect(); this.seenIO = null; }
    (this.hosts || []).forEach(function (h) {
      if (h.hasAttribute("data-reve-connect")) { if (h.shadowRoot) h.shadowRoot.innerHTML = ""; }
      else if (h.parentNode) h.parentNode.removeChild(h);
    });
    var panel = this.root && this.root.host;
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    this.hosts = [];
  };

  /* Quieter than Add to cart means never taller than it. have/want: the two buttons' heights; pads: the Rêve
     button's vertical padding today. -> the vertical padding that puts it a hair under, never below 4px; null when
     it already is under (or nothing to measure). Amanda Uprichard's Add to cart is 29px (2026-10-22); ours was 39. */
  function fitPadding(have, want, padTop, padBottom) {
    if (!(have > 0) || !(want > 0) || have < want) return null;
    var content = have - (padTop || 0) - (padBottom || 0);
    return Math.max(4, Math.floor((want - 1 - content) / 2));
  }

  function fitUnderAddToCart(cta, form, cartSel) {
    if (!cta || !form || typeof getComputedStyle !== "function") return;
    var atc = null;
    try { atc = cartSel ? (form.matches(cartSel) ? form : form.querySelector(cartSel)) : form.querySelector('[type=submit]'); } catch (e) { }
    if (!atc) return;
    var cs = getComputedStyle(cta), pad = fitPadding(cta.getBoundingClientRect().height, atc.getBoundingClientRect().height,
                                                   parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0);
    if (pad !== null) { cta.style.paddingTop = pad + "px"; cta.style.paddingBottom = pad + "px"; }
  }

  Widget.prototype.drawButton = function (host) {
    var self = this, p = this.product;
    host.setAttribute("data-reve-connect-host", "");
    var shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.innerHTML = "";
    var from = "from " + formatMoney(fromPrice(p));
    var rc = el("div", { class: "rc" }, [
      el("button", { class: "cta", type: "button", "aria-haspopup": "dialog", "aria-label": "Rent it through Rêve " + from,
                     onclick: function () { self.open(); } }, [
        el("span", { class: "lead", text: "Rent it through" }),
        el("span", { class: "mark", text: "RÊVE" }),
        el("span", { class: "price", text: from }),
        el("span", { class: "arrow", "aria-hidden": "true", text: "→" })
      ]),
      el("p", { class: "note", text: buttonNote(p) })
    ]);
    shadow.appendChild(el("style", { text: CSS_BUTTON }));
    shadow.appendChild(rc);
    fitUnderAddToCart(rc.querySelector("button.cta"), this.form, this.cfg.partner.cart_button);
    // drop "Rent it through" whole when the partner's font and column can't fit it (it shrinks first).
    // Not a container query: containment would collapse the button in a theme that sizes it to its content.
    var lead = rc.querySelector(".lead");
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(function () {
        rc.classList.remove("narrow");
        if (lead.scrollWidth > lead.clientWidth) rc.classList.add("narrow");
      }).observe(host);
    }
  };

  Widget.prototype.mountPanel = function () {
    var self = this;
    var host = el("div", { "data-reve-connect-panel": "" });
    host.style.setProperty("display", "block", "important");   // the same div:empty rule hides the panel host (PODYH, Staud)
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.root.appendChild(el("style", { text: CSS_PANEL }));
    var bodyFont = getComputedStyle(document.body).fontFamily;
    this.wrap = el("div", { class: "rc", style: "--font:" + bodyFont });
    this.root.appendChild(this.wrap);
    this.wrap.addEventListener("keydown", function (e) {
      if (e.key === "Escape") self.close();
      if (e.key === "Tab") self.trapTab(e);
    });
  };

  Widget.prototype.trapTab = function (e) {
    var f = this.root.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled])");
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1], active = this.root.activeElement;
    if (e.shiftKey && active === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && active === last) { first.focus(); e.preventDefault(); }
  };

  Widget.prototype.open = function () {
    if (!this.root) this.mountPanel();
    clearTimeout(this.closeTimer);
    this.isOpen = true;
    this.lastFocus = document.activeElement;
    this.syncUnitFromPage();
    this.error = null;
    if (this.step === "done") { this.step = "dates"; this.start = null; }
    if (!this.start && this.step !== "bag" && this.step !== "checkout") this.step = "dates";  // a size change clears the dates
    this.prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    this.render();
    var self = this;
    this.wrap.classList.add("enter");
    clearTimeout(this.enterTimer);
    this.enterTimer = setTimeout(function () { self.wrap.classList.remove("enter"); }, 700);
    requestAnimationFrame(function () { self.wrap.classList.add("open"); var s = self.root.querySelector(".sheet"); if (s) s.focus(); });
    emit("reve_connect_open", { partner: this.cfg.partner.id, product: this.handle });
    // the size the shopper has picked on the partner's page, and whether Rêve has it (the sizes to consign)
    var picked = sizeLabel(this.facts && this.facts.variants[String(readPartnerVariant(this.form) || "")]);
    this.track("open", { partner_size: picked, size_match: !!this.partnerSizeMatched });
    this.loadTimeline();
  };

  Widget.prototype.close = function () {
    if (!this.wrap || !this.isOpen) return;
    this.track("close", { step: this.renderedStep || "dates", had_start: !!this.start });
    this.isOpen = false;
    this.wrap.classList.remove("open");
    document.documentElement.style.overflow = this.prevOverflow || "";
    var self = this;
    // empty the panel once it has slid away, unless it was reopened meanwhile (isOpen is set at once;
    // the "open" class only lands a frame later, so checking the class blanked a quick reopen)
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(function () { if (!self.isOpen) self.wrap.innerHTML = ""; }, 340);
    if (this.lastFocus && this.lastFocus.focus) this.lastFocus.focus();
  };

  Widget.prototype.current = function () {
    var u = this.product.units[this.unit];
    return { unit: u, period: u.periods[Math.min(this.period, u.periods.length - 1)] };
  };

  Widget.prototype.loadTimeline = function () {
    var self = this, vid = this.current().unit.variant_id;
    if (this.timelines[vid] && !this.timelines[vid].failed) return;
    this.timelines[vid] = { loading: true };
    var size = this.current().unit.size, t0 = Date.now();
    fetch(this.reve(this.cfg.reve.proxy_path + "/availability_timelines?variant_shopify_id=" + vid))
      .then(function (r) { if (!r.ok) throw new Error("calendar HTTP " + r.status); return r.json(); })
      .then(function (t) {
        self.timelines[vid] = { occupancy: t.occupancy || {} };
        self.track("calendar", { size: size, ms: Math.min(Date.now() - t0, 600000), ok: true });
      })
      .catch(function (e) {
        self.timelines[vid] = { failed: true };
        self.track("calendar", { size: size, ms: Math.min(Date.now() - t0, 600000), ok: false });
        self.track("error", { step: "calendar", message: String((e && e.message) || "error").slice(0, 120), size: size });
      })
      .then(function () { self.render(); });
  };

  function thumb(src, w) { return src + (src.indexOf("?") === -1 ? "?" : "&") + "width=" + w; }
  function kv(k, v, cls) { return [el("span", { class: "k", text: k }), el("span", { class: "v" + (cls ? " " + cls : ""), text: v })]; }

  /* One sheet per step. Option A only ever shows "dates"; option B3 walks dates -> bag -> checkout -> done. */
  Widget.prototype.render = function () {
    if (!this.isOpen) return;
    var self = this, step = this.inPartnerCart() ? this.step : "dates";
    var part = step === "bag" ? this.bagStep() : step === "checkout" ? this.checkoutStep()
      : step === "done" ? this.doneStep() : this.datesStep();
    var sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "rc-title", tabindex: "-1" }, [
      this.head(step),
      el("div", { class: "body" }, [this.error ? el("div", { class: "err", role: "alert", text: this.error }) : null].concat(part.body)),
      el("div", { class: "foot" }, part.foot)
    ]);
    var scrim = el("div", { class: "scrim", onclick: function () { self.close(); } });
    var wasOpen = this.wrap.classList.contains("open");
    var focusedKey = this.root.activeElement && this.root.activeElement.getAttribute("data-k");
    var oldBody = this.root.querySelector(".body");
    var keepScroll = oldBody && this.renderedStep === step ? oldBody.scrollTop : 0;  // re-render in place, not a jump to the top
    this.wrap.innerHTML = "";
    this.wrap.appendChild(scrim);
    this.wrap.appendChild(sheet);
    this.renderedStep = step;
    if (keepScroll) sheet.querySelector(".body").scrollTop = keepScroll;
    var want = this.focusKey && this.root.querySelector("[data-k='" + this.focusKey + "']");
    this.focusKey = null;
    if (want) { want.focus(); return; }
    if (wasOpen) {
      var again = focusedKey && this.root.querySelector("[data-k='" + focusedKey + "']");
      (again && !again.disabled ? again : sheet).focus({ preventScroll: true });
    }
  };

  Widget.prototype.head = function (step) {
    var self = this, name = this.cfg.partner.name, steps = null, future = this.inPartnerCart();
    if (future && step !== "done") {
      var at = ["dates", "bag", "checkout"].indexOf(step);
      steps = el("ol", { class: "steps", "aria-label": "Steps" }, ["Dates", "Bag", "Checkout"].map(function (t, i) {
        return el("li", { class: i < at ? "past" : null, "aria-current": i === at ? "step" : null, text: t });
      }));
    }
    return el("div", { class: "head" }, [
      el("div", { class: "kicker" }, [name + " × Rêve", future ? el("span", { class: "future", text: "Future state" }) : null]),
      el("h2", { id: "rc-title" }, ["Rent it through ", el("em", { text: "RÊVE" })]),
      el("p", { class: "lede", text: "Rêve ships it to you, picks it up and has it cleaned. " +
        (future ? "You pay at " + name + "'s checkout with the rest of your order." : "You check out on rentwithreve.com.") }),
      steps,
      el("button", { class: "x", type: "button", "data-k": "x", "aria-label": "Close", onclick: function () { self.close(); } }, ["×"])
    ]);
  };

  Widget.prototype.totals = function () {
    var fees = this.product.fixed_fees, rent = this.current().period.price_cents;
    var sum = fees.reduce(function (a, f) { return a + f.price_cents; }, 0);
    return { rent: rent, fees: sum, free: fees.every(function (f) { return f.price_cents === 0; }), total: rent + sum };
  };

  Widget.prototype.costRows = function () {
    var t = this.totals();
    return [].concat(
      kv(this.current().period.label + " rental", formatMoney(t.rent)),
      kv(t.free ? "Shipping and cleaning" : "Fees", t.free ? "Included" : formatMoney(t.fees)),
      kv("Total", formatMoney(t.total), "tot"));
  };

  Widget.prototype.datesStep = function () {
    var self = this, p = this.product, cur = this.current(), u = cur.unit, per = cur.period;
    var tl = this.timelines[u.variant_id] || { loading: true };
    var starts = tl.occupancy ? bookableStarts(tl.occupancy, per.nights) : [];
    if (this.start && starts.indexOf(this.start) === -1) this.start = null;
    if (!this.month && starts.length) this.month = starts[0].slice(0, 7);

    // no free dates for this size and length: demand Rêve could not serve (once per size and length per page view)
    if (tl.occupancy && !starts.length) this.track("no_dates", { size: u.size, days: per.days }, "nd:" + u.variant_id + ":" + per.days);

    var sizeChips = p.units.map(function (unit, i) {
      return el("button", { class: "chip", type: "button", "data-k": "u" + i, "aria-pressed": String(i === self.unit),
        onclick: function () {
          self.track("size_pick", { size: unit.size });
          self.unit = i; self.start = null; self.month = null; self.loadTimeline(); self.render();
        } }, [unit.size]);
    });
    var sizeHint = !this.partnerSizeMatched
      ? el("p", { class: "hint", text: "Rêve has this piece in " + p.units.map(function (x) { return x.size; }).join(" and ") + "." })
      : null;
    var pieceNote = "Rêve's piece, size " + u.size;
    var lengthChips = u.periods.map(function (pp, i) {
      return el("button", { class: "chip", type: "button", "data-k": "p" + i, "aria-pressed": String(i === self.period),
        onclick: function () {
          self.track("length_pick", { days: pp.days, price_cents: pp.price_cents });
          self.period = i; self.render();
        } }, [pp.label, el("small", { text: formatMoney(pp.price_cents) })]);
    });

    var cal;
    if (tl.loading) cal = el("div", { class: "cal skel", text: "Checking Rêve's calendar…" });
    else if (tl.failed) cal = el("div", { class: "cal skel", text: "Couldn't load Rêve's calendar. Close and try again." });
    else if (!starts.length) cal = el("div", { class: "cal skel", text: "This size is booked for the next few months." });
    else cal = this.calendar(starts, per.nights);

    var summary = this.start ? el("div", { class: "sum sec" }, [].concat(
      kv("Arrives by", formatDay(this.start)), kv("Send it back", formatDay(addDays(this.start, per.nights))), this.costRows())) : null;

    var name = this.cfg.partner.name, go, fine;
    if (this.inPartnerCart()) {
      go = el("button", { class: "go", type: "button", "data-k": "go", disabled: !this.start, onclick: function () { self.addRental(); } },
        [this.rental ? "Update rental in bag" : "Add rental to bag"]);
      fine = "Goes into your " + name + " bag. You pay at " + name + "'s checkout with the rest of your order.";
    } else {
      go = el("button", { class: "go", type: "button", "data-k": "go", disabled: !this.start || this.busy, onclick: function () { self.checkout(); } },
        [this.busy ? "Opening Rêve checkout…" : "Continue to checkout", el("span", { "aria-hidden": "true", text: "↗" })]);
      fine = "Opens rentwithreve.com in a new tab. " + name + " gets credit for your rental.";
    }
    return {
      body: [
        el("div", { class: "piece" }, [
          p.image ? el("img", { src: thumb(p.image, 160), alt: "", loading: "lazy" }) : null,
          el("div", {}, [el("div", { class: "t", text: p.title }), el("div", { class: "s", text: pieceNote })])
        ]),
        el("div", { class: "sec" }, [el("div", { class: "lbl" }, [el("span", { text: "Size" })]), el("div", { class: "chips" }, sizeChips), sizeHint]),
        el("div", { class: "sec" }, [el("div", { class: "lbl" }, [el("span", { text: "How long" })]), el("div", { class: "chips" }, lengthChips)]),
        el("div", { class: "sec" }, [el("div", { class: "lbl" }, [el("span", { text: "Arrives by" }), el("span", { text: per.label })]), cal]),
        summary
      ],
      foot: [go, el("p", { class: "fine", text: fine })]
    };
  };

  // ---------------------------------------------------------------- option B3 future-state steps

  Widget.prototype.calendar = function (starts, nights) {
    var self = this, ok = {};
    starts.forEach(function (d) { ok[d] = true; });
    var first = starts[0].slice(0, 7), lastMonth = starts[starts.length - 1].slice(0, 7);
    var ym = this.month || first, y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    var end = this.start ? addDays(this.start, nights) : null;
    function shift(delta) {
      var d = new Date(Date.UTC(y, m + delta, 1));
      self.month = toIso(d.getTime()).slice(0, 7); self.render();
    }
    var cells = [];
    ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (d) { cells.push(el("div", { class: "dow", text: d })); });
    monthGrid(y, m).forEach(function (week) {
      week.forEach(function (iso) {
        if (!iso) { cells.push(el("div")); return; }
        var cls = ["day"];
        if (self.start && iso >= self.start && iso <= end) cls.push(iso === self.start ? "first" : iso === end ? "last" : "inrange");
        var day = +iso.slice(8);
        cells.push(el("button", { class: cls.join(" "), type: "button", "data-k": "d" + iso, disabled: !ok[iso],
          "aria-label": formatDay(iso) + (ok[iso] ? "" : ", unavailable"), "aria-pressed": String(iso === self.start),
          onclick: function () {
            self.track("date_pick", { start: iso, days: self.current().period.days, lead_days: Math.max(0, daysBetween(localTodayIso(), iso)) });
            self.start = iso; self.error = null; self.render();
          } }, [el("span", { text: String(day) })]));
      });
    });
    return el("div", { class: "cal" }, [
      el("div", { class: "calh" }, [
        el("button", { class: "nav", type: "button", "aria-label": "Previous month", "data-k": "prev", disabled: ym <= first, onclick: function () { shift(-1); } }, ["‹"]),
        el("b", { text: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m] + " " + y }),
        el("button", { class: "nav", type: "button", "aria-label": "Next month", "data-k": "next", disabled: ym >= lastMonth, onclick: function () { shift(1); } }, ["›"])
      ]),
      el("div", { class: "grid" }, cells),
      el("div", { class: "legend" }, [
        el("span", {}, [el("i", { style: "background:#2b2326" }), "Arrives"]),
        el("span", {}, [el("i", { style: "background:#98b3a6" }), "Send back"])
      ])
    ]);
  };

  Widget.prototype.checkout = function () {
    var self = this, cur = this.current(), cfg = this.cfg, start = this.start;
    if (!start || this.busy) return;
    var tab = window.open("", "_blank");
    if (tab) {
      try { tab.document.title = "Rêve checkout"; tab.document.body.innerHTML = "<p style='font:15px Georgia,serif;margin:40vh auto;text-align:center;color:#83545f'>Taking you to Rêve checkout…</p>"; } catch (e) { }
    }
    this.busy = true; this.error = null; this.render();
    var detail = { partner: cfg.partner.id, product: this.handle, reve_variant: cur.unit.variant_id, start: start, days: cur.period.days };
    var t0 = Date.now(), booking = { size: cur.unit.size, days: cur.period.days, start: start, price_cents: cur.period.price_cents };
    this.track("checkout_start", booking);
    emit("reve_connect_checkout_start", detail);

    function fail(msg, why) {
      if (tab) try { tab.close(); } catch (e) { }
      self.busy = false; self.error = msg; self.render();
      emit("reve_connect_error", Object.assign({ message: msg }, detail));
      self.track("error", { step: "checkout", message: String(why || "error").slice(0, 120), size: booking.size, days: booking.days });
    }
    fetch(this.reve(cfg.reve.proxy_path + "/intents"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(intentBody(cur.unit, cur.period, start))
    }).then(function (r) { if (!r.ok) throw new Error("intents HTTP " + r.status); return r.json(); })
      .then(function (intent) {
        if (!(intent.available_item_count >= 1)) {
          delete self.timelines[cur.unit.variant_id];
          self.start = null; self.loadTimeline();
          throw new Error("taken");
        }
        var opts = { intentAttributes: intent.attributes, unit: cur.unit, period: cur.period, startIso: start, partnerId: cfg.partner.id, partnerHandle: self.handle,
                     pv: self.tr && self.tr.on ? self.tr.pv : null };
        return self.createCart(opts).then(function (url) { return { url: url, opts: opts }; });
      })
      .then(function (res) {
        emit("reve_connect_checkout", detail);
        self.track("checkout", Object.assign({ ms: Math.min(Date.now() - t0, 600000), path: res.url ? "api" : "form" }, booking));
        self.busy = false; self.render();
        if (self.tr) self.tr.flush();          // the checkout tab takes the focus; the beacon goes now
        if (res.url) { if (tab) tab.location.href = res.url; else location.href = res.url; }
        else self.postCartForm(res.opts, tab);
      })
      .catch(function (e) {
        var why = (e && e.message) || "error";
        fail(why === "taken" ? "Those dates were just booked. Pick another arrival date." : "Couldn't reach Rêve checkout. Please try again.", why);
      });
  };


  /* -> checkoutUrl, or null when the Storefront API path is unavailable (caller falls back to the form). */
  Widget.prototype.createCart = function (opts) {
    var r = this.cfg.reve;
    return fetch(this.reve("/api/" + r.storefront_api_version + "/graphql.json"), {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: CART_CREATE, variables: { input: cartInput(opts) } })
    }).then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        var c = body && body.data && body.data.cartCreate;
        if (!c || !c.cart || (c.userErrors && c.userErrors.length)) return null;
        return c.cart.checkoutUrl;
      }).catch(function () { return null; });
  };

  Widget.prototype.postCartForm = function (opts, tab) {
    var name = "reve_checkout_" + Date.now();
    if (tab) tab.name = name;
    var form = el("form", { method: "POST", action: this.reve("/cart/add"), target: tab ? name : "_self", style: "display:none" });
    var fields = cartFormFields(opts);
    Object.keys(fields).forEach(function (k) { form.appendChild(el("input", { type: "hidden", name: k, value: fields[k] })); });
    document.body.appendChild(form);
    form.submit();
    setTimeout(function () { form.remove(); }, 1000);
  };

  function placeholderHandle() {
    var n = document.querySelector("[data-reve-connect][data-product-handle]");
    return n ? (n.getAttribute("data-product-handle") || "").toLowerCase() : "";
  }

  function boot(script) {
    if (!script || typeof fetch !== "function") return;
    var partner = script.getAttribute("data-partner");
    if (!partner) return;
    var fixed = (script.getAttribute("data-product-handle") || "").toLowerCase();
    var url = script.getAttribute("data-config") || new URL("partners/" + partner + ".json", script.src).href;
    var loading = null, live = null;
    // the config once per page view, however often the product changes
    function config() {
      if (!loading) {
        loading = fetch(url).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (cfg) { return validConfig(cfg) ? cfg : null; });
        loading.catch(function () { loading = null; });       // a failed fetch is tried again on the next page
      }
      return loading;
    }
    function handleNow() { return fixed || placeholderHandle() || productHandleFromPath(location.pathname); }
    /* The partner's own product data: Shopify's /products/<handle>.js, or on Salesforce the page's JSON-LD price. */
    function partnerFacts(cfg, handle) {
      if (cfg.partner.platform === "sfcc") {
        var buy = jsonLdPriceCents([].map.call(document.querySelectorAll('script[type="application/ld+json"]'),
          function (n) { return n.textContent; }), handle);
        return Promise.resolve({ buy: buy || null, compare: null, variants: {} });
      }
      return fetch("/products/" + handle + ".js").then(function (r) { return r.ok ? r.json() : null; })
        .then(productFacts, function () { return productFacts(null); });
    }
    function start() {
      var handle = handleNow();
      if (live && live.handle === handle && (!live.w || live.w.attached())) return;  // loading, nothing to show, or shown
      if (live) {
        live.dead = true;
        if (live.w) live.w.destroy();
        if (live.unwatch) live.unwatch();
        if (live.tr) live.tr.end();
      }
      live = null;
      if (!handle) return;
      var mine = live = { handle: handle, w: null, dead: false, tr: null, unwatch: null };
      var loaded = null;
      config().then(function (cfg) {
        if (!cfg || mine.dead) return null;
        loaded = cfg;
        var tr = mine.tr = new Tracker(cfg, handle);
        var product = cfg.products[handle];
        if (!product) { tr.track("pdp_view", { state: "not_stocked" }); return null; }
        return partnerFacts(cfg, handle).then(function (facts) {
          if (mine.dead) return null;
          mine.facts = facts;
          var view = mine.view = { buy_cents: facts.buy, compare_cents: facts.compare, from_cents: fromPrice(product) };
          var cohort = holdoutCohort(cfg);
          if (cohort) view.cohort = cohort;
          // no button on this page: the view still counts, and so do their Add to cart presses (the holdout's
          // comparison, and buy-vs-rent on deep-sale pages)
          function noButton(state) {
            tr.track("pdp_view", Object.assign({ state: state }, view));
            mine.unwatch = watchBuys(cfg, tr, facts, findForm(cfg));
            return null;
          }
          if (cohort === "holdout") {
            emit("reve_connect_holdout", { partner: cfg.partner.id, product: handle });
            return noButton("holdout");
          }
          if (!worthRenting(facts.buy, fromPrice(product), cfg.partner.min_buy_to_rent)) {
            emit("reve_connect_suppressed", { partner: cfg.partner.id, product: handle, buy_cents: facts.buy || 0 });
            return noButton("suppressed");
          }
          return product;
        });
      }).then(function (product) {
        if (!product || mine.dead) return;
        var cfg = loaded;
        var form = findForm(cfg);
        if (!form && !placeholdersFor(handle).length) {
          mine.tr.track("pdp_view", Object.assign({ state: "no_form" }, mine.view));
          return;
        }
        var w = new Widget(cfg, handle, product, form);
        mine.w = w;
        w.tr = mine.tr; w.facts = mine.facts;
        w.syncUnitFromPage();
        mine.tr.track("pdp_view", Object.assign({ state: "shown" }, mine.view));
        w.mountButton();
        mine.unwatch = watchBuys(cfg, mine.tr, mine.facts, form);
        if (form) w.syncTimer = setInterval(function () { if (!w.wrap || !w.wrap.classList.contains("open")) w.syncUnitFromPage(); }, 600);
        window.ReveConnect.instance = w;
      }).catch(function () { /* never break the partner page */ });
    }
    /* A storefront that renders pages in the browser (PWA Kit) draws the product page's placeholder after load
     * and swaps it, or its product, on every move to another product. The button follows. A page whose product
     * is in its address or in the script tag never needs this. */
    function watch() {
      if (fixed || productHandleFromPath(location.pathname) || typeof MutationObserver !== "function") return;
      var queued = false;
      new MutationObserver(function () {
        if (queued) return;
        queued = true;
        setTimeout(function () { queued = false; start(); }, 60);
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-product-handle"] });
    }
    function go() { start(); watch(); }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
    else go();
  }

  return {
    VERSION: VERSION, SCHEMA: SCHEMA, CART_CREATE: CART_CREATE,
    productHandleFromPath: productHandleFromPath, addDays: addDays, isBookable: isBookable,
    splitSelectors: splitSelectors, findAnchor: findAnchor, jsonLdPriceCents: jsonLdPriceCents,
    bookableStarts: bookableStarts, monthGrid: monthGrid, unitForPartnerVariant: unitForPartnerVariant,
    fromPrice: fromPrice, buttonNote: buttonNote, formatMoney: formatMoney, formatDay: formatDay, formatPropDate: formatPropDate,
    intentBody: intentBody, splitIntent: splitIntent, cartInput: cartInput, cartFormFields: cartFormFields,
    bucket: bucket, worthRenting: worthRenting, validConfig: validConfig, boot: boot,
    pageViewId: pageViewId, deviceOf: deviceOf, productFacts: productFacts, sizeLabel: sizeLabel, batchBody: batchBody, gaIds: gaIds,
    daysBetween: daysBetween, Tracker: Tracker, watchBuys: watchBuys, analyticsChoice: analyticsChoice, fitPadding: fitPadding,
  };
});
