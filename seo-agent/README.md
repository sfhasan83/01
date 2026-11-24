# BAATS Accounting SEO agent

An AI agent with one job: get **baatsaccounting.com** to the top of search results in all 15 regions where BAATS Accounting is sold (UAE, Saudi Arabia, Bahrain, Oman, Qatar, Pakistan, India, Bangladesh, USA, Canada, Australia, New Zealand, UK, Europe and Türkiye).

It runs every Monday at 07:00 UAE time on Claude Managed Agents (Anthropic hosts the agent and its workspace, so nothing runs on your computer). Each run it:

1. Reads its notes from earlier runs (keywords it tracks, positions it saw, fixes it recommended).
2. Crawls the live site: every region page, the Arabic pages, robots.txt and the sitemap.
3. Researches each of the 15 regions in parallel: what people search for in English and the local language, who ranks on page one, and where BAATS appears.
4. Writes a weekly report with a scorecard per region and the top 10 actions, ready-to-paste fixes for each page, and content briefs for new local pages and guides.
5. Saves this week's numbers so next week's report shows what moved.

**The agent never changes the website.** It drafts; you (or whoever edits the site) review and apply. It follows Google's spam policies: no bought links, doorway pages or fake reviews.

## What's in this folder

| Path | What it is |
|---|---|
| [audit/2026-11-24-baseline-audit.md](audit/2026-11-24-baseline-audit.md) | First audit of the live site, with the 12 priority fixes. Start here. |
| [fixes/](fixes/) | Ready-to-paste homepage title, description and structured data, and a region page template |
| [agents/baats-seo/agent.md](agents/baats-seo/agent.md) | The agent: model, tools and instructions |
| [agents/baats-seo/skills/regional-seo-playbook/SKILL.md](agents/baats-seo/skills/regional-seo-playbook/SKILL.md) | The 15 regions: URLs, languages, tax terms, competitors, checklist |
| [agents/baats-seo/deployment-weekly.yaml](agents/baats-seo/deployment-weekly.yaml) | The Monday schedule, the per-run spending cap, and the checklist each report is graded against |
| [agents/baats-seo/environment.yaml](agents/baats-seo/environment.yaml) | The cloud workspace it runs in |
| [agents/baats-seo/memory_store-seo-history.yaml](agents/baats-seo/memory_store-seo-history.yaml) | Its memory between runs |

## Turn it on (one time, about 10 minutes)

You need an account on the Claude Developer Platform (platform.claude.com) with billing set up. The agent is billed per run: model tokens plus workspace time. Each run is capped at **US$25** in `deployment-weekly.yaml` (change `amount`, in cents, to raise or lower it).

1. Install the Anthropic CLI (`ant`), version 1.40 or later: see github.com/anthropics/anthropic-cli/releases (macOS: `brew install anthropics/tap/ant`).
2. Sign in: `ant auth login`
3. From this `seo-agent/` folder, preview what will be created:
   ```sh
   cd seo-agent
   ant apply --dry-run agents/baats-seo/deployment-weekly.yaml
   ```
   It should list one agent, one skill, one environment, one memory store and one deployment.
4. Create them: `ant apply agents/baats-seo/deployment-weekly.yaml` and answer `y`. This writes `claude-lock.json`; commit it so later changes update the same agent.
5. Run it once now instead of waiting for Monday:
   ```sh
   ant beta:deployments run --deployment-id "$(jq -r '.resources["./agents/baats-seo/deployment-weekly.yaml"].id' claude-lock.json)"
   ```
6. Watch it work and download the report from the session in the Claude Console (Managed Agents, then Sessions). The report and fixes are the session's output files.

To change what the agent does, edit `agent.md` or the playbook and run `ant apply` again. To pause the schedule: `ant beta:deployments pause --deployment-id <id>`.

## How it works

- **Model:** Claude Opus 5.5 at high effort.
- **Tools:** web search and web page fetching, plus a sandbox to write files.
- **Parallel research:** dynamic workflows are on, so each run can hand the 15 regions to 15 helper agents working in parallel, then combine their findings. Every helper uses tokens, which is why each run has a spending cap. To turn this off and have one agent work through the regions in turn, set `workflows: {type: disabled}` in `agent.md`.
- **Quality check:** each weekly report is graded against a 10-point checklist (all 15 regions covered, every tax fact sourced, fixes give exact before and after text, and so on) and revised up to 3 times until it passes.
- **Memory:** a memory store keeps ranking history and the action list between runs.

## Known limits and next steps

- Rankings from web search are an approximation. Connecting **Google Search Console** would give the agent real clicks and positions per country. That is the most valuable next step.
- The website's source code is not in this repository, so the agent drafts fixes but cannot apply them. If the site's code moves into a GitHub repo, the agent can be given access to open pull requests with the fixes for review.
