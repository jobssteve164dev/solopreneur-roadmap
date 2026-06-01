# SoloMap Product Hunt Launch Kit

This document contains the complete promotional package for launching SoloMap on Product Hunt, including the tagline, short description, key features checklist, and the primary Maker Comment.

---

## 🎨 Graphic Assets

You can use the three high-fidelity screenshots already stored in the `docs/` directory for your Product Hunt gallery:
1.  **Dashboard Cover**: [docs/assets/solomap_red_cover.png](../assets/solomap_red_cover.png) - Best as the main gallery image showing the full roadmap canvas.
2.  **Terminal Integration**: [docs/assets/solomap_red_terminal.png](../assets/solomap_red_terminal.png) - Shows the local AI CLI executing steps.
3.  **Local Storage Directory**: [docs/assets/solomap_red_local_first.png](../assets/solomap_red_local_first.png) - Visualizes the `.solopreneur/` folder inside VS Code.

---

## 📋 Launch Metadata

### 📌 Tagline (Max 60 characters)
> Local-first AI roadmaps & agent task orchestration in VS Code

### 📌 Description (Max 260 characters)
> Turn your project ideas into visual roadmaps and execute them using your local AI agent CLIs. SoloMap keeps all conversations, step memory, and code changes in your workspace under `.solopreneur/` for seamless Git-friendly progress tracking.

### 📌 Key Features Checklist
*   **Visual Canvas**: Turn ideas into interactive step-by-step roadmaps.
*   **Local Agent CLI Orchestration**: Integrate with Antigravity (`agy`), Claude Code, Codex, and more.
*   **Context-Aware Step Memory**: Structured task handoffs so agents never lose progress context.
*   **Git-Friendly**: Saved in CSV & SQLite under `.solopreneur/` with no cloud lock-in.

---

## ✍️ Maker Comment (The Launch Story)

> 💡 Paste the following markdown block as the first comment on your Product Hunt launch page.

***

Hey Product Hunt! 👋

I'm super excited to share **SoloMap** with you today! 🚀

As a solopreneur and developer, I kept running into the same problems when trying to use AI tools to build my projects:
1.  **Cloud Lock-in & Costs**: Constantly paying subscription fees for cloud-based AI tools where I don’t own the execution flow.
2.  **Context Fragmentation**: Dispatched AI agents frequently "forget" the broader roadmap context or what they did in the previous step.
3.  **Data Privacy**: Reluctance to upload proprietary codebase directories or idea drafts to external databases.

That’s why I built SoloMap: a **local-first AI roadmap and agent task coordinator** that lives entirely inside VS Code.

### How it works:
1.  **Initialize**: Run the extension, choose a project folder, and SoloMap creates a starter roadmap node.
2.  **Generate & Refine**: Let your local agent CLI (like Antigravity `agy`, Claude Code, or Codex) modify and write the real `roadmap.csv` in your folder.
3.  **Execute**: Expand any roadmap node to launch a dedicated conversation in VS Code’s integrated terminal.
4.  **Handoff Memory**: The extension writes a lightweight handoff file (`.solopreneur/step-memory/<nodeId>.json`) detailing file changes and completions. Future runs read this memory so your local agent is always fully aligned with prior progress.

### Why local-first?
By keeping roadmaps, SQLite logs, and step session histories inside your project folder under `.solopreneur/`, you can **commit your agent environment to Git**. Your workspace state moves with your code. You can switch computers, review diffs, and work completely offline without relying on a remote SaaS database.

SoloMap is free, open-source, and built to empower indie hackers to build, deliver, and iterate with confidence.

I’d love to hear your feedback, feature ideas, and thoughts in the comments. Let's make local-first AI development seamless together! 💻

Happy building,
The SoloMap Team

***
