const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = { query: "", plan: null, report: null };

/* ---------- views ---------- */
function show(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.body.classList.toggle("in-flow", name !== "home");
  $("#newBtn").hidden = name === "home";
  window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ---------- home ---------- */
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    $("#modeHint").textContent = s.demo ? "Demo mode: add an API key for live research" : "";
  })
  .catch(() => {});

$("#brand").addEventListener("click", (e) => { e.preventDefault(); show("home"); });
$("#newBtn").addEventListener("click", () => { $("#query").value = ""; show("home"); $("#query").focus(); });
$("#navAgents").addEventListener("click", (e) => jump(e, "agents"));
$("#navProcess").addEventListener("click", (e) => jump(e, "process"));
function jump(e, id) {
  e.preventDefault();
  show("home");
  requestAnimationFrame(() => document.getElementById(id).scrollIntoView({ behavior: "smooth" }));
}

$$("#examples button").forEach((b) =>
  b.addEventListener("click", () => {
    $("#query").value = b.textContent;
    $("#query").focus();
  })
);

$("#query").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#askForm").requestSubmit();
  }
});

$("#askForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = $("#query").value.trim();
  if (query.length < 5) return;
  const btn = $("#askBtn");
  btn.disabled = true;
  btn.textContent = "Planning…";
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not build a plan.");
    state.query = query;
    state.plan = data;
    renderPlan();
    show("plan");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Plan research";
  }
});

/* ---------- plan editor ---------- */
function renderPlan() {
  $("#planQuery").textContent = state.query;
  const list = $("#planList");
  list.innerHTML = "";
  state.plan.subtasks.forEach((t, i) => list.appendChild(taskEl(t, i)));
  $("#planError").hidden = true;
}

function taskEl(t, i) {
  const el = document.createElement("div");
  el.className = "task";
  el.innerHTML = `
    <input aria-label="Subtask title" value="${esc(t.title)}" placeholder="Subtask title">
    <textarea aria-label="Subtask description" rows="2" placeholder="What should the research agent find out?">${esc(t.description)}</textarea>
    <button class="remove" type="button" aria-label="Remove subtask">×</button>`;
  $("input", el).addEventListener("input", (e) => (state.plan.subtasks[i].title = e.target.value));
  $("textarea", el).addEventListener("input", (e) => (state.plan.subtasks[i].description = e.target.value));
  $(".remove", el).addEventListener("click", () => {
    state.plan.subtasks.splice(i, 1);
    renderPlan();
  });
  return el;
}

$("#addTask").addEventListener("click", () => {
  if (state.plan.subtasks.length >= 8) return;
  state.plan.subtasks.push({ id: Date.now(), title: "", description: "" });
  renderPlan();
  const inputs = $$("#planList input");
  inputs[inputs.length - 1].focus();
});

$("#approvePlan").addEventListener("click", () => {
  const tasks = state.plan.subtasks.filter((t) => t.title.trim());
  if (!tasks.length) {
    $("#planError").textContent = "Keep at least one subtask so the agents have something to research.";
    $("#planError").hidden = false;
    return;
  }
  state.plan.subtasks = tasks.map((t, i) => ({ ...t, id: i + 1, title: t.title.trim(), description: t.description.trim() }));
  startRun();
});

/* ---------- run ---------- */
const STAGE_LABEL = { research: "Searching the web", analysis: "Comparing sources", factcheck: "Checking claims", writer: "Writing the report" };

function resetPipeline() {
  $$("#pipeline > li").forEach((li) => {
    li.classList.remove("active", "done");
    $(".detail", li).textContent = "Waiting";
  });
  const tl = $("#taskList");
  tl.innerHTML = state.plan.subtasks.map((t) => `<li data-task="${t.id}">${esc(t.title)}</li>`).join("");
  $("#runError").hidden = true;
  $("#runErrorActions").hidden = true;
}

