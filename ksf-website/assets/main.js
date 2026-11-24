/* KSF Food Industries — site script */
(function () {
  "use strict";
  document.documentElement.classList.remove("no-js");

  /* ---------------- Product data (placeholder flavours: edit freely) ---------------- */
  var FLAVOURS = [
    { id: "classic", line: "chips", name: "Classic Salted", l1: "CLASSIC", l2: "SALTED", desc: "Thin-cut potatoes, a pinch of sea salt, nothing to hide behind. The crunch that started it all.", heat: 0, bag: ["#ffe066", "#f5a400"], band: "#1d4ed8", card: ["#ffe58a", "#ffb81c"], text: "dark", tag: "Bestseller" },
    { id: "masala", line: "chips", name: "Masala Magic", l1: "MASALA", l2: "MAGIC", desc: "A bold desi masala blend with roasted cumin and red chilli, made for chai-time cravings.", heat: 3, bag: ["#ff8a2a", "#d9480f"], band: "#7c2d12", card: ["#ffb26b", "#f76707"], text: "dark", tag: "Lahori favourite" },
    { id: "chilli-lemon", line: "chips", name: "Chilli Lemon", l1: "CHILLI", l2: "LEMON", desc: "Zesty lemon up front, a slow chilli kick behind. Tangy, loud and impossible to share.", heat: 2, bag: ["#c9e43b", "#6fa80c"], band: "#e5322d", card: ["#e3f38a", "#9cc91a"], text: "dark", tag: "Tangy" },
    { id: "bbq", line: "chips", name: "Smoky BBQ", l1: "SMOKY", l2: "BBQ", desc: "Slow-smoked barbecue notes with a sweet, sticky finish, like a rooftop grill in Gulberg.", heat: 2, bag: ["#a23b1f", "#4a1309"], band: "#ffb81c", card: ["#b8502f", "#5c1a0b"], text: "light", tag: "Smoky" },
    { id: "salt-vinegar", line: "chips", name: "Salt & Vinegar", l1: "SALT &", l2: "VINEGAR", desc: "Sharp, puckering vinegar tang balanced with crunchy sea salt. For the brave.", heat: 0, bag: ["#5bbcff", "#1c63c9"], band: "#fff7e8", card: ["#7cc8ff", "#2774d8"], text: "light", tag: "Sharp" },
    { id: "sour-cream", line: "chips", name: "Cream & Onion", l1: "CREAM &", l2: "ONION", desc: "Cool sour cream, sweet onion and a hint of herbs. Smooth, mellow and very moreish.", heat: 0, bag: ["#7ddba9", "#1f9e6a"], band: "#0f5132", card: ["#a8ebc6", "#38b77f"], text: "dark", tag: "Mellow" },
    { id: "cheese-pops", line: "pops", name: "Cheesy Pops", l1: "CHEESY", l2: "POPS", desc: "Light, airy corn pops coated in rich cheddar. One handful is never enough.", heat: 0, bag: ["#ffc83d", "#fb8500"], band: "#ff4f8b", card: ["#ffd86b", "#ff9f1c"], text: "dark", tag: "New · Pops" },
    { id: "chatpata-pops", line: "pops", name: "Chatpata Pops", l1: "CHATPATA", l2: "POPS", desc: "Tangy chaat masala on crunchy pops. The taste of a Lahore street stall, in a pack.", heat: 2, bag: ["#ff5c93", "#c9184a"], band: "#ffd23f", card: ["#ff8fb3", "#e0306a"], text: "dark", tag: "New · Pops" },
    { id: "ketchup-pops", line: "pops", name: "Ketchup Pops", l1: "KETCHUP", l2: "POPS", desc: "Sweet-tangy tomato ketchup flavour that kids (and grown-ups) can't resist.", heat: 1, bag: ["#ef3b3b", "#8d0801"], band: "#ffd23f", card: ["#ff6b6b", "#b5130c"], text: "light", tag: "New · Pops" }
  ];

  var uid = 0;

  /* A stylised pillow-pack in SVG, so the site looks finished before product photography exists. */
  function bagSVG(f) {
    var i = "b" + (++uid);
    var isPops = f.line === "pops";
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
      '<circle cx="100" cy="64" r="25" fill="#120d08"/>' +
      '<circle cx="100" cy="64" r="21" fill="#ffb81c"/>' +
      '<text x="100" y="70.5" text-anchor="middle" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="16" fill="#120d08">KSF</text>' +
      '<text x="100" y="104" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-weight="700" font-size="8" letter-spacing="2.4" fill="#120d08" opacity=".75">' + (isPops ? "CORN POPS" : "POTATO CHIPS") + '</text>' +
      '<text x="100" y="128" text-anchor="middle" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="22" fill="#fff" stroke="#120d08" stroke-width="3" paint-order="stroke">' + f.l1 + '</text>' +
      '<text x="100" y="150" text-anchor="middle" font-family="Bricolage Grotesque, Arial Black, sans-serif" font-weight="800" font-size="22" fill="#fff" stroke="#120d08" stroke-width="3" paint-order="stroke">' + f.l2 + '</text>' +
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
    var s = '<div class="heat" aria-label="Spice level ' + n + ' of 3">';
    for (var k = 1; k <= 3; k++) s += '<i class="' + (k <= n ? "on" : "") + '"></i>';
    return s + '<b>' + (["Mild", "Light kick", "Medium heat", "Hot"][n]) + '</b></div>';
  }

  function cardHTML(f, idx) {
    return '<article class="flavour reveal ' + (f.text === "light" ? "light-text" : "dark-text") + ' d' + (idx % 3 + 1) + '" data-line="' + f.line + '" style="--c:' + f.card[0] + ';--c2:' + f.card[1] + '">' +
      '<span class="tag">' + f.tag + '</span>' +
      '<div class="bag-wrap">' + bagSVG(f) + '</div>' +
      '<h3>' + f.name + '</h3>' +
      '<p>' + f.desc + '</p>' +
      heatHTML(f.heat) +
      '</article>';
  }

  // Render product grids
  document.querySelectorAll("[data-flavours]").forEach(function (grid) {
    var mode = grid.getAttribute("data-flavours");
    var list = mode === "featured" ? FLAVOURS.filter(function (f) { return ["classic", "masala", "chilli-lemon"].indexOf(f.id) > -1; }) : FLAVOURS;
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
  filterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var v = btn.getAttribute("data-filter");
      filterBtns.forEach(function (b) { b.setAttribute("aria-pressed", String(b === btn)); });
      document.querySelectorAll(".flavour").forEach(function (card) {
        card.hidden = !(v === "all" || card.getAttribute("data-line") === v);
      });
    });
  });

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

  /* ---------------- Year ---------------- */
  document.querySelectorAll("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
})();
