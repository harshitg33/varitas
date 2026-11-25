import Anthropic from "@anthropic-ai/sdk";

// Provider: set VERITAS_PROVIDER (gemini | openai | anthropic) to force one.
// Otherwise the first key found is used, in that order. No key means demo mode.
function pickProvider() {
  const forced = (process.env.VERITAS_PROVIDER || "").toLowerCase();
  const keys = {
    gemini: process.env.GEMINI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
  };
  if (forced && keys[forced]) return forced;
  return ["gemini", "openai", "anthropic"].find((p) => keys[p]) || "demo";
}
export const PROVIDER = pickProvider();
export const DEMO = PROVIDER === "demo";
const DEFAULT_MODELS = { gemini: "gemini-2.5-flash", openai: "gpt-4.1", anthropic: "claude-sonnet-5-5" };
export const MODEL = process.env.VERITAS_MODEL || DEFAULT_MODELS[PROVIDER] || "demo";
const client = PROVIDER === "anthropic" ? new Anthropic() : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- helpers ---------- */

async function ask(opts) {
  if (PROVIDER === "gemini") return askGemini(opts);
  if (PROVIDER === "openai") return askOpenAI(opts);
  return askAnthropic(opts);
}

async function askGemini({ system, prompt, maxTokens = 4000, search }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens * 2,
      ...(MODEL.includes("flash") ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    },
    ...(search ? { tools: [{ google_search: {} }] } : {}),
  };
  // Free tier is rate limited, so retry a few times on 429 / 503.
  let data;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    data = await res.json();
    if (res.ok) break;
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await sleep(4000 * (attempt + 1));
      continue;
    }
    throw new Error(data?.error?.message || `Gemini request failed (${res.status})`);
  }
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned an empty response" + (cand?.finishReason ? ` (${cand.finishReason})` : ""));
  const found = [];
  for (const c of cand?.groundingMetadata?.groundingChunks || []) {
    if (c.web?.uri) found.push({ url: c.web.uri, title: c.web.title || c.web.uri });
  }
  return { text, found };
}

