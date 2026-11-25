import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO, MODEL, PROVIDER, makePlan, runPipeline } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (_req, res) => res.json({ demo: DEMO, model: MODEL }));

app.post("/api/plan", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  if (query.length < 5) return res.status(400).json({ error: "Enter a longer research question." });
  try {
    res.json(await makePlan(query));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "The orchestrator could not build a plan. " + err.message });
  }
});

app.post("/api/run", async (req, res) => {
  const query = String(req.body?.query || "").trim();
  const plan = req.body?.plan;
  if (!query || !plan?.subtasks?.length) return res.status(400).json({ error: "Missing query or plan." });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const report = await runPipeline({ query, plan, emit });
    emit({ type: "done", report });
  } catch (err) {
    console.error(err);
    emit({ type: "error", message: err.message });
  }
  res.end();
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`VERITAS running at http://localhost:${port}`);
  if (DEMO) console.log("No API key found: running in demo mode with sample data.");
  else console.log(`Using ${PROVIDER} (${MODEL})`);
});