async function startRun() {
  $("#runTitle").textContent = state.plan.title || state.query;
  resetPipeline();
  show("run");
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: state.query, plan: state.plan }),
    });
    if (!res.ok || !res.body) throw new Error("The server could not start the run.");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let finished = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (handleEvent(ev)) finished = true;
      }
    }
    if (!finished && $("#runError").hidden) throw new Error("The connection closed before the report was finished.");
  } catch (err) {
    showRunError(err.message);
  }
}

function handleEvent(ev) {
  if (ev.type === "stage") {
    const li = $(`#pipeline > li[data-stage="${ev.stage}"]`);
    li.classList.toggle("active", ev.status === "active");
    li.classList.toggle("done", ev.status === "done");
    $(".detail", li).textContent = ev.status === "active" ? STAGE_LABEL[ev.stage] : ev.detail || "Done";
  } else if (ev.type === "task") {
    const li = $(`#taskList li[data-task="${ev.id}"]`);
    if (li) li.className = ev.status;
  } else if (ev.type === "done") {
    state.report = ev.report;
    renderReport();
    show("report");
    return true;
  } else if (ev.type === "error") {
    showRunError(ev.message);
  }
  return false;
}

function showRunError(msg) {
  $("#runError").textContent = `${msg} Nothing was lost: your plan is still saved.`;
  $("#runError").hidden = false;
  $("#runErrorActions").hidden = false;
}
$("#retryRun").addEventListener("click", startRun);

/* ---------- markdown ---------- */
function inline(s) {
  return esc(s)
    .replace(/\[S(\d+)\]/g, '<sup class="cite"><a href="#src-$1" aria-label="Source $1">$1</a></sup>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function md(src) {
  const out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`</${list}>`); list = null; };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      const level = Math.max(2, m[1].length);
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== "ul") { flushList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== "ol") { flushList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  return out.join("\n");
}

/* ---------- report ---------- */
const VERDICT = { supported: "Supported", partial: "Partly supported", unsupported: "Not supported", contradicted: "Contradicted" };

function renderReport() {
  const r = state.report;
  $("#reportTitle").textContent = r.title || state.query;
  const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  $("#reportMeta").textContent = `${date}  ·  ${r.sources.length} sources  ·  ${r.checks.length} claims checked`;
  $("#reportBody").innerHTML = md(r.markdown);

  $("#factbox").hidden = !r.checks.length;
  $("#checkList").innerHTML = r.checks
    .map((c) => {
      const v = VERDICT[c.verdict] ? c.verdict : "partial";
      const refs = (c.sources || []).map((n) => `<sup class="cite"><a href="#src-${n}">${n}</a></sup>`).join("");
      return `<div class="check"><span class="verdict ${v}">${VERDICT[v]}</span>
        <p class="claim">${esc(c.claim)}</p><p class="why">${esc(c.evidence)} ${refs}</p></div>`;
    })
    .join("");

  $("#sourceList").innerHTML = r.sources
    .map(
      (s) => `<li id="src-${s.id}"><span class="num">${s.id}</span>
        <div><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><small>${esc(s.domain)}</small></div></li>`
    )
    .join("");

  $("#reviewBar").hidden = false;
  $("#exportBar").hidden = true;
}

$("#approveReport").addEventListener("click", () => {
  $("#reviewBar").hidden = true;
  $("#exportBar").hidden = false;
});

function fileName(ext) {
  const slug = (state.report.title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `veritas-${slug || "report"}.${ext}`;
}

$("#exportMd").addEventListener("click", () => {
  const r = state.report;
  const checks = r.checks.length
    ? "\n\n## Fact check\n\n" +
      r.checks.map((c) => `- **${VERDICT[c.verdict] || c.verdict}:** ${c.claim} ${c.evidence}`).join("\n")
    : "";
  const sources = "\n\n## Sources\n\n" + r.sources.map((s) => `${s.id}. [${s.title}](${s.url})`).join("\n");
  const body = `# ${r.title}\n\n${r.markdown}${checks}${sources}\n`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
  a.download = fileName("md");
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#exportPdf").addEventListener("click", () => {
  const prev = document.title;
  document.title = fileName("pdf").replace(/\.pdf$/, "");
  window.print();
  document.title = prev;
});
