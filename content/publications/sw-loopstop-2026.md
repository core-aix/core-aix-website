---
title: "Quality-Blind Detection of Settling in Agentic AI Loops"
slug: "sw-loopstop-2026"
url: "/papers/SW_LoopStop2026.html"
date: 2026-10-08
authors:
  - "Shiqiang Wang"
  - "Herbert Woisetschläger"
venue: "Preprint"
venue_type: "preprint"
pdf: "/papers/SW_LoopStop2026.pdf"
abstract: "In an agentic AI loop, a generator proposes a change, an evaluator accepts or rejects it, the accepted change is applied, and the cycle repeats. The loop usually cannot see the true quality of what it produces, so practitioners often give it a fixed budget of rounds, and the loop continues to run even after it has stopped improving. In this paper, we study what a quality-blind detector that sees only the artefact and the evaluator's accept or reject decision can conclude about whether a loop has settled, and propose a stopping algorithm that detects the settling. We first show that no such detector can tell whether the quality is rising or falling, and the most it can claim is a bound on how much the quality could still change, in terms of how much the artefact keeps changing. To measure that change, we hash any artefact into a sketch whose update across a round is the round's edit. On the path of those sketches, the coherence measures the share of the magnitude of the recent updates that carries the artefact a net distance. Once a loop has settled, its successive edits no longer change the artefact in a common direction, and we derive the value that the coherence takes at that point, as a closed-form function of the algorithm's decay setting. Our algorithm, named LoopStop, scores each change by how far its coherence falls below that value and accumulates the scores over the rounds that changed the artefact. A rejected round enters the sum as a change of magnitude zero, so a loop whose evaluator has stopped accepting is covered by the same accumulation. Our evaluation shows that LoopStop delivers 8.3% higher quality than the next best adaptive baseline on average across multiple families of loops, at approximately 50% fewer rounds."
---