async function askOpenAI({ system, prompt, maxTokens = 4000, search }) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      instructions: system,
      input: prompt,
      max_output_tokens: maxTokens,
      ...(search ? { tools: [{ type: "web_search" }] } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI request failed (${res.status})`);
  let text = "";
  const found = [];
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part.type !== "output_text") continue;
      text += part.text;
      for (const a of part.annotations || []) {
        if (a.type === "url_citation" && a.url) found.push({ url: a.url, title: a.title || a.url });
      }
    }
  }
  return { text, found };
}

async function askAnthropic({ system, prompt, maxTokens = 4000, search }) {
  const tools = search ? [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }] : undefined;
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
    ...(tools ? { tools } : {}),
  });
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const found = [];
  for (const b of res.content) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const r of b.content) if (r.url) found.push({ url: r.url, title: r.title || r.url });
    }
    if (b.type === "text" && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c.url) found.push({ url: c.url, title: c.title || c.url });
    }
  }
  return { text, found };
}

function parseJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Agent returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/* ---------- orchestrator ---------- */

export async function makePlan(query) {
  if (DEMO) {
    await sleep(900);
    return demoPlan(query);
  }
  const { text } = await ask({
    system:
      "You are the Orchestrator of a research team. Break a research question into 3 to 5 focused, non-overlapping subtasks that together answer it. Respond with JSON only.",
    prompt: `Research question: ${query}

Return JSON in exactly this shape:
{"title": "short report title", "subtasks": [{"title": "short title", "description": "one sentence on what to find out"}]}`,
    maxTokens: 1200,
  });
  const plan = parseJSON(text);
  plan.subtasks = (plan.subtasks || []).slice(0, 6).map((s, i) => ({ id: i + 1, ...s }));
  return plan;
}

/* ---------- pipeline ---------- */

export async function runPipeline({ query, plan, emit }) {
  if (DEMO) return demoPipeline({ query, plan, emit });

  const sources = []; // {id, url, title}
  const sourceId = (url, title) => {
    let s = sources.find((x) => x.url === url);
    if (!s) {
      s = { id: sources.length + 1, url, title: title || host(url), domain: host(url) };
      sources.push(s);
    }
    return s.id;
  };

  /* Research agent: one search pass per subtask, run in parallel */
  emit({ type: "stage", stage: "research", status: "active" });
  const findings = []; // {subtask, claim, sourceId}
  await Promise.all(
    plan.subtasks.map(async (task) => {
      emit({ type: "task", id: task.id, status: "active" });
      try {
        const { text, found } = await ask({
          system:
            "You are the Research agent. Use web search to find reliable, current information. Prefer primary sources, official data, and reputable publications. Report only what the sources say.",
          prompt: `Overall question: ${query}
Your subtask: ${task.title}. ${task.description}

Search the web, then respond with JSON only:
{"findings": [{"claim": "one specific, self-contained factual statement in your own words", "url": "the source URL it came from"}]}
Give 4 to 8 findings.`,
          maxTokens: 3000,
          search: true,
        });
        const titles = new Map(found.map((f) => [f.url, f.title]));
        const data = parseJSON(text);
        const pool = found.length ? found : [];
        for (const [i, f] of (data.findings || []).entries()) {
          if (!f.claim) continue;
          // Gemini grounding links are redirect URLs, so if the model gave a URL we cannot match, fall back to a retrieved source.
          let url = f.url;
          if (PROVIDER === "gemini" && pool.length && !titles.has(url)) url = pool[i % pool.length].url;
          if (!url) continue;
          findings.push({ task: task.title, claim: f.claim, sourceId: sourceId(url, titles.get(url)) });
        }
        emit({ type: "task", id: task.id, status: "done" });
      } catch (err) {
        emit({ type: "task", id: task.id, status: "failed", detail: err.message });
      }
    })
  );
  if (!findings.length) throw new Error("The research agent could not retrieve any sources. Try rephrasing your question.");
  emit({ type: "stage", stage: "research", status: "done", detail: `${sources.length} sources, ${findings.length} findings` });

  const evidence = findings.map((f) => `[S${f.sourceId}] (${f.task}) ${f.claim}`).join("\n");

  /* Analysis agent */
  emit({ type: "stage", stage: "analysis", status: "active" });
  let analysis = { patterns: [], contradictions: [], gaps: [] };
  try {
    const { text } = await ask({
      system:
        "You are the Analysis agent. You study retrieved evidence to find patterns, contradictions between sources, and gaps. Use only the evidence provided.",
      prompt: `Question: ${query}

Evidence:
${evidence}

Respond with JSON only:
{"patterns": ["..."], "contradictions": [{"topic": "...", "detail": "...", "sources": [1,2]}], "gaps": ["..."]}
Cite sources by number. Be concise; list nothing you cannot ground in the evidence.`,
      maxTokens: 2500,
    });
    analysis = { ...analysis, ...parseJSON(text) };
  } catch (err) {
    emit({ type: "log", message: "Analysis agent returned partial results." });
  }
  emit({
    type: "stage",
    stage: "analysis",
    status: "done",
    detail: `${analysis.patterns.length} patterns, ${analysis.contradictions.length} contradictions`,
  });

  /* Fact-checking agent */
  emit({ type: "stage", stage: "factcheck", status: "active" });
  let checks = [];
  try {
    const { text } = await ask({
      system:
        "You are the Fact-Checking agent. Pick the most important claims and test each one against the retrieved evidence only. Do not use outside knowledge. If the evidence does not support a claim, say so.",
      prompt: `Question: ${query}

Evidence:
${evidence}

Analysis notes:
${JSON.stringify(analysis)}

Choose up to 8 key claims that a report on this question would rely on. Respond with JSON only:
{"checks": [{"claim": "...", "verdict": "supported" | "partial" | "unsupported" | "contradicted", "evidence": "one sentence explaining the verdict", "sources": [1]}]}`,
      maxTokens: 3000,
    });
    checks = parseJSON(text).checks || [];
  } catch (err) {
    emit({ type: "log", message: "Fact-checking agent returned partial results." });
  }
  const ok = checks.filter((c) => c.verdict === "supported").length;
  emit({ type: "stage", stage: "factcheck", status: "done", detail: `${ok} of ${checks.length} claims fully supported` });

  /* Writer agent */
  emit({ type: "stage", stage: "writer", status: "active" });
  const { text: markdown } = await ask({
    system:
      "You are the Writer agent. You write clear, well-structured research reports in Markdown. Every factual statement carries a citation like [S3]. Put multiple citations side by side like [S1][S4]. Never cite a source number that is not in the evidence. Do not use tables. Treat unsupported or contradicted claims honestly: leave them out or flag them as uncertain.",
    prompt: `Write the final report.

Question: ${query}
Report title: ${plan.title}

Evidence:
${evidence}

Analysis:
${JSON.stringify(analysis)}

Fact-check results:
${JSON.stringify(checks)}

Structure: a one-paragraph summary under "## Summary", then 3 to 5 sections with "##" headings that follow the research plan, then "## Open questions" noting gaps and contradictions. Use clear prose, with bullets only where they help. Do not include a sources list; it is added automatically. Do not repeat the report title as a heading.`,
    maxTokens: 5000,
  });
  emit({ type: "stage", stage: "writer", status: "done" });

  return { title: plan.title, markdown: markdown.trim(), sources, checks, analysis };
}

/* ---------- demo mode (no API key) ---------- */

function demoPlan(query) {
  const topic = query.length > 70 ? query.slice(0, 67) + "…" : query;
  return {
    title: topic.charAt(0).toUpperCase() + topic.slice(1).replace(/\?+$/, ""),
    subtasks: [
      { id: 1, title: "Background and definitions", description: "Establish what the topic covers and how it is commonly defined." },
      { id: 2, title: "Current state of evidence", description: "Collect the most recent data, studies, and reporting." },
      { id: 3, title: "Competing viewpoints", description: "Find where credible sources disagree and why." },
      { id: 4, title: "Implications and next steps", description: "Summarise what the findings mean in practice." },
    ],
  };
}

async function demoPipeline({ query, plan, emit }) {
  const sources = [
    { id: 1, title: "Overview from a national statistics office", url: "https://example.org/overview", domain: "example.org" },
    { id: 2, title: "Peer-reviewed meta-analysis, 2026", url: "https://example.edu/meta-analysis", domain: "example.edu" },
    { id: 3, title: "Industry report on recent developments", url: "https://example.com/industry-report", domain: "example.com" },
    { id: 4, title: "Independent commentary and critique", url: "https://example.net/commentary", domain: "example.net" },
  ];
  emit({ type: "stage", stage: "research", status: "active" });
  for (const t of plan.subtasks) {
    emit({ type: "task", id: t.id, status: "active" });
    await sleep(700);
    emit({ type: "task", id: t.id, status: "done" });
  }
  emit({ type: "stage", stage: "research", status: "done", detail: "4 sources, 14 findings (demo data)" });

  emit({ type: "stage", stage: "analysis", status: "active" });
  await sleep(1100);
  emit({ type: "stage", stage: "analysis", status: "done", detail: "3 patterns, 1 contradiction" });

  emit({ type: "stage", stage: "factcheck", status: "active" });
  await sleep(1100);
  const checks = [
    { claim: "Recent studies broadly agree on the direction of the trend.", verdict: "supported", evidence: "Both the meta-analysis and the statistics office report the same direction.", sources: [1, 2] },
    { claim: "The size of the effect is settled.", verdict: "partial", evidence: "Estimates differ between the industry report and the meta-analysis.", sources: [2, 3] },
    { claim: "Critics have no empirical basis for their concerns.", verdict: "contradicted", evidence: "The commentary cites data that the other sources do not address.", sources: [4] },
  ];
  emit({ type: "stage", stage: "factcheck", status: "done", detail: "1 of 3 claims fully supported" });

  emit({ type: "stage", stage: "writer", status: "active" });
  await sleep(1200);
  const markdown = `## Summary

This is a demo report. Add your Anthropic API key to a \`.env\` file and VERITAS will search the live web and write a real, cited report for **"${query}"**. The layout, citations and fact-check panel you see here are exactly what a real run produces.

## Background and definitions

Reports begin by establishing shared definitions, so every later claim rests on the same ground [S1]. Where sources define a term differently, the report says so instead of picking one quietly.

## Current state of evidence

The strongest recent evidence points in a consistent direction [S1][S2]. Estimates of the size of the effect vary, and the industry data is more optimistic than the academic work [S3].

## Competing viewpoints

Independent commentators dispute the framing used by the industry report and cite data it leaves out [S4]. The fact-checking agent flags claims that rely on one side only.

## Implications and next steps

Readers should treat the direction of the trend as well supported and the exact magnitude as open [S2][S3].

## Open questions

The sources disagree on the size of the effect, and none of them cover long-term outcomes.`;
  emit({ type: "stage", stage: "writer", status: "done" });
  return { title: plan.title, markdown, sources, checks, analysis: { patterns: [], contradictions: [], gaps: [] } };
}
