---
title: "How to Use AI to Do Proper Research"
date: 2026-11-21
authors: ["director", "core-aix-agent"]
summary: "Five principles for AI-assisted research, the points at which human judgement remains essential, and habits for getting started."
---

**TL;DR.** Reliable research with AI depends on the setup around the agent more than on the prompts:

- Work in a coding agent inside the project's repository instead of a chatbot website, since its harness lets the agent run and check the work.
- Record every session with [aGiTrack](https://agitrack.core-aix.org), so that every change has a traceable reason.
- Have fresh-context subagents and models from other providers check every important result.
- Turn recurring corrections into skills built from your own history.
- Keep the judgement, the integrity, and the signature on the paper with the human.

AI coding agents can now carry out a large share of the work in a research project, from running experiments to revising a paper. The difficulty is to make that work reliable enough to put a name on. This post sets out five principles for doing so, the points at which a human has to step in, and a few habits for getting started.

The principles were distilled by the CORE-AIx Agent from aGiTrack records of our own research sessions with current models. These models are much more capable than those of even a few months ago, so older advice on working with AI is a poor guide.

## 1. Use a Coding Agent Instead of a Chatbot Website

Research with AI belongs in a coding agent that runs inside the project's git repository, such as [Claude Code](https://claude.com/claude-code) or [Codex](https://github.com/openai/codex), instead of a chatbot website. The model behind both can be the same. The difference is the harness around the model, and the harness is what makes the work reliable. A coding agent offers the following:

- **Real files.** The agent opens the paper source, the code, and the raw results directly. Nothing is lost in copying and pasting, and nothing is recalled from memory if it is available on disk.
- **Self-checks.** The agent runs the analysis scripts, compiles the LaTeX, and inspects screenshots of the PDF. For example, it can rebuild a table with the paper's own settings and check the layout on the rendered page. Chatbot websites can run code on uploaded files, but they lack the whole project together with its build and its history.
- **Traceable numbers.** Every number in the paper can be regenerated from saved results by a script, so the tables change whenever a result changes. A critic agent can also check that the code matches every claim in the paper.
- **Real experiments.** The agent connects to a compute cluster, submits jobs, monitors utilisation, and copies results back. Long jobs run detached and resumable, so they survive a laptop that loses its connection.
- **Reversible edits.** Every step is a commit, so a bad edit to the paper or the code costs little to undo. A wasted compute job cannot be undone, which is why budgets matter.
- **Other agents.** The agent can start subagents, which makes the cross-checks in Principles 3 and 4 possible.

A chatbot produces text that then has to be trusted. A coding agent produces changes to real files that can be run, compared, and checked. In research, where an error is the main risk, this difference matters most.

## 2. Track Every Session with aGiTrack

Every session with a coding agent should be recorded, and aGiTrack does this automatically. aGiTrack is a tool built at CORE-AIx ([introduced here](/blog/introducing-agitrack/)) that commits the agent's changes after every turn, together with the request and a summary of what the agent did. The record turns a long collaboration with an agent into a searchable history, which has three uses:

- **Reasons for changes.** A question such as why a design choice changed weeks earlier has an answer in the log.
- **Fast handover.** A collaborator who takes over the work can catch up from the commit messages. The same holds for a critic that checks whether its earlier comments have been addressed.
- **Learning from your own work.** This post was distilled from such records of our own research sessions, and the same history is the raw material for skills (Principle 5).

## 3. Cross-Check with Loops of Fresh-Context Subagents

The agent that produced a piece of work is poorly placed to judge it. It remembers its own reasoning, so it sees what it intended instead of what is on the page. The remedy is to separate the roles and give the critic a fresh context. The most useful pattern is a critic-editor loop:

1. A critic subagent with a fresh context examines the paper, the code, or an analysis from a stated perspective. It reports issues in detail and does not edit.
2. An editor subagent fixes the issues, after revisiting your style rules in every round.
3. The changes are committed, and the loop repeats until the critic raises no new major issue or the round limit is reached.

A quiet critic is not a proof. For a central claim, a human should still check the decisive proof step, and the agent should reproduce the key numbers from the saved data.

Four details make the loop much more effective:

- **Distinct roles.** Several critics with different roles can run in parallel. For example, a mathematician checks that every proof uses only elementary steps, and an undergraduate student flags every unclear passage. A verifier checks every reference against online sources, and a single editor then applies the changes.
- **No history for a first critique.** A critic that judges the paper should not see the authors' reasoning, since that reasoning steers it. An instruction not to assume knowledge of the project's history helps, because the peer reviewers of the paper lack that history as well.
- **A cap on rounds.** A limit of 5 or 10 rounds keeps the loop honest. If a loop has not converged after 5 rounds, something is wrong, and a human should step in instead of spending more.
- **A check of the critique.** Critics make mistakes too, so a separate subagent should check whether each comment makes sense before it is fixed. This happened during the preparation of this post. A critic reported that a quotation from our own research sessions was fabricated, and a check against the transcript showed that the quotation was real.

## 4. Cross-Check Across Providers

Models from the same provider tend to share blind spots, so a model from a different provider should check the work wherever possible. For example, Claude can produce and revise the work while GPT in Codex acts as an independent critic. The two models do not communicate directly, and the repository serves as the interface:

1. The GPT critic records a detailed critique in a Markdown file and commits it.
2. Claude checks each point, fixes the points that hold, and records a response file.
3. The GPT critic examines the responses together with the commits and produces a follow-up critique.

This arrangement catches real errors. A critic from a second provider can find mistakes in proofs that the strongest model of the first provider has already checked. For example, it can show with a concrete counterexample that a statement fails on part of its stated domain. A second provider is not guaranteed to outperform another fresh pass by the same model. Even so, its counterexamples can be checked directly, and the cost is small.

The same principle applies within a single provider by assigning models by role. The strongest reasoning model handles the hardest reasoning, such as proofs, and a capable but cheaper model handles most of the subagent work.

## 5. Build Skills from Your Own History

Many corrections to an agent recur, and each recurring correction should become a rule. Typical examples of such corrections are "define every symbol before its first use" and "keep every figure caption short". The second time a correction is needed, the agent should record it, with a prompt such as the following:

- "Please generalise this and add it to my style skill."
- "Record this as a rule in your memory."
- "Please record this method in AGENTS.md."

Over time, these rules become skills, which are files of instructions that the agent loads whenever a task needs them. For example, every editor subagent can load a style skill before it changes the text. Skills are most valuable if they encode your own standards, so copying the skills of another researcher helps little.

The fastest way to build a skill is to let the agent build it from your history, which aGiTrack already holds. The prompt below is a good starting point.

> Go through my session history and commit messages from the last month. Find the corrections that I made more than once and the working methods that I kept asking for. Draft a skill that would have made those corrections unnecessary, and show it to me before saving it.

After that, use the skill, keep correcting, and repeat the process each month.

## Where Humans Have to Step In

Agents can carry out most of the labour, but the decisions that change the outcome of a project remain with the human. These decisions form 6 groups.

**Suspicious results.** Knowing what a plausible result looks like is the most effective check on an agent. For example, baselines that appear to fail completely usually point to a bug in their implementation instead of a strong method. The same suspicion applies to a figure that contradicts a table. It also applies to a derivation whose conclusion seems too convenient.

**Integrity and fairness.** An agent carries out whatever it is asked to do, including a bad idea, so the integrity check rests with the human. Filtering benchmark data to suit a method amounts to manipulation, and the full benchmark should be used instead. An optimisation that only the proposed method receives invites the question of why the baselines did not receive it. The settings of the baselines deserve the same care as the settings of the proposed method.

**Framing.** An agent produces strong text within a given frame, but the choice of frame remains a human task. Examples include scoping a problem so that it matters in practice and making sure that the novelty is more than a combination of existing work.

**Understanding.** Asking "what does this mean?" whenever something is unclear is among the most valuable prompts. If the human cannot understand a sentence, a table, or a proof step, a peer reviewer probably cannot either, and insisting on understanding improves the agent's work.

**Real-world constraints.** An agent knows the constraints of the physical world only if it is told about them. Examples include a compute budget, a deadline, and shared hardware that is unavailable at certain times.

**Scope and stopping.** Agents frequently give good recommendations on what to keep and when to stop, and asking for them helps. Still, decisions such as which benchmarks are in scope or when to stop an experiment concern the paper as a whole and belong to the human. Such decisions should follow a rule that can be stated, e.g., whether a benchmark can test the claim. A benchmark excluded for that reason is reported in the paper as a limitation.

### The Most Useful Human Inputs

The following inputs help an agent the most:

- **Specific corrections with a reason.** A correction that carries its reason can become a general rule.
- **Constraints up front.** Page limits, compute budgets, and the maximum number of loop rounds belong in the first prompt.
- **Hunches from domain knowledge.** A pointer to the known result that probably explains an observation can set the direction of a whole analysis.
- **Context that only the human has.** Meeting notes, comments from collaborators, and peer reviews give the agent information that it cannot find elsewhere.
- **Edits by example.** A paragraph revised by the human, together with an instruction to match its language and granularity, conveys more than a page of instructions.
- **Questions instead of commands.** A question such as why a method performs better than expected can lead to a deeper analysis than an instruction.

### Skills That Humans Will Need

As agents take on more of the labour, the following human skills gain importance:

- **Judgement and taste.** Taste lets a researcher recognise a good question, a convincing result, and a clear paper.
- **Verification literacy.** Verifying work requires the ability to follow a proof, notice a suspicious number, and tell a real effect from noise. Mathematics that a researcher does not understand cannot be judged, so the fundamentals matter more than before.
- **Problem framing.** Deciding what is worth solving and how to scope it remains a human responsibility.
- **Specification and delegation.** A good brief lets a capable colleague without context act on it, and a good loop checks the work that results.
- **Integrity and accountability.** The human signs the paper and answers for it, and the agent does neither.

## Getting Started

The following habits make a good start for researchers who mainly use AI through a chatbot website:

1. **Install a coding agent this week** and open it in the git repository of a current project. Begin with a task that has a clear check, such as the prompt below.

   > Find the script and the saved data behind Figure 1. Tell me the command that rebuilds it, run it, and show me the output so that I can compare it with the paper.

2. **Put the project in git**, including the paper source, the code, the scripts, and small result files. Large datasets need a note on where they are stored and which version was used. After that, [install aGiTrack](https://agitrack.core-aix.org) so that every session is recorded, and check what it records before working with confidential material.
3. **Create a short `AGENTS.md`** (or `CLAUDE.md`) that states the goal and the folder layout. The file also describes how to build and run the project and lists the main conventions.
4. **Follow a two-strikes rule.** The second time the same correction is needed, ask the agent to record it as a rule.
5. **Have every important result checked by an agent other than its producer.** Ask for a fresh-context critic with a stated role. For a proof or an experiment plan, also ask a model from another provider.
6. **Ask "what does this mean?"** whenever something is unclear, and ask for plain words. Text that the human does not understand should stay out of the paper.
7. **Set budgets and caps in the first prompt**, e.g., the maximum number of loop rounds, the compute hours, and the API spend.
8. **Verify every citation** against online sources with a dedicated subagent before submission.

Further habits can follow once these feel natural. Long jobs should run detached and resumable, and handovers to collaborators can take the form of GitHub issues that both humans and fresh agents can follow. A monthly session in which the agent goes through your history and proposes updates to your skills keeps the skills current.

## Closing

Research with AI depends less on asking a chatbot better questions than on the setup around the agent. That setup combines a harness that can check the work, cross-checks by fresh agents and other models, and a record that supports learning. The human contributes the questions, the judgement, and the integrity, and these contributions grow in importance as agents take on more. In the end, the human still signs the paper.
