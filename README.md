# Veritas

Research beyond answers. Veritas is a multi-agent research platform: you ask a question, and a team of agents plans the work, searches the web, analyzes the findings, fact-checks key claims against the retrieved evidence, and writes a report where every claim is cited.

## Run it

```bash
npm install
cp .env.example .env     # then add GEMINI_API_KEY (free), OPENAI_API_KEY or ANTHROPIC_API_KEY
npm start
```

Open http://localhost:3000.

Without an API key, Veritas starts in demo mode with sample data, so you can explore the whole interface first.

## How it works

1. **Orchestrator** turns your question into 3 to 5 subtasks. You approve or edit them.
2. **Research** agents search the web in parallel (one per subtask) and extract findings with source URLs.
3. **Analysis** agent finds patterns, contradictions and gaps across the findings.
4. **Fact-checking** agent tests key claims against the retrieved evidence only.
5. **Writer** agent produces the final report with numbered citations.
6. You review and approve the report, then export it as PDF or Markdown.

## Project layout

```
server.js        Express server, plan endpoint and streaming run endpoint
agents.js        The five agents, plus demo mode
public/          Frontend (plain HTML, CSS, JS; no build step)
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Free key from aistudio.google.com/apikey. Uses Google Search grounding. |
| `OPENAI_API_KEY` | Uses OpenAI with its web search tool. |
| `ANTHROPIC_API_KEY` | Uses Claude with its web search tool. |
| `VERITAS_PROVIDER` | Force `gemini`, `openai` or `anthropic` when several keys are set. |
| `VERITAS_MODEL` | Model used by every agent. Defaults to `gemini-2.5-flash`, `gpt-4.1` or `claude-sonnet-5-5` by provider. |
| `PORT` | Server port. Defaults to 3000. |

Web search uses Anthropic's built-in web search tool, so no separate search API key is needed. It must be enabled for your organization in the Anthropic Console.

## Notes

- PDF export uses the browser's print dialog. Choose "Save as PDF".
- Fact-checking compares claims to the sources the research agents retrieved. It reduces errors but does not remove them, so open the sources for anything important.
