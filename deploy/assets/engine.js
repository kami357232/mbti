/*!
 * 通用测试引擎 —— 一个数据文件 + 这个引擎 = 一个测试页
 * 能力：随机题序（防同维度连排）、反向题计分、跳过按 0.5 计、
 *       三档判读、可信度校验、进度存档续答、结果块渲染、复制结果。
 *
 * 数据契约（window.TESTS.xxx）：
 *  {
 *    id, title, intro:{...}, foot,
 *    dims:[{key, desc, left:{code,name}, right:{code,name}}],
 *    questions:[{axis, rev, q, a, b}],
 *    resolve(axes, stat) -> typeKey,
 *    bandText:{middle,lean,clear},
 *    types:{ key:{big,name,tagline,blocks:[...] } },
 *    next:{href,kicker,title,desc},
 *    copyText(r,t) -> string   // 可选
 *  }
 */
(function (global) {
  "use strict";

  /* ---------------- 工具 ---------------- */

  function shuffle(arr, rnd) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // 打乱题序，且同一维度不连续出现 3 题以上；尽力而为，否则返回最优的一次
  function buildOrder(questions, rnd) {
    rnd = rnd || Math.random;
    var idx = questions.map(function (_, i) { return i; });
    var best = null, bestWorst = Infinity;
    var worstOf = function (order) {
      var run = 1, worst = 1;
      for (var i = 1; i < order.length; i++) {
        run = questions[order[i]].axis === questions[order[i - 1]].axis ? run + 1 : 1;
        if (run > worst) worst = run;
      }
      return worst;
    };
    for (var attempt = 0; attempt < 60; attempt++) {
      var order = shuffle(idx, rnd);
      var worst = worstOf(order);
      if (worst < 3) return order;
      if (worst < bestWorst) { bestWorst = worst; best = order; }
    }
    return best || shuffle(idx, rnd);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function dimOf(def, key) {
    for (var i = 0; i < def.dims.length; i++) if (def.dims[i].key === key) return def.dims[i];
    throw new Error("未知维度: " + key);
  }

  /* ---------------- 计分 ---------------- */

  // records: [{axis, rev, choice}]，choice ∈ 'a' | 'b' | 'n'
  function compute(def, records) {
    var counts = {};
    def.dims.forEach(function (d) { counts[d.key] = { l: 0, r: 0 }; });

    var stat = { total: 0, neutral: 0, a: 0, b: 0 };

    records.forEach(function (q) {
      var d = dimOf(def, q.axis);
      stat.total++;
      if (!q.choice || q.choice === "n") {
        stat.neutral++;
        counts[d.key].l += 0.5;
        counts[d.key].r += 0.5;
        return;
      }
      var pickedLeft = (q.choice === "a") !== Boolean(q.rev);
      counts[d.key][pickedLeft ? "l" : "r"] += 1;
      if (q.choice === "a") stat.a++; else stat.b++;
    });

    var axes = def.dims.map(function (d) {
      var c = counts[d.key];
      var total = c.l + c.r;
      var leftPct = total ? Math.round((c.l / total) * 100) : 50;
      var diff = Math.abs(leftPct - 50);
      var band = diff < 10 ? "middle" : diff < 30 ? "lean" : "clear";
      return {
        key: d.key,
        desc: d.desc || "",
        left: d.left, right: d.right,
        leftPct: leftPct, rightPct: 100 - leftPct,
        pick: c.l >= c.r ? "left" : "right",
        band: band,
        total: total,
      };
    });

    var answered = stat.a + stat.b;
    var straight = answered ? Math.max(stat.a, stat.b) / answered : 0;
    var neutralRatio = stat.total ? stat.neutral / stat.total : 0;
    var confidence =
      neutralRatio > 0.3 || straight > 0.9 ? "low" :
      neutralRatio > 0.15 || straight > 0.8 ? "medium" : "high";

    return {
      code: def.resolve(axes, stat),
      axes: axes, stat: stat, straight: straight, confidence: confidence,
    };
  }

  /* ---------------- 渲染 ---------------- */

  function blockHTML(b) {
    switch (b.kind) {
      case "list":
        return "<h2>" + esc(b.title) + "</h2><ul class=\"list\">" +
          b.items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
      case "plain":
        return "<h2>" + esc(b.title) + "</h2><ul class=\"list plain\">" +
          b.items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
      case "text":
        return "<h2>" + esc(b.title) + "</h2><p class=\"small\">" + esc(b.text) + "</p>";
      case "chips":
        return "<h2>" + esc(b.title) + "</h2><ul class=\"chips\">" +
          b.items.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" +
          (b.note ? "<p class=\"muted small\" style=\"margin-top:8px\">" + esc(b.note) + "</p>" : "");
      case "pairs":
        return "<h2>" + esc(b.title) + "</h2>" +
          b.items.map(function (p) {
            return "<div class=\"pair\"><div class=\"who\">" + esc(p.who) + "</div>" +
              "<div class=\"say\">" + esc(p.say) + "</div></div>";
          }).join("") +
          (b.note ? "<p class=\"muted small\">" + esc(b.note) + "</p>" : "");
      case "adv":
        return "<details class=\"adv\"><summary>" + esc(b.title) + "</summary><div class=\"inner\">" +
          (b.stack ? "<p><span class=\"stack\">" + esc(b.stack) + "</span></p>" : "") +
          (b.text ? "<p class=\"muted small\">" + esc(b.text) + "</p>" : "") + "</div></details>";
      case "note":
        return "<div class=\"note " + (b.tone || "") + "\">" + b.text + "</div>";
      default:
        return "";
    }
  }

  function crossHTML(def, cls) {
    if (!def.next) return "";
    return "<a class=\"cross " + (cls || "") + "\" href=\"" + esc(def.next.href) + "\">" +
      "<div class=\"k\">" + esc(def.next.kicker || "下一个") + "</div>" +
      "<div class=\"t\">" + esc(def.next.title) + "</div>" +
      "<div class=\"d\">" + esc(def.next.desc) + "</div></a>";
  }

  /* ---------------- 应用 ---------------- */

  function start(def) {
    var app = document.getElementById("app");
    var SAVE_KEY = def.id + "_progress_v3";
    var state = { order: [], pos: 0, answers: [], startedAt: 0, view: "intro" };

    function save() {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          order: state.order, pos: state.pos, answers: state.answers, startedAt: state.startedAt,
        }));
      } catch (e) { /* 隐私模式忽略 */ }
    }
    function loadSave() {
      try {
        var raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        if (!Array.isArray(s.order) || s.order.length !== def.questions.length) return null;
        if (typeof s.pos !== "number" || s.pos <= 0 || s.pos >= def.questions.length) return null;
        return s;
      } catch (e) { return null; }
    }
    function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

    function records() {
      return state.order.map(function (qi, i) {
        var q = def.questions[qi];
        return { axis: q.axis, rev: q.rev, choice: state.answers[i] || null };
      });
    }

    function resetRun() {
      state.order = buildOrder(def.questions);
      state.pos = 0; state.answers = []; state.startedAt = Date.now();
    }

    /* ---- 开场 ---- */
    function renderIntro() {
      var saved = loadSave();
      var intro = def.intro;
      app.innerHTML =
        "<div class=\"card\">" +
        "<h1>" + esc(intro.h1) + "</h1>" +
        "<p class=\"muted\">" + esc(intro.sub) + "</p>" +
        "<p style=\"margin-top:14px\">" +
        intro.tags.map(function (t) { return "<span class=\"tag\">" + esc(t) + "</span>"; }).join("") +
        "</p>" +
        (intro.note ? "<p class=\"muted small\" style=\"margin-top:10px\">" + esc(intro.note) + "</p>" : "") +
        (saved
          ? "<button class=\"btn primary\" id=\"resume\">继续上次（第 " + (saved.pos + 1) + " 题）</button>" +
            "<button class=\"btn\" id=\"fresh\">重新开始</button>"
          : "<button class=\"btn primary\" id=\"start\">" + esc(intro.cta || "开始测试") + "</button>") +
        "<div class=\"foot\">" + intro.foot + "</div>" +
        "</div>" + crossHTML(def);

      var el = function (id) { return document.getElementById(id); };
      if (saved) {
        el("resume").onclick = function () {
          state.order = saved.order; state.pos = saved.pos;
          state.answers = saved.answers; state.startedAt = saved.startedAt;
          renderQuiz();
        };
        el("fresh").onclick = function () { resetRun(); save(); renderQuiz(); };
      } else {
        el("start").onclick = function () { resetRun(); save(); renderQuiz(); };
      }
    }

    /* ---- 答题 ---- */
    function renderQuiz() {
      var q = def.questions[state.order[state.pos]];
      var chosen = state.answers[state.pos];
      var total = def.questions.length;
      var pct = Math.round((state.pos / total) * 100);
      var d = dimOf(def, q.axis);

      app.innerHTML =
        "<div class=\"card\">" +
        "<div class=\"muted small\" style=\"display:flex;justify-content:space-between\">" +
        "<span>第 " + (state.pos + 1) + " / " + total + " 题</span><span>" + esc(d.desc || "") + "</span>" +
        "</div>" +
        "<div class=\"bar\" role=\"progressbar\" aria-valuemin=\"0\" aria-valuemax=\"" + total +
        "\" aria-valuenow=\"" + state.pos + "\" aria-label=\"答题进度\"><i style=\"width:" + pct + "%\"></i></div>" +
        "<p class=\"sr\" aria-live=\"polite\">第 " + (state.pos + 1) + " 题，共 " + total + " 题，已完成 " + pct + "%</p>" +
        "<div class=\"q\">" + esc(q.q) + "</div>" +
        "<button class=\"btn" + (chosen === "a" ? " picked" : "") + "\" data-v=\"a\" aria-pressed=\"" + (chosen === "a") + "\">" + esc(q.a) + "</button>" +
        "<button class=\"btn" + (chosen === "b" ? " picked" : "") + "\" data-v=\"b\" aria-pressed=\"" + (chosen === "b") + "\">" + esc(q.b) + "</button>" +
        "<button class=\"btn ghost" + (chosen === "n" ? " picked" : "") + "\" data-v=\"n\" aria-pressed=\"" + (chosen === "n") + "\">" + esc(def.skipLabel || "两个都不像，跳过") + "</button>" +
        (state.pos > 0 ? "<button class=\"btn ghost\" id=\"back\">← 上一题" + (chosen ? "（已答，可改）" : "") + "</button>" : "") +
        "</div>";

      Array.prototype.forEach.call(app.querySelectorAll("[data-v]"), function (btn) {
        btn.onclick = function () {
          state.answers[state.pos] = btn.getAttribute("data-v");
          if (state.pos === total - 1) { clearSave(); renderResult(); }
          else { state.pos += 1; save(); renderQuiz(); }
        };
      });
      var back = document.getElementById("back");
      if (back) back.onclick = function () { state.pos -= 1; save(); renderQuiz(); };
    }

    /* ---- 结果 ---- */
    function renderResult() {
      var r = compute(def, records());
      var t = def.types[r.code];
      if (!t) t = def.types[def.fallbackType];
      var elapsed = Math.round((Date.now() - state.startedAt) / 1000);
      var bandText = def.bandText || { middle: "中间型", lean: "倾向型", clear: "明确型" };

      var bars = r.axes.map(function (a) {
        var leftBold = a.pick === "left" ? "font-weight:700" : "";
        var rightBold = a.pick === "right" ? "font-weight:700" : "";
        var lname = a.left.name + (a.left.code ? " " + a.left.code : "");
        var rname = a.right.name + (a.right.code ? " " + a.right.code : "");
        return "<div class=\"dim\">" +
          "<div class=\"label\">" +
          "<span style=\"" + leftBold + "\">" + esc(lname) + " · " + a.leftPct + "%</span>" +
          "<span style=\"" + rightBold + "\">" + a.rightPct + "% · " + esc(rname) + "</span>" +
          "</div>" +
          "<div class=\"rail\"><span class=\"l\" style=\"width:" + a.leftPct + "%\"></span>" +
          "<span class=\"r\" style=\"width:" + a.rightPct + "%\"></span></div>" +
          "<div class=\"desc\">" + esc(a.desc) + " · " + bandText[a.band] + "</div></div>";
      }).join("");

      var middles = r.axes.filter(function (a) { return a.band === "middle"; });
      var conf = {
        high: "<div class=\"note ok\">作答质量良好：共 " + def.questions.length + " 题，只跳过 " + r.stat.neutral + " 题，答案分布也比较自然。</div>",
        medium: "<div class=\"note\">提示：跳过 " + r.stat.neutral + " 题" + (r.straight > 0.8 ? "，且选项集中在同一侧" : "") + "，结果可能有偏差。</div>",
        low: "<div class=\"note bad\">可信度偏低：跳过 " + r.stat.neutral + " 题" +
             (r.straight > 0.9 ? "，超过九成答案都在同一侧（可能没认真区分选项）" : "") +
             (elapsed < 60 ? "，全程只用了 " + elapsed + " 秒" : "") + "。建议重测一次。</div>",
      }[r.confidence];

      var midNote = middles.length
        ? "<div class=\"note\">" + middles.map(function (a) { return esc(a.left.name.replace(/低|高/g, "")) || esc(a.desc); }).join("、") +
          " 的差异不到 10%，属于<b>中间型</b>——这一项你比较灵活，别把自己钉死在某一边。</div>"
        : "";

      app.innerHTML =
        "<div class=\"card\">" +
        "<p class=\"muted\" style=\"margin-bottom:2px\">" + esc(def.resultKicker || "你的类型") + "</p>" +
        "<div class=\"type\">" + esc(t.big || r.code) + "</div>" +
        "<div class=\"type-name\">" + esc(t.name) + (t.tagline ? " · " + esc(t.tagline) : "") + "</div>" +
        conf + midNote + bars +
        t.blocks.map(blockHTML).join("") +
        "<div class=\"row\">" +
        "<button class=\"btn primary\" id=\"again\" style=\"flex:1\">重新测试</button>" +
        "<button class=\"btn\" id=\"copy\" style=\"flex:1;text-align:center\">复制结果</button></div>" +
        "<div class=\"foot\">" + esc(def.foot) + "<br>共 " + def.questions.length +
        " 题 · 跳过 " + r.stat.neutral + " 题 · 用时 " + elapsed + " 秒</div>" +
        "</div>" + crossHTML(def);

      document.getElementById("again").onclick = function () {
        clearSave(); resetRun(); renderIntro();
      };

      document.getElementById("copy").onclick = function () {
        var text = def.copyText
          ? def.copyText(r, t)
          : "我的结果：" + (t.big || r.code) + "（" + t.name + "）\n" +
            r.axes.map(function (a) {
              return a.left.name + "/" + a.right.name + "：" + a.leftPct + "% / " + a.rightPct + "%";
            }).join("\n") + "\n—— " + def.title;
        var btn = document.getElementById("copy");
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () { btn.textContent = "已复制"; },
            function () { window.prompt("长按复制：", text); });
        } else {
          window.prompt("长按复制：", text);
        }
      };
    }

    resetRun();
    renderIntro();

    return { state: state, renderQuiz: renderQuiz, renderResult: renderResult, renderIntro: renderIntro };
  }

  global.TestEngine = {
    start: start, compute: compute, buildOrder: buildOrder, esc: esc,
    score: function (def, choices) {
      return compute(def, def.questions.map(function (q, i) {
        return { axis: q.axis, rev: q.rev, choice: choices[i] };
      }));
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
