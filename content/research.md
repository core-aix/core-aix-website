---
title: "Current Research Topics"
url: "/research/"
---

Work at CORE-AIx is organized around a small set of connected research themes.

![Research topics overview](/images/research/research_areas.png)

## 1) Reliable agentic AI

Reliable agentic AI is a core focus, aimed at systems that remain dependable in practical, high-stakes settings. The emphasis is on long-horizon robustness, constraint-aware planning and execution, and evaluation methods that go beyond single-turn accuracy to assess stability, recoverability, and consistency across full workflows. Work in this area also connects agent design with optimization and distributed-systems principles so that performance and controllability scale together in real deployments.

Representative papers:

- This is an ongoing direction at CORE-AIx. Publications are forthcoming.

## 2) Efficient and effective LLM inference systems

A major line of research studies how to make deployment-time decisions for large models under real constraints. Core questions include model routing, local-cloud offloading, response quality guarantees, latency, and cost.

Rather than treating deployment as a fixed engineering choice, this direction frames inference as an online optimization problem where decisions adapt to workload characteristics and service goals.

Representative papers:

- H. Woisetschlager, R. Zhang, S. Wang, H.-A. Jacobsen, ["MESS+: dynamically learned inference-time LLM routing in model zoos with service level guarantees"](https://arxiv.org/abs/2505.19947), in *Annual Conference on Neural Information Processing Systems (NeurIPS)*, Dec. 2025 (acceptance rate: 24.5%).
- L. Yuan, D.-J. Han, S. Wang, C. Brinton, ["Local-Cloud Inference Offloading for LLMs in Multi-Modal, Multi-Task, Multi-Dialogue Settings"](https://arxiv.org/abs/2502.11007), in *ACM International Symposium on Theory, Algorithmic Foundations, and Protocol Design for Mobile Networks and Mobile Computing (MobiHoc)*, Oct. 2025 (best paper runner-up, top 3 of 169 submissions, overall acceptance rate: 23.1%).

## 3) Optimization and data quality for foundation-model learning

Another line of work examines how optimization theory and data curation influence the quality and efficiency of modern model training and adaptation.

Key themes include parameter-efficient fine-tuning, sample reweighting, and principled handling of training signals to improve downstream performance while managing compute budgets.


Representative papers:

- F. Wu, J. Hu, G. Min, S. Wang, ["Efficient orthogonal fine-tuning with principal subspace adaptation"](https://openreview.net/pdf?id=FSHrinMArK), in *International Conference on Learning Representations (ICLR)*, Apr. 2026.
- D. Sow, H. Woisetschlager, S. Bulusu, S. Wang, H.-A. Jacobsen, Y. Liang, ["Dynamic loss-based sample reweighting for improved large language model pretraining"](https://openreview.net/pdf?id=gU4ZgQNsOC), in *International Conference on Learning Representations (ICLR)*, May 2025.

## 4) Collaborative and federated AI in distributed environments

Collaborative AI in distributed environments is explored through methods where data, computation, and decision making span clients, devices, or organizations.

The emphasis is on robustness under heterogeneity, communication/computation efficiency, and reliability when participation and resources vary over time.


Representative papers:

- A. Piaseczny, M. K. C. Shisher, S. Wang, C. Brinton, ["RCCDA: adaptive model updates in the presence of concept drift under a constrained resource budget"](https://arxiv.org/abs/2505.24149), in *Annual Conference on Neural Information Processing Systems (NeurIPS)*, Dec. 2025 (acceptance rate: 24.5%).
- P. Valdeira, S. Wang, Y. Chi, ["Vertical federated learning with missing features during training and inference"](https://openreview.net/pdf?id=OXi1FmHGzz), in *International Conference on Learning Representations (ICLR)*, May 2025.
- S. Wang, M. Ji, ["A lightweight method for tackling unknown participation statistics in federated averaging"](https://openreview.net/pdf?id=ZKEuFKfCKA), in *International Conference on Learning Representations (ICLR)*, May 2024 (spotlight, 5% of submitted papers). 
- D. Jhunjhunwala, S. Wang, G. Joshi, ["FedExP: speeding up federated averaging via extrapolation"](https://openreview.net/pdf?id=IPrzNbddXV), in *International Conference on Learning Representations (ICLR)*, May 2023 (spotlight - notable-top-25%, top 25% of accepted papers, approximately top 8% of submitted papers). 

## 5) Collaboration with industry

Close collaboration with industry helps shape practical research directions and accelerate real-world impact. The CORE-AIx team is in ongoing discussions with partners to identify high-value problems, understand deployment constraints, and co-develop pathways that translate reliable and efficient agentic AI research into operational settings.
