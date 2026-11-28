/* KSF Food Industries — site script */
(function () {
  "use strict";
  document.documentElement.classList.remove("no-js");

  /* ---------------- Product data (placeholder flavours: edit freely) ---------------- */
  var FLAVOURS = [
    { id: "yogurt-herbs", line: "chips", name: "Yogurt & Herbs", l1: "YOGURT &", l2: "HERBS", desc: "Cool, creamy yogurt with fresh garden herbs on crinkle-cut potato chips. Smooth, fresh and moreish.", heat: 0, bag: ["#6fd04a", "#1f6b17"], band: "#fff7e8", card: ["#5fbf3f", "#1d5e16"], text: "light", tag: "Fresh & creamy" },
    { id: "masala", line: "chips", name: "Masala", l1: "MASALA", l2: "", desc: "A bold desi masala blend with a proper chilli kick. The flavour Pakistan grew up on, done right.", heat: 3, bag: ["#ef3a2c", "#7a0c0a"], band: "#ffb81c", card: ["#e0362b", "#6e0a08"], text: "light", tag: "Bestseller" },
    { id: "bbq", line: "chips", name: "Barbecue", l1: "BARBECUE", l2: "", desc: "Smoky, sweet and tangy barbecue seasoning, like a rooftop grill night in Lahore.", heat: 2, bag: ["#ffa53a", "#b04a06"], band: "#e5322d", card: ["#f59a2e", "#a8460a"], text: "light", tag: "Smoky" },
    { id: "masala-pops", line: "pops", name: "Yummy Masala Pops", l1: "YUMMY", l2: "MASALA", desc: "Light, crunchy corn puffs dusted in a yummy desi masala. Baked, not fried.", heat: 2, bag: ["#7ad44e", "#1f6b17"], band: "#ffd23f", card: ["#6cc246", "#1f6b17"], text: "light", tag: "Baked, not fried" },
    { id: "cheese-pops", line: "pops", name: "Cheese Pops", l1: "CHEESE", l2: "POPS", desc: "Airy corn puffs coated in rich, cheesy goodness. One handful is never enough. Baked, not fried.", heat: 0, bag: ["#3a7cf0", "#0b2a78"], band: "#ffd23f", card: ["#2f6fe0", "#0b2a78"], text: "light", tag: "Kids' favourite" },
    { id: "tomato-pops", line: "pops", name: "Tangy Tomato Pops", l1: "TANGY", l2: "TOMATO", desc: "Sweet-tangy tomato flavour on crunchy corn puffs that kids and grown-ups love. Baked, not fried.", heat: 1, bag: ["#ff5a48", "#7e0a07"], band: "#ffd23f", card: ["#ef4a3c", "#7e0a07"], text: "light", tag: "Tangy" }
  ];

  /* Urdu text for the /ur/ pages (pack art stays in English, as printed) */
  var UR = document.documentElement.lang === "ur";
  var UR_TEXT = {
    "yogurt-herbs": { name: "یوگرٹ اینڈ ہربز", desc: "کرنکل کٹ آلو چپس پر ٹھنڈا، کریمی دہی اور تازہ ہربز۔ ہلکا، تازہ اور مزیدار۔", tag: "تازہ اور کریمی" },
    "masala": { name: "مصالحہ", desc: "مرچ کے مزیدار تڑکے کے ساتھ دیسی مصالحہ۔ وہ ذائقہ جس کے ساتھ پاکستان بڑا ہوا، بالکل صحیح انداز میں۔", tag: "سب سے زیادہ پسندیدہ" },
    "bbq": { name: "باربی کیو", desc: "دھواں دار، میٹھا اور چٹپٹا باربی کیو مصالحہ، جیسے لاہور کی چھت پر باربی کیو کی رات۔", tag: "دھواں دار" },
    "masala-pops": { name: "یمی مصالحہ پاپس", desc: "دیسی مصالحے میں لپٹے ہلکے، کرنچی کارن پفس۔ فرائی نہیں، بیکڈ۔", tag: "فرائی نہیں، بیکڈ" },
    "cheese-pops": { name: "چیز پاپس", desc: "مزیدار چیز میں لپٹے ہلکے پھلکے کارن پفس۔ ایک مٹھی کبھی کافی نہیں۔ فرائی نہیں، بیکڈ۔", tag: "بچوں کا پسندیدہ" },
    "tomato-pops": { name: "ٹینگی ٹماٹو پاپس", desc: "کرنچی کارن پفس پر کھٹا میٹھا ٹماٹو ذائقہ، بچوں اور بڑوں سب کا پسندیدہ۔ فرائی نہیں، بیکڈ۔", tag: "چٹپٹا" }
  };
  var SLUG = { "yogurt-herbs": "yogurt-herbs-chips", "masala": "masala-chips", "bbq": "bbq-chips", "masala-pops": "masala-pops", "cheese-pops": "cheese-pops", "tomato-pops": "tomato-pops" };
  function txt(f, k) { return UR && UR_TEXT[f.id] ? UR_TEXT[f.id][k] : f[k]; }

  var uid = 0;

  /* A stylised pillow-pack in SVG, so the site looks finished before product photography exists. */
  function bagSVG(f) {
    var i = "b" + (++uid);
    var isPops = f.line === "pops";
    var fs = f.l1.length > 8 ? 20 : 24;
    var art = isPops
      ? '<g>' +
          '<circle cx="78" cy="208" r="17" fill="url(#' + i + 'p)"/>' +
          '<circle cx="112" cy="198" r="21" fill="url(#' + i + 'p)"/>' +
          '<circle cx="134" cy="222" r="15" fill="url(#' + i + 'p)"/>' +
          '<circle cx="98" cy="228" r="14" fill="url(#' + i + 'p)"/>' +
        '</g>'
      : '<g transform="translate(100 212) rotate(-12)">' +
          '<path d="M-46 -4 C-44 -22 -18 -30 6 -27 C30 -24 48 -12 46 4 C44 22 18 28 -6 26 C-30 24 -48 14 -46 -4Z" fill="url(#' + i + 'c)"/>' +
          '<path d="M-30 -8 C-10 -16 14 -16 32 -6" stroke="rgba(160,90,0,.35)" stroke-width="2" fill="none"/>' +
          '<circle cx="-12" cy="6" r="2.4" fill="rgba(140,70,0,.45)"/><circle cx="14" cy="-4" r="2" fill="rgba(140,70,0,.45)"/><circle cx="24" cy="10" r="1.8" fill="rgba(140,70,0,.45)"/>' +
        '</g>' +
        '<g transform="translate(60 190) rotate(24) scale(.55)">' +
          '<path d="M-46 -4 C-44 -22 -18 -30 6 -27 C30 -24 48 -12 46 4 C44 22 18 28 -6 26 C-30 24 -48 14 -46 -4Z" fill="url(#' + i + 'c)"/>' +
        '</g>';
    return '' +
      '<svg viewBox="0 0 200 290" role="img" aria-label="KSF ' + f.name + ' pack">' +
      '<defs>' +
        '<linearGradient id="' + i + 'g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + f.bag[0] + '"/><stop offset="1" stop-color="' + f.bag[1] + '"/></linearGradient>' +
        '<linearGradient id="' + i + 's" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".25" stop-color="#fff" stop-opacity=".08"/><stop offset=".75" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".28"/></linearGradient>' +
        '<radialGradient id="' + i + 'c" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff2b8"/><stop offset=".45" stop-color="#ffcf4a"/><stop offset="1" stop-color="#d98e04"/></radialGradient>' +
        '<radialGradient id="' + i + 'p" cx=".32" cy=".28" r=".8"><stop offset="0" stop-color="#fff7d6"/><stop offset=".45" stop-color="#ffd23f"/><stop offset="1" stop-color="#e08a00"/></radialGradient>' +
        '<clipPath id="' + i + 'k"><path d="M24 22 C17 100 15 190 24 268 L176 268 C185 190 183 100 176 22 Z"/></clipPath>' +
      '</defs>' +
      '<path d="M24 22 C17 100 15 190 24 268 L176 268 C185 190 183 100 176 22 Z" fill="url(#' + i + 'g)"/>' +
      '<g clip-path="url(#' + i + 'k)">' +
        '<path d="M0 150 C50 128 120 176 200 140 L200 175 C130 200 60 160 0 185Z" fill="' + f.band + '" opacity=".9"/>' +
        '<circle cx="170" cy="70" r="60" fill="#fff" opacity=".08"/>' +
        art +
        '<rect x="0" y="0" width="200" height="290" fill="url(#' + i + 's)"/>' +
      '</g>' +
      '<g>' +
        '<rect x="18" y="6" width="164" height="22" rx="5" fill="' + f.bag[1] + '"/>' +
        '<rect x="18" y="262" width="164" height="22" rx="5" fill="' + f.bag[1] + '"/>' +
        '<path d="' + crimp(6) + crimp(262) + '" stroke="rgba(0,0,0,.18)" stroke-width="1.4"/>' +
      '</g>' +
      '<image href="/assets/ksf-logo.webp" x="52" y="32" width="96" height="74"/>' +
      '<text x="100" y="117" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="8" letter-spacing="1.6" fill="#fff" opacity=".9">' + (isPops ? "CORN PUFFS" : "FLAVORED POTATO CHIPS") + '</text>' +
      '<text x="100" y="' + (f.l2 ? 140 : 152) + '" text-anchor="middle" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="' + fs + '" fill="#fff" stroke="#120d08" stroke-width="3" paint-order="stroke">' + f.l1 + '</text>' +
      '<text x="100" y="162" text-anchor="middle" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="' + fs + '" fill="#ffd23f" stroke="#120d08" stroke-width="3" paint-order="stroke">' + f.l2 + '</text>' +
      '<circle cx="152" cy="232" r="17" fill="#120d08"/><circle cx="152" cy="232" r="14.5" fill="none" stroke="#ffb81c" stroke-width="1"/>' +
      '<text x="152" y="230" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="5.6" fill="#ffb81c">' + (isPops ? "BAKED" : "REAL") + '</text>' +
      '<text x="152" y="237" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="800" font-size="4.6" fill="#ffb81c">' + (isPops ? "NOT FRIED" : "POTATOES") + '</text>' +
      '<rect x="30" y="226" width="11" height="11" rx="1.5" fill="#fff" stroke="#1f9e3a" stroke-width="1.4"/><circle cx="35.5" cy="231.5" r="2.6" fill="#1f9e3a"/>' +
      '<text x="45" y="234" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="5.4" fill="#fff">100% VEG</text>' +
      '<text x="100" y="254" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="7" letter-spacing="1.5" fill="#fff" opacity=".85">MADE IN LAHORE · PAKISTAN</text>' +
      '</svg>';
  }
  function crimp(y) {
    var d = "";
    for (var x = 24; x < 180; x += 6) d += "M" + x + " " + (y + 3) + "V" + (y + 19);
    return d;
  }

  function chipSVG() {
    var i = "c" + (++uid);
    return '<svg viewBox="-50 -32 100 64" aria-hidden="true"><defs><radialGradient id="' + i + '" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#fff2b8"/><stop offset=".45" stop-color="#ffcf4a"/><stop offset="1" stop-color="#d98e04"/></radialGradient></defs>' +
      '<path d="M-46 -4 C-44 -22 -18 -30 6 -27 C30 -24 48 -12 46 4 C44 22 18 28 -6 26 C-30 24 -48 14 -46 -4Z" fill="url(#' + i + ')"/>' +
      '<circle cx="-12" cy="6" r="2.6" fill="rgba(140,70,0,.45)"/><circle cx="14" cy="-4" r="2.2" fill="rgba(140,70,0,.45)"/><circle cx="26" cy="10" r="2" fill="rgba(140,70,0,.45)"/></svg>';
  }

  function heatHTML(n) {
    var s = '<div class="heat" aria-label="' + (UR ? "تیزی " + n + " / 3" : "Spice level " + n + " of 3") + '">';
    for (var k = 1; k <= 3; k++) s += '<i class="' + (k <= n ? "on" : "") + '"></i>';
    return s + '<b>' + ((UR ? ["ہلکا", "ہلکی تیزی", "درمیانی تیزی", "تیز"] : ["Mild", "Light kick", "Medium heat", "Hot"])[n]) + '</b></div>';
  }

  function cardHTML(f, idx) {
    return '<article id="' + f.id + '" class="flavour reveal ' + (f.text === "light" ? "light-text" : "dark-text") + ' d' + (idx % 3 + 1) + '" data-line="' + f.line + '" style="--c:' + f.card[0] + ';--c2:' + f.card[1] + '">' +
      '<span class="tag">' + txt(f, "tag") + '</span>' +
      '<div class="bag-wrap">' + bagSVG(f) + '</div>' +
      '<h3><a class="fl-link" href="' + (UR ? "/ur/" : "/") + SLUG[f.id] + '.html">' + txt(f, "name") + '</a></h3>' +
      '<p>' + txt(f, "desc") + '</p>' +
      heatHTML(f.heat) +
      '</article>';
  }

  // Render product grids
  document.querySelectorAll("[data-flavours]").forEach(function (grid) {
    var mode = grid.getAttribute("data-flavours");
    var list = mode === "featured" ? FLAVOURS.filter(function (f) { return ["masala", "yogurt-herbs", "cheese-pops"].indexOf(f.id) > -1; }) : FLAVOURS;
    grid.innerHTML = list.map(cardHTML).join("");
  });

  // Single bags anywhere: <div data-bag="masala"></div>
  document.querySelectorAll("[data-bag]").forEach(function (el) {
    var f = FLAVOURS.filter(function (x) { return x.id === el.getAttribute("data-bag"); })[0];
    if (f) el.innerHTML = bagSVG(f);
    var svg = el.firstChild;
    if (svg && el.className) { svg.setAttribute("class", el.className); el.replaceWith(svg); }
  });
  document.querySelectorAll("[data-chip]").forEach(function (el) {
    el.innerHTML = chipSVG();
    var svg = el.firstChild; svg.setAttribute("class", el.className); el.replaceWith(svg);
  });

  /* ---------------- Filters ---------------- */
  var filterBtns = document.querySelectorAll(".filters button");
  var filterBar = document.querySelector(".filters");
  var filterStatus = null;
  if (filterBar) {
    filterStatus = document.createElement("p");
    filterStatus.className = "filter-status";
    filterStatus.setAttribute("role", "status");
    filterStatus.setAttribute("aria-live", "polite");
    filterBar.insertAdjacentElement("afterend", filterStatus);
  }
  var isUrdu = (document.documentElement.lang || "").indexOf("ur") === 0;
  function applyFilter(v, fromClick) {
    var btn = null, shown = [];
    filterBtns.forEach(function (b) {
      var on = b.getAttribute("data-filter") === v;
      if (on) btn = b;
      b.setAttribute("aria-pressed", String(on));
    });
    if (!btn) return;
    document.querySelectorAll(".flavour").forEach(function (card) {
      var show = v === "all" || card.getAttribute("data-line") === v;
      card.hidden = !show;
      card.classList.remove("filter-in");
      if (show) shown.push(card);
    });
    if (filterStatus) {
      filterStatus.textContent = isUrdu
        ? btn.textContent + " · " + shown.length + " ذائقے"
        : btn.textContent + " · " + shown.length + (shown.length === 1 ? " flavour" : " flavours");
    }
    if (!fromClick) return;
    // Replay a short entrance so the change is visible even when the first cards stay the same
    void document.body.offsetWidth;
    shown.forEach(function (card, i) { card.style.animationDelay = (i * 70) + "ms"; card.classList.add("in", "filter-in"); });
    if (history.replaceState) history.replaceState(null, "", v === "all" ? location.pathname : "#" + v);
    var grid = document.querySelector(".flavours");
    if (grid && filterBar && filterBar.getBoundingClientRect().top < 0) {
      filterBar.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  filterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () { applyFilter(btn.getAttribute("data-filter"), true); });
  });
  if (filterBtns.length) {
    var startFilter = (location.hash || "").replace("#", "");
    applyFilter(startFilter === "chips" || startFilter === "pops" ? startFilter : "all", false);
  }

  /* ---------------- Header + menu ---------------- */
  var header = document.querySelector(".site-header");
  function onScroll() { if (header) header.classList.toggle("scrolled", window.scrollY > 20); }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  var menuBtn = document.querySelector(".menu-btn");
  if (menuBtn) {
    menuBtn.addEventListener("click", function () {
      var open = document.body.classList.toggle("menu-open");
      menuBtn.setAttribute("aria-expanded", String(open));
    });
    document.querySelectorAll(".mobile-menu a").forEach(function (a) {
      a.addEventListener("click", function () { document.body.classList.remove("menu-open"); menuBtn.setAttribute("aria-expanded", "false"); });
    });
  }

  /* ---------------- Reveal on scroll ---------------- */
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---------------- Statement: words light up as you scroll ---------------- */
  var statement = document.querySelector(".statement p");
  if (statement) {
    var html = statement.innerHTML.replace(/<em>(.*?)<\/em>/g, "§$1§");
    var gold = false;
    statement.innerHTML = html.split(/\s+/).map(function (w) {
      var start = w.indexOf("§") === 0, end = w.lastIndexOf("§") === w.length - 1 && w.length > 1;
      if (start) gold = true;
      var cls = "w" + (gold ? " g" : "");
      if (end || (start && w.split("§").length > 2)) gold = false;
      return '<span class="' + cls + '">' + w.replace(/§/g, "") + "</span>";
    }).join(" ");
    var words = statement.querySelectorAll(".w");
    var lightUp = function () {
      var r = statement.getBoundingClientRect();
      var vh = window.innerHeight;
      var p = Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (r.height + vh * 0.35)));
      var n = Math.round(p * words.length);
      words.forEach(function (w, k) { w.classList.toggle("lit", k < n); });
    };
    if (reduce) words.forEach(function (w) { w.classList.add("lit"); });
    else { lightUp(); window.addEventListener("scroll", lightUp, { passive: true }); }
  }

  /* ---------------- 3D tilt on flavour cards ---------------- */
  if (!reduce && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll(".flavour").forEach(function (card) {
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = "perspective(900px) rotateY(" + x * 8 + "deg) rotateX(" + -y * 8 + "deg) translateY(-6px)";
      });
      card.addEventListener("pointerleave", function () { card.style.transform = ""; });
    });

    // Hero parallax
    var stage = document.querySelector(".hero-stage");
    if (stage) {
      window.addEventListener("pointermove", function (e) {
        var x = e.clientX / window.innerWidth - 0.5, y = e.clientY / window.innerHeight - 0.5;
        stage.style.transform = "translate(" + x * -18 + "px," + y * -18 + "px)";
      }, { passive: true });
    }
  }

  /* ---------------- Contact form → opens the visitor's email app ---------------- */
  var form = document.querySelector("form.enquiry");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!form.reportValidity()) return;
      var d = new FormData(form);
      if (form.getAttribute("data-form") === "distributor") { sendDistributor(form, d, e.submitter); return; }
      var to = d.get("topic") === "marketing" ? "marketing@ksffood.com" : "sales@ksffood.com";
      var topicLabel = form.querySelector('select[name="topic"] option:checked').textContent;
      var subject = "Website enquiry: " + topicLabel + " (" + d.get("name") + ")";
      var body = [
        "Name: " + d.get("name"),
        "Email: " + d.get("email"),
        "Phone: " + (d.get("phone") || "-"),
        "City: " + (d.get("city") || "-"),
        "Topic: " + topicLabel,
        "",
        d.get("message")
      ].join("\n");
      window.location.href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      var note = form.querySelector(".note");
      if (note) note.textContent = "Your email app should open with your message ready to send to " + to + ".";
    });
  }

  /* Distributor application: WhatsApp (default) or email */
  function sendDistributor(form, d, submitter) {
    var via = submitter && submitter.value === "email" ? "email" : "whatsapp";
    var typeLabel = form.querySelector('select[name="topic"] option:checked').textContent;
    var lines = UR ? [
      "KSF ڈسٹری بیوٹر درخواست",
      "نام: " + d.get("name"), "کاروبار: " + (d.get("business") || "-"), "فون: " + d.get("phone"),
      "شہر: " + d.get("city"), "علاقے: " + (d.get("area") || "-"), "قسم: " + typeLabel, "", d.get("message") || ""
    ] : [
      "KSF distributor application",
      "Name: " + d.get("name"), "Business: " + (d.get("business") || "-"), "Phone: " + d.get("phone"),
      "City: " + d.get("city"), "Areas: " + (d.get("area") || "-"), "Type: " + typeLabel, "", d.get("message") || ""
    ];
    var body = lines.join("\n");
    var note = form.querySelector(".note");
    if (via === "whatsapp") {
      window.open("https://wa.me/923216806097?text=" + encodeURIComponent(body), "_blank", "noopener");
      if (note) note.textContent = UR ? "واٹس ایپ میں آپ کا پیغام تیار ہے، بس بھیج دیں۔" : "WhatsApp has opened with your application ready. Just press send.";
    } else {
      var subject = "Distributor application: " + d.get("name") + " (" + d.get("city") + ")";
      window.location.href = "mailto:sales@ksffood.com?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      if (note) note.textContent = UR ? "آپ کی ای میل ایپ پیغام کے ساتھ کھل جائے گی۔" : "Your email app should open with your application ready to send to sales@ksffood.com.";
    }
    if (window.gtag) window.gtag("event", "generate_lead", { method: via, form: "distributor" });
  }

  /* Analytics: count WhatsApp and email clicks */
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || !window.gtag) return;
    var h = a.getAttribute("href");
    if (h.indexOf("wa.me/") > -1) window.gtag("event", "whatsapp_click", { link_url: h.split("?")[0], page_language: UR ? "ur" : "en" });
    else if (h.indexOf("mailto:") === 0) window.gtag("event", "email_click", { link_url: h.split("?")[0] });
  });

  /* ---------------- Year ---------------- */
  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
