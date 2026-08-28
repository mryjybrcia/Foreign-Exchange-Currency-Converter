/* =========================================================================
   FX Checker
   Rates: Frankfurter API (https://frankfurter.dev) — ECB end-of-day reference
   rates. No API key required.
   ========================================================================= */
(function () {
  "use strict";

  /* ------------------------------ Config ------------------------------- */

  var API = "https://api.frankfurter.dev/v1";
  var API_FALLBACK = "https://api.frankfurter.app/v1";   /* legacy mirror */

  var POPULAR = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "CNY"];

  var TICKER_PAIRS = [
    ["EUR", "USD"], ["USD", "JPY"], ["GBP", "USD"], ["USD", "CHF"],
    ["EUR", "GBP"], ["AUD", "USD"], ["USD", "CAD"], ["NZD", "USD"],
    ["USD", "CNY"], ["USD", "SGD"], ["USD", "INR"], ["USD", "MXN"]
  ];

  /* Flags live in assets/images/flags and are named by the ISO 3166 country
     code, which is the first two letters of the ISO 4217 currency code for
     every file in the folder bar one. Deriving the name instead of hardcoding
     a table means the folder stays the source of truth: drop in a new flag
     (say il.webp) and that currency picks it up with no code change. Anything
     the folder does not have falls back to a monogram disc via onerror. */
  var FLAG_OVERRIDES = { XCD: "lc" };   /* East Caribbean dollar -> St Lucia */

  var RANGE_DAYS = { "1d": 5, "1w": 9, "1m": 32, "3m": 95, "1y": 370, "5y": 1830 };

  var STORE = { fav: "fxchecker.favorites", log: "fxchecker.log", pair: "fxchecker.pair" };

  /* Chart geometry, straight from the design (996 × 298 plot area). */
  var CHART = { labelW: 36, labelGap: 16, plotH: 272, axisGap: 16, axisH: 10 };

  /* ------------------------------- State -------------------------------- */

  var state = {
    currencies: {},        /* code -> name                                   */
    rates: {},             /* code -> value per 1 EUR (EUR === 1)            */
    prevRates: {},         /* previous close, same shape                     */
    asOf: "",
    from: "USD",
    to: "EUR",
    amount: 1000,
    range: "1m",
    tab: "history",
    favorites: [],
    log: [],
    series: null,
    pickerSide: null
  };

  var seriesCache = {};

  /* ------------------------------ Helpers ------------------------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /* Icons come from the inline sprite in index.html, so they cannot 404 and
     they take their colour from the CSS `color` of whatever contains them. */
  function icon(nameId, cls) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (cls) svg.setAttribute("class", cls);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-" + nameId);
    svg.appendChild(use);
    return svg;
  }

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) { return fallback; }
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* quota / private mode */ }
  }

  function isoDaysAgo(days) {
    var d = new Date();
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  }

  /* Decimals follow the magnitude of the quote: 157.91 but 0.8530. */
  function rateDecimals(value) { return Math.abs(value) >= 100 ? 2 : 4; }

  function fmtRate(value) {
    if (!isFinite(value)) return "—";
    return value.toLocaleString("en-US", {
      minimumFractionDigits: rateDecimals(value),
      maximumFractionDigits: rateDecimals(value)
    });
  }

  function fmtMoney(value) {
    if (!isFinite(value)) return "—";
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtSigned(value, decimals) {
    var sign = value > 0 ? "+" : value < 0 ? "−" : "";
    return sign + Math.abs(value).toLocaleString("en-US", {
      minimumFractionDigits: decimals, maximumFractionDigits: decimals
    });
  }

  function fmtPct(value) {
    var arrow = value > 0 ? "▲ " : value < 0 ? "▼ " : "";
    return arrow + fmtSigned(value, 2) + "%";
  }

  function trendClass(value) {
    return value > 0 ? "is-up" : value < 0 ? "is-down" : "is-flat";
  }

  function groupDigits(digits) {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function parseAmount(text) {
    var cleaned = String(text).replace(/[^0-9.]/g, "");
    var parts = cleaned.split(".");
    if (parts.length > 2) cleaned = parts[0] + "." + parts.slice(1).join("");
    var value = parseFloat(cleaned);
    return isFinite(value) ? value : NaN;
  }

  function formatAmountInput(text) {
    var cleaned = String(text).replace(/[^0-9.]/g, "");
    var parts = cleaned.split(".");
    var whole = groupDigits(parts[0] || "");
    if (parts.length < 2) return whole;
    return whole + "." + parts.slice(1).join("").slice(0, 4);
  }

  function relativeTime(ts) {
    var mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return mins + "m";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h";
    var d = new Date(ts);
    return d.getDate() + " " + d.toLocaleString("en-US", { month: "short" });
  }

  function flagSrc(code) {
    var file = FLAG_OVERRIDES[code] || code.slice(0, 2).toLowerCase();
    return "./assets/images/flags/" + file + ".webp";
  }

  /* Stand-in for a currency the flags folder has no file for. */
  function monogramSrc(code) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
      '<circle cx="10" cy="10" r="10" fill="#283300"/>' +
      '<text x="10" y="13.5" text-anchor="middle" font-family="monospace" ' +
      'font-size="8" font-weight="700" fill="#cef739">' + code.slice(0, 2) + "</text></svg>";
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function useFlag(imgEl, code) {
    imgEl.alt = "";
    imgEl.onerror = function () {
      this.onerror = null;              /* the data URI can't fail — stop here */
      this.src = monogramSrc(code);
    };
    imgEl.src = flagSrc(code);
  }

  function flagImg(code, cls, size) {
    var node = document.createElement("img");
    if (cls) node.className = cls;
    node.width = size || 20;
    node.height = size || 20;
    node.loading = "lazy";
    useFlag(node, code);
    return node;
  }

  function name(code) { return state.currencies[code] || code; }

  /* Cross rate a -> b, derived from the EUR-based table. */
  function rate(a, b, table) {
    var t = table || state.rates;
    if (!t[a] || !t[b]) return NaN;
    return t[b] / t[a];
  }

  function pairKey(a, b) { return a + "/" + b; }

  /* ------------------------------ Elements ------------------------------ */

  var dom = {
    count: $("#currency-count"),
    tickerTrack: $("#ticker-track"),
    amountInput: $("#send-amount"),
    receive: $("#receive-amount"),
    fromBtn: $("#from-btn"), fromFlag: $("#from-flag"), fromCode: $("#from-code"),
    toBtn: $("#to-btn"), toFlag: $("#to-flag"), toCode: $("#to-code"),
    swap: $("#swap-btn"),
    rateLine: $("#rate-line"),
    favToggle: $("#fav-toggle"), favLabel: $("#fav-label"),
    logBtn: $("#log-btn"),
    picker: $("#picker"), pickerSearch: $("#picker-search"),
    pickerBody: $("#picker-body"), pickerEmpty: $("#picker-empty"),
    mtabsToggle: $("#mtabs-toggle"), mtabsMenu: $("#mtabs-menu"),
    mtabsLabel: $("#mtabs-label"), mtabsBadge: $("#mtabs-badge"),
    favCount: $("#fav-count"), logCount: $("#log-count"),
    statOpen: $("#stat-open"), statLast: $("#stat-last"),
    statChange: $("#stat-change"), statPct: $("#stat-pct"),
    chart: $("#chart"), chartPair: $("#chart-pair"), chartMeta: $("#chart-meta"),
    chartCard: $("#chart-card"), chartSummary: $("#chart-summary"),
    historyEmpty: $("#history-empty"), historyEmptyPair: $("#history-empty-pair"),
    compareCard: $("#compare-card"), compareList: $("#compare-list"),
    compareSub: $("#compare-sub"), compareCount: $("#compare-count"),
    compareEmpty: $("#compare-empty"),
    favCard: $("#favorites-card"), favList: $("#favorites-list"),
    favTotal: $("#favorites-count"), favEmpty: $("#favorites-empty"),
    logCard: $("#log-card"), logList: $("#log-list"), logTotal: $("#log-total"),
    logEmpty: $("#log-empty"), clearLog: $("#clear-log"),
    toast: $("#toast")
  };

  /* ------------------------------- Toast -------------------------------- */

  var toastTimer;
  function toast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.hidden = true; }, 2400);
  }

  /* -------------------------------- Data -------------------------------- */

  function fetchJSON(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  /* If the primary host is unreachable, retry once against the legacy mirror. */
  function getJSON(url) {
    return fetchJSON(url).catch(function (err) {
      if (url.indexOf(API) !== 0) throw err;
      return fetchJSON(API_FALLBACK + url.slice(API.length));
    });
  }

  function loadCurrencies() {
    return getJSON(API + "/currencies").then(function (data) {
      state.currencies = data;
      dom.count.textContent = Object.keys(data).length;
    });
  }

  /* One time-series call covers today's close and the previous one, for every
     currency at once — that powers the converter, the ticker and the lists. */
  function loadRates() {
    return getJSON(API + "/" + isoDaysAgo(10) + "..").then(function (data) {
      var dates = Object.keys(data.rates).sort();
      if (!dates.length) throw new Error("empty series");

      var last = data.rates[dates[dates.length - 1]];
      var prev = dates.length > 1 ? data.rates[dates[dates.length - 2]] : last;

      state.rates = Object.assign({ EUR: 1 }, last);
      state.prevRates = Object.assign({ EUR: 1 }, prev);
      state.asOf = dates[dates.length - 1];
    });
  }

  function loadSeries(from, to, range) {
    var key = from + to + range;
    if (seriesCache[key]) return Promise.resolve(seriesCache[key]);

    var url = API + "/" + isoDaysAgo(RANGE_DAYS[range]) + "..?base=" + from + "&symbols=" + to;

    return getJSON(url).then(function (data) {
      var dates = Object.keys(data.rates).sort();
      var series = {
        dates: dates,
        values: dates.map(function (d) { return data.rates[d][to]; })
      };
      if (series.values.length < 2) throw new Error("not enough points");
      seriesCache[key] = series;
      return series;
    });
  }

  /* ------------------------------ Converter ----------------------------- */

  function renderConverter() {
    var r = rate(state.from, state.to);

    dom.fromCode.textContent = state.from;
    dom.toCode.textContent = state.to;
    useFlag(dom.fromFlag, state.from);
    useFlag(dom.toFlag, state.to);

    dom.fromBtn.setAttribute("aria-label", "Send currency: " + name(state.from) + ". Change currency");
    dom.toBtn.setAttribute("aria-label", "Receive currency: " + name(state.to) + ". Change currency");

    var pinned = state.favorites.indexOf(pairKey(state.from, state.to)) !== -1;
    dom.favToggle.setAttribute("aria-pressed", String(pinned));
    dom.favLabel.textContent = pinned ? "Favorited" : "Favorite";

    if (!isFinite(r)) {
      dom.receive.textContent = "—";
      return;
    }

    dom.receive.textContent = isFinite(state.amount) ? fmtMoney(state.amount * r) : "—";
    dom.rateLine.classList.remove("is-error");
    dom.rateLine.textContent = "1 " + state.from + " = " + fmtRate(r) + " " + state.to;
  }

  /* ------------------------------- Ticker ------------------------------- */

  function renderTicker() {
    var items = TICKER_PAIRS.filter(function (p) {
      return state.rates[p[0]] && state.rates[p[1]];
    });
    if (!items.length) return;

    var frag = document.createDocumentFragment();

    /* The track is duplicated so the -50% scroll loops seamlessly. */
    for (var pass = 0; pass < 2; pass++) {
      items.forEach(function (p) {
        var now = rate(p[0], p[1]);
        var before = rate(p[0], p[1], state.prevRates);
        var delta = isFinite(before) && before ? ((now - before) / before) * 100 : 0;

        var item = el("p", "ticker__item");
        if (pass === 1) item.setAttribute("aria-hidden", "true");
        item.appendChild(el("span", "ticker__pair", p[0] + "/" + p[1]));
        item.appendChild(el("span", "ticker__rate", fmtRate(now)));
        item.appendChild(el("span", "ticker__delta " + trendClass(delta), fmtPct(delta)));
        frag.appendChild(item);
      });
    }

    dom.tickerTrack.textContent = "";
    dom.tickerTrack.appendChild(frag);
  }

  /* --------------------------- Currency picker -------------------------- */

  function buildOption(code, selected) {
    var li = document.createElement("li");
    var btn = el("button", "picker__option");
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(selected));
    btn.dataset.code = code;

    btn.appendChild(flagImg(code, "flag", 20));
    btn.appendChild(el("span", "code", code));
    btn.appendChild(el("span", "name", name(code)));
    btn.appendChild(icon("check", "check"));

    li.appendChild(btn);
    return li;
  }

  function renderPicker(query) {
    var q = (query || "").trim().toLowerCase();
    var current = state.pickerSide === "from" ? state.from : state.to;
    var codes = Object.keys(state.currencies).sort();

    var matches = codes.filter(function (code) {
      return !q || code.toLowerCase().indexOf(q) === 0 ||
             name(code).toLowerCase().indexOf(q) !== -1;
    });

    var groups = {
      /* Popular keeps the curated order; everything else stays alphabetical. */
      popular: POPULAR.filter(function (c) { return matches.indexOf(c) !== -1; }),
      other: matches.filter(function (c) { return POPULAR.indexOf(c) === -1; })
    };

    ["popular", "other"].forEach(function (key) {
      var list = $('[data-list="' + key + '"]', dom.picker);
      var section = $('[data-group="' + key + '"]', dom.picker);
      var counter = $('[data-count="' + key + '"]', dom.picker);

      list.textContent = "";
      groups[key].forEach(function (code) {
        list.appendChild(buildOption(code, code === current));
      });
      counter.textContent = groups[key].length;
      section.hidden = groups[key].length === 0;
    });

    dom.pickerEmpty.hidden = matches.length > 0;
  }

  function positionPicker(anchor) {
    var box = anchor.getBoundingClientRect();
    var width = dom.picker.offsetWidth;
    var left = box.left + window.scrollX + box.width - width;
    var minLeft = window.scrollX + 12;
    var maxLeft = window.scrollX + document.documentElement.clientWidth - width - 12;

    dom.picker.style.top = (box.bottom + window.scrollY + 8) + "px";
    dom.picker.style.left = Math.max(minLeft, Math.min(left, maxLeft)) + "px";
  }

  function openPicker(side) {
    state.pickerSide = side;
    dom.picker.hidden = false;
    dom.pickerSearch.value = "";
    renderPicker("");
    positionPicker(side === "from" ? dom.fromBtn : dom.toBtn);
    (side === "from" ? dom.fromBtn : dom.toBtn).setAttribute("aria-expanded", "true");
    dom.pickerSearch.focus();
  }

  function closePicker(restoreFocus) {
    if (dom.picker.hidden) return;
    var anchor = state.pickerSide === "from" ? dom.fromBtn : dom.toBtn;
    dom.picker.hidden = true;
    dom.fromBtn.setAttribute("aria-expanded", "false");
    dom.toBtn.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor) anchor.focus();
    state.pickerSide = null;
  }

  function pickCurrency(code) {
    var side = state.pickerSide;
    if (side === "from") {
      if (code === state.to) state.to = state.from;
      state.from = code;
    } else {
      if (code === state.from) state.from = state.to;
      state.to = code;
    }
    closePicker(true);
    write(STORE.pair, [state.from, state.to]);
    refreshAll();
  }

  /* -------------------------------- Chart ------------------------------- */

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function shortDate(iso) {
    var d = new Date(iso + "T00:00:00Z");
    return d.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
  }

  function drawChart() {
    var series = state.series;
    dom.chart.textContent = "";
    if (!series || series.values.length < 2) return;

    var width = dom.chart.clientWidth || 996;
    var height = dom.chart.clientHeight || 298;
    var narrow = width < 480;

    var gutter = CHART.labelW + CHART.labelGap;
    var axisBand = CHART.axisGap + CHART.axisH;
    var plotH = Math.max(80, height - axisBand);
    var plotW = Math.max(10, width - gutter);

    var values = series.values;
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var span = (max - min) || (max * 0.001) || 1;
    var lo = min - span * 0.12;
    var hi = max + span * 0.12;

    function x(i) { return gutter + (i / (values.length - 1)) * plotW; }
    function y(v) { return plotH - ((v - lo) / (hi - lo)) * plotH; }

    var svg = svgEl("svg", {
      viewBox: "0 0 " + width + " " + height,
      width: width, height: height, role: "img"
    });

    var defs = svgEl("defs");
    var grad = svgEl("linearGradient", { id: "chart-gradient", x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.appendChild(svgEl("stop", { offset: "0%", "stop-color": "#cef739", "stop-opacity": "0.6" }));
    grad.appendChild(svgEl("stop", { offset: "100%", "stop-color": "#cef739", "stop-opacity": "0" }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    /* Three gridlines with a value label in the left gutter: high / mid / low.
       Inset by half a label so the top and bottom labels are not clipped. */
    var inset = 8;
    [1, 0.5, 0].forEach(function (t, idx) {
      var gy = idx === 0 ? inset : idx === 2 ? plotH - inset : plotH / 2;
      svg.appendChild(svgEl("line", {
        class: "chart__grid", x1: gutter, x2: width, y1: gy, y2: gy
      }));
      var label = svgEl("text", {
        class: "chart__label",
        x: gutter - CHART.labelGap,
        y: gy,
        "text-anchor": "end",
        "dominant-baseline": "middle"
      });
      label.textContent = fmtRate(lo + (hi - lo) * t);
      svg.appendChild(label);
    });

    var line = values.map(function (v, i) { return (i ? "L" : "M") + x(i) + " " + y(v); }).join(" ");
    svg.appendChild(svgEl("path", {
      class: "chart__area",
      d: line + " L" + width + " " + plotH + " L" + gutter + " " + plotH + " Z"
    }));
    svg.appendChild(svgEl("path", { class: "chart__line", d: line }));

    /* Evenly spaced date labels below the plot — 5 on desktop, 3 when narrow. */
    var ticks = narrow ? 3 : 5;
    var last = values.length - 1;
    for (var t = 0; t < ticks; t++) {
      var i = Math.round((t / (ticks - 1)) * last);
      var anchor = t === 0 ? "start" : t === ticks - 1 ? "end" : "middle";
      var xl = svgEl("text", {
        class: "chart__label",
        x: t === 0 ? gutter : t === ticks - 1 ? width : x(i),
        y: height - 1,
        "text-anchor": anchor
      });
      xl.textContent = shortDate(series.dates[i]);
      svg.appendChild(xl);
    }

    var cross = svgEl("line", { class: "chart__cross", y1: 0, y2: plotH, x1: 0, x2: 0 });
    var dot = svgEl("circle", { class: "chart__dot", r: 4, cx: 0, cy: 0 });
    cross.style.opacity = "0";
    dot.style.opacity = "0";
    svg.appendChild(cross);
    svg.appendChild(dot);

    dom.chart.appendChild(svg);

    var tip = el("div", "chart__tooltip");
    dom.chart.appendChild(tip);

    dom.chart.addEventListener("pointermove", function (event) {
      var box = dom.chart.getBoundingClientRect();
      var px = event.clientX - box.left - gutter;
      var i = Math.round((px / plotW) * last);
      i = Math.max(0, Math.min(last, i));

      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(values[i]));
      cross.style.opacity = "1"; dot.style.opacity = "1";

      tip.textContent = shortDate(series.dates[i]) + "  ";
      tip.appendChild(el("b", null, fmtRate(values[i])));
      tip.style.left = Math.max(48, Math.min(box.width - 48, x(i))) + "px";
      tip.classList.add("is-on");
    });

    dom.chart.addEventListener("pointerleave", function () {
      cross.style.opacity = "0"; dot.style.opacity = "0";
      tip.classList.remove("is-on");
    });
  }

  function renderHistoryStats() {
    var series = state.series;
    if (!series) return;

    var open = series.values[0];
    var last = series.values[series.values.length - 1];
    var change = last - open;
    var pct = open ? (change / open) * 100 : 0;
    var decimals = rateDecimals(last);

    dom.statOpen.textContent = fmtRate(open);
    dom.statLast.textContent = fmtRate(last);

    dom.statChange.textContent = fmtSigned(change, decimals);
    dom.statChange.className = "stat__value " + trendClass(change);

    dom.statPct.textContent = fmtPct(pct);
    dom.statPct.className = "stat__value " + trendClass(pct);

    dom.chartPair.textContent = state.from + "/" + state.to;
    dom.chartMeta.textContent = fmtRate(last) + " · " +
      shortDate(series.dates[series.dates.length - 1]) + " 16:00 CET";
    dom.chartSummary.textContent =
      state.from + " to " + state.to + " over " + state.range + ": opened at " + fmtRate(open) +
      ", last " + fmtRate(last) + ", " + fmtPct(pct) + ".";
  }

  function renderHistory() {
    dom.chart.classList.add("is-loading");
    dom.historyEmpty.hidden = true;
    dom.chartCard.hidden = false;
    $("#stats-bar").hidden = false;
    dom.chartPair.textContent = state.from + "/" + state.to;

    var from = state.from, to = state.to, range = state.range;

    loadSeries(from, to, range).then(function (series) {
      if (from !== state.from || to !== state.to || range !== state.range) return;
      state.series = series;
      dom.chart.classList.remove("is-loading");
      renderHistoryStats();
      drawChart();
    }).catch(function () {
      if (from !== state.from || to !== state.to || range !== state.range) return;
      state.series = null;
      dom.chart.classList.remove("is-loading");
      dom.chart.textContent = "";
      dom.chartCard.hidden = true;
      $("#stats-bar").hidden = true;
      dom.historyEmptyPair.textContent = from + "/" + to;
      dom.historyEmpty.hidden = false;
    });
  }

  /* ------------------------------ Row parts ----------------------------- */

  function starButton(key, pinned) {
    var btn = el("button", "icon-btn");
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(pinned));
    btn.setAttribute("aria-label", (pinned ? "Unpin " : "Pin ") + key.replace("/", " to "));
    btn.dataset.pair = key;
    btn.appendChild(icon(pinned ? "star-filled" : "star", "icon"));
    return btn;
  }

  function numBlock(value, sub, subClass) {
    var box = el("div", "row__num");
    box.appendChild(el("span", "row__value", value));
    box.appendChild(el("span", "row__sub " + (subClass || ""), sub));
    return box;
  }

  /* ------------------------------- Compare ------------------------------ */

  function compareTargets() {
    var seen = {};
    var list = [];

    POPULAR.concat(state.favorites.map(function (p) { return p.split("/")[1]; }))
      .forEach(function (code) {
        if (code === state.from || seen[code] || !state.rates[code]) return;
        seen[code] = true;
        list.push(code);
      });

    return list.slice(0, 10);
  }

  function renderCompare() {
    var targets = compareTargets();
    var valid = isFinite(state.amount) && state.amount > 0 && targets.length > 0;

    dom.compareCard.hidden = !valid;
    dom.compareEmpty.hidden = valid;
    if (!valid) return;

    dom.compareSub.textContent =
      fmtMoney(state.amount).replace(/\.00$/, "") + " from " + state.from;
    dom.compareCount.textContent = targets.length + (targets.length === 1 ? " pair" : " pairs");

    dom.compareList.textContent = "";
    targets.forEach(function (code) {
      var r = rate(state.from, code);
      var key = pairKey(state.from, code);

      var li = el("li", "row");
      li.appendChild(flagImg(code, "row__flag", 24));

      var id = el("div", "row__id");
      id.appendChild(el("span", "row__code", code));
      id.appendChild(el("span", "row__name", name(code)));
      li.appendChild(id);

      li.appendChild(numBlock(fmtMoney(state.amount * r), "@ " + fmtRate(r)));
      li.appendChild(starButton(key, state.favorites.indexOf(key) !== -1));
      dom.compareList.appendChild(li);
    });
  }

  /* ------------------------------ Favorites ----------------------------- */

  function renderFavorites() {
    var list = state.favorites.filter(function (key) {
      var p = key.split("/");
      return state.rates[p[0]] && state.rates[p[1]];
    });

    dom.favCount.textContent = state.favorites.length;
    $('[data-badge="favorites"]').textContent = state.favorites.length;
    dom.favTotal.textContent = state.favorites.length +
      (state.favorites.length === 1 ? " favorite" : " favorites");
    syncMobileTab();

    var has = list.length > 0;
    dom.favCard.hidden = !has;
    dom.favEmpty.hidden = has;
    if (!has) return;

    dom.favList.textContent = "";
    list.forEach(function (key) {
      var p = key.split("/");
      var now = rate(p[0], p[1]);
      var before = rate(p[0], p[1], state.prevRates);
      var pct = isFinite(before) && before ? ((now - before) / before) * 100 : 0;

      var li = el("li", "row");

      var pairBtn = el("button", "row__pair");
      pairBtn.type = "button";
      pairBtn.dataset.setPair = key;
      pairBtn.setAttribute("aria-label", "Show " + p[0] + " to " + p[1] + " in the converter");
      pairBtn.appendChild(el("span", null, p[0]));
      pairBtn.appendChild(icon("arrow-right", "row__arrow"));
      pairBtn.appendChild(el("span", null, p[1]));
      li.appendChild(pairBtn);

      li.appendChild(numBlock(fmtRate(now), fmtPct(pct), trendClass(pct)));
      li.appendChild(starButton(key, true));
      dom.favList.appendChild(li);
    });
  }

  function toggleFavorite(key) {
    var i = state.favorites.indexOf(key);
    if (i === -1) {
      state.favorites.push(key);
      toast("Pinned " + key.replace("/", " → "));
    } else {
      state.favorites.splice(i, 1);
      toast("Unpinned " + key.replace("/", " → "));
    }
    write(STORE.fav, state.favorites);
    renderConverter();
    renderFavorites();
    renderCompare();
  }

  /* --------------------------------- Log -------------------------------- */

  function renderLog() {
    dom.logCount.textContent = state.log.length;
    $('[data-badge="log"]').textContent = state.log.length;
    dom.logTotal.textContent = state.log.length + " logged";
    syncMobileTab();

    var has = state.log.length > 0;
    dom.logCard.hidden = !has;
    dom.logEmpty.hidden = has;
    if (!has) return;

    dom.logList.textContent = "";
    state.log.forEach(function (entry) {
      var li = el("li", "row row--log");
      li.appendChild(el("span", "row__time", relativeTime(entry.ts)));

      var pair = el("span", "row__pair");
      pair.appendChild(el("span", null, entry.from));
      pair.appendChild(icon("arrow-right", "row__arrow"));
      pair.appendChild(el("span", null, entry.to));
      li.appendChild(pair);

      var amounts = el("div", "row__amounts");
      amounts.appendChild(el("span", "out", fmtMoney(entry.amount)));
      amounts.appendChild(el("span", "in", fmtMoney(entry.result)));
      li.appendChild(amounts);

      var del = el("button", "icon-btn icon-btn--delete");
      del.type = "button";
      del.dataset.remove = entry.id;
      del.setAttribute("aria-label",
        "Delete the logged conversion of " + fmtMoney(entry.amount) + " " + entry.from +
        " to " + entry.to);
      /* Outline icon by default, filled on hover/focus — CSS swaps them. */
      del.appendChild(icon("delete", "icon icon-btn__icon--off"));
      del.appendChild(icon("delete-filled", "icon icon-btn__icon--on"));
      li.appendChild(del);

      dom.logList.appendChild(li);
    });
  }

  function addLogEntry() {
    var r = rate(state.from, state.to);
    if (!isFinite(r) || !isFinite(state.amount) || state.amount <= 0) {
      toast("Enter an amount first");
      return;
    }
    state.log.unshift({
      id: String(Date.now()) + Math.random().toString(16).slice(2, 6),
      ts: Date.now(),
      from: state.from,
      to: state.to,
      amount: state.amount,
      result: state.amount * r,
      rate: r
    });
    state.log = state.log.slice(0, 50);
    write(STORE.log, state.log);
    renderLog();
    toast("Conversion logged");
  }

  /* -------------------------------- Tabs -------------------------------- */

  function syncMobileTab() {
    var source = $("#tab-" + state.tab);
    if (!source) return;
    dom.mtabsLabel.textContent = $(".tab__label", source).textContent;
    var badge = $(".badge", source);
    dom.mtabsBadge.hidden = !badge;
    if (badge) dom.mtabsBadge.textContent = badge.textContent;
  }

  function selectTab(id) {
    state.tab = id;

    $$(".tab").forEach(function (tab) {
      var active = tab.id === "tab-" + id;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    $$(".panel").forEach(function (panel) {
      panel.hidden = panel.id !== "panel-" + id;
    });
    $$(".mtabs__item").forEach(function (item) {
      item.setAttribute("aria-selected", String(item.dataset.tab === id));
    });

    syncMobileTab();
    closeMobileMenu();
    if (id === "history" && state.series) drawChart();
  }

  function openMobileMenu() {
    dom.mtabsMenu.hidden = false;
    dom.mtabsToggle.setAttribute("aria-expanded", "true");
  }

  function closeMobileMenu() {
    if (dom.mtabsMenu.hidden) return;
    dom.mtabsMenu.hidden = true;
    dom.mtabsToggle.setAttribute("aria-expanded", "false");
  }

  /* ------------------------------- Refresh ------------------------------ */

  function refreshAll() {
    renderConverter();
    renderHistory();
    renderCompare();
    renderFavorites();
    renderLog();
  }

  /* ------------------------------- Events ------------------------------- */

  function bindEvents() {
    dom.amountInput.addEventListener("input", function () {
      var caretAtEnd = this.selectionStart === this.value.length;
      var formatted = formatAmountInput(this.value);
      this.value = formatted;
      if (caretAtEnd) this.setSelectionRange(formatted.length, formatted.length);

      state.amount = parseAmount(formatted);
      renderConverter();
      renderCompare();
    });

    dom.amountInput.addEventListener("blur", function () {
      if (!isFinite(state.amount)) return;
      this.value = formatAmountInput(String(state.amount));
    });

    dom.fromBtn.addEventListener("click", function () {
      if (!dom.picker.hidden && state.pickerSide === "from") { closePicker(true); return; }
      openPicker("from");
    });

    dom.toBtn.addEventListener("click", function () {
      if (!dom.picker.hidden && state.pickerSide === "to") { closePicker(true); return; }
      openPicker("to");
    });

    dom.swap.addEventListener("click", function () {
      var tmp = state.from;
      state.from = state.to;
      state.to = tmp;
      write(STORE.pair, [state.from, state.to]);
      refreshAll();
    });

    dom.picker.addEventListener("click", function (event) {
      var option = event.target.closest(".picker__option");
      if (option) pickCurrency(option.dataset.code);
    });

    dom.pickerSearch.addEventListener("input", function () { renderPicker(this.value); });

    dom.pickerSearch.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      var first = $(".picker__option", dom.picker);
      if (first) pickCurrency(first.dataset.code);
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      closePicker(true);
      if (!dom.mtabsMenu.hidden) { closeMobileMenu(); dom.mtabsToggle.focus(); }
    });

    document.addEventListener("click", function (event) {
      if (!dom.picker.hidden &&
          !dom.picker.contains(event.target) &&
          !dom.fromBtn.contains(event.target) &&
          !dom.toBtn.contains(event.target)) {
        closePicker(false);
      }
      if (!dom.mtabsMenu.hidden &&
          !dom.mtabsMenu.contains(event.target) &&
          !dom.mtabsToggle.contains(event.target)) {
        closeMobileMenu();
      }
    });

    window.addEventListener("resize", function () {
      if (!dom.picker.hidden) {
        positionPicker(state.pickerSide === "from" ? dom.fromBtn : dom.toBtn);
      }
      if (state.tab === "history" && state.series) drawChart();
    });

    dom.favToggle.addEventListener("click", function () {
      toggleFavorite(pairKey(state.from, state.to));
    });

    dom.logBtn.addEventListener("click", addLogEntry);

    $$(".range").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.range = this.dataset.range;
        $$(".range").forEach(function (b) {
          var active = b === btn;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        renderHistory();
      });
    });

    $("#history-retry").addEventListener("click", function () {
      seriesCache = {};
      renderHistory();
    });

    $$(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        selectTab(this.id.replace("tab-", ""));
      });
      tab.addEventListener("keydown", function (event) {
        var tabs = $$(".tab");
        var i = tabs.indexOf(this);
        var next = event.key === "ArrowRight" ? i + 1 : event.key === "ArrowLeft" ? i - 1 : -1;
        if (next < 0 || next >= tabs.length) return;
        event.preventDefault();
        tabs[next].focus();
        selectTab(tabs[next].id.replace("tab-", ""));
      });
    });

    dom.mtabsToggle.addEventListener("click", function () {
      if (dom.mtabsMenu.hidden) openMobileMenu(); else closeMobileMenu();
    });

    dom.mtabsMenu.addEventListener("click", function (event) {
      var item = event.target.closest(".mtabs__item");
      if (!item) return;
      selectTab(item.dataset.tab);
      dom.mtabsToggle.focus();
    });

    document.addEventListener("click", function (event) {
      var star = event.target.closest("[data-pair]");
      if (star) { toggleFavorite(star.dataset.pair); return; }

      var setPair = event.target.closest("[data-set-pair]");
      if (setPair) {
        var parts = setPair.dataset.setPair.split("/");
        state.from = parts[0];
        state.to = parts[1];
        write(STORE.pair, parts);
        refreshAll();
        selectTab("history");
        return;
      }

      var remove = event.target.closest("[data-remove]");
      if (remove) {
        state.log = state.log.filter(function (e) { return e.id !== remove.dataset.remove; });
        write(STORE.log, state.log);
        renderLog();
      }
    });

    dom.clearLog.addEventListener("click", function () {
      if (!state.log.length) return;
      state.log = [];
      write(STORE.log, state.log);
      renderLog();
      toast("Log cleared");
    });
  }

  /* --------------------------------- Init ------------------------------- */

  function showFatalError() {
    dom.rateLine.classList.add("is-error");
    dom.rateLine.textContent = "Couldn't reach the rates service. Check your connection and reload.";
    dom.tickerTrack.textContent = "";
    dom.tickerTrack.appendChild(el("p", "ticker__loading", "Rates unavailable"));
  }

  function init() {
    state.favorites = read(STORE.fav, []);
    state.log = read(STORE.log, []);

    var savedPair = read(STORE.pair, null);
    if (savedPair && savedPair.length === 2) {
      state.from = savedPair[0];
      state.to = savedPair[1];
    }

    state.amount = parseAmount(dom.amountInput.value);

    bindEvents();
    renderLog();
    renderFavorites();

    Promise.all([loadCurrencies(), loadRates()])
      .then(function () {
        if (!state.rates[state.from]) state.from = "USD";
        if (!state.rates[state.to]) state.to = "EUR";
        renderTicker();
        refreshAll();
        /* Refresh the reference rates every 10 minutes. */
        setInterval(function () {
          loadRates().then(function () {
            renderTicker();
            renderConverter();
            renderCompare();
            renderFavorites();
          }).catch(function () { /* keep the last good rates */ });
        }, 600000);
      })
      .catch(showFatalError);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
