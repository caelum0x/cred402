"""Receipt-graph fraud detection for the Cred402 fraud service (p2 §7.8).

Threat model (verbatim from the spec):

    Agent A pays Agent B
    Agent B pays Agent A
    both generate fake receipts
    both inflate credit scores
    both borrow from the pool

We build a directed, weighted multigraph of ``payer -> seller`` from receipts
and look for the structural fingerprints of fake-revenue collusion:

  (a) reciprocal 2-cycles  (A->B and B->A)         => wash trading
  (b) strongly connected components of size >= 2    => collusion rings
      via a real iterative implementation of Tarjan's SCC algorithm
  (c) revenue concentration per agent (Herfindahl)  => single-source income
  (d) self-dealing through a shared operator key     => sybil revenue

Each agent receives a fraud score in [0, 100] (higher = more suspicious) plus a
list of human-readable flags. Nothing here moves money; it produces advisory
signals for the RiskPolicyManager.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .features import herfindahl_index, to_motes

# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Edge:
    src: str        # payer
    dst: str        # seller
    weight: int     # motes
    count: int      # number of receipts collapsed into this edge


@dataclass
class ReceiptGraph:
    """Directed weighted graph of payer -> seller revenue flow."""

    nodes: set[str] = field(default_factory=set)
    # adjacency: src -> {dst -> Edge}
    out_edges: dict[str, dict[str, Edge]] = field(default_factory=dict)
    in_edges: dict[str, dict[str, Edge]] = field(default_factory=dict)
    # total revenue received per node, broken down by payer
    received_by_payer: dict[str, dict[str, int]] = field(default_factory=dict)

    def neighbors(self, node: str) -> list[str]:
        return list(self.out_edges.get(node, {}).keys())


def build_graph(receipts: list[dict]) -> ReceiptGraph:
    """Collapse receipts into a directed weighted payer->seller graph.

    Self-loops (payer == seller) are recorded as nodes/edges too — they are a
    direct self-dealing signal.
    """
    g = ReceiptGraph()
    agg: dict[tuple[str, str], list[int]] = {}  # (src,dst) -> [weight, count]
    for r in receipts:
        src = r.get("payer_agent")
        dst = r.get("seller_agent")
        if not src or not dst:
            continue
        amount = to_motes(r.get("amount"))
        g.nodes.add(src)
        g.nodes.add(dst)
        key = (src, dst)
        if key not in agg:
            agg[key] = [0, 0]
        agg[key][0] += amount
        agg[key][1] += 1
        g.received_by_payer.setdefault(dst, {})
        g.received_by_payer[dst][src] = g.received_by_payer[dst].get(src, 0) + amount

    for (src, dst), (weight, count) in agg.items():
        edge = Edge(src=src, dst=dst, weight=weight, count=count)
        g.out_edges.setdefault(src, {})[dst] = edge
        g.in_edges.setdefault(dst, {})[src] = edge
    return g


# ---------------------------------------------------------------------------
# (a) Reciprocal 2-cycles (wash trading)
# ---------------------------------------------------------------------------

def find_two_cycles(g: ReceiptGraph) -> list[tuple[str, str, int]]:
    """Return reciprocal pairs (A, B, reciprocity_motes) with A->B and B->A.

    Each unordered pair is reported once (A < B). The reported weight is the
    *minimum* of the two directional flows — the volume that genuinely
    circulates (the wash-traded amount).
    """
    pairs: list[tuple[str, str, int]] = []
    seen: set[tuple[str, str]] = set()
    for src, dsts in g.out_edges.items():
        for dst, edge in dsts.items():
            if src == dst:
                continue
            back = g.out_edges.get(dst, {}).get(src)
            if back is None:
                continue
            key = (src, dst) if src < dst else (dst, src)
            if key in seen:
                continue
            seen.add(key)
            circulating = min(edge.weight, back.weight)
            pairs.append((key[0], key[1], circulating))
    return pairs


# ---------------------------------------------------------------------------
# (b) Strongly connected components via Tarjan's algorithm (iterative)
# ---------------------------------------------------------------------------

def tarjan_scc(g: ReceiptGraph) -> list[list[str]]:
    """Tarjan's strongly connected components algorithm (iterative).

    Returns a list of components, each a list of node ids. Implemented
    iteratively with an explicit stack to avoid Python recursion limits on
    large receipt graphs. This is the real algorithm: index/lowlink
    bookkeeping, an on-stack set, and lowlink propagation on the post-visit.
    """
    index_counter = 0
    indices: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    on_stack: dict[str, bool] = {}
    scc_stack: list[str] = []
    result: list[list[str]] = []

    # Deterministic node ordering for reproducible output.
    all_nodes = sorted(g.nodes)

    for root in all_nodes:
        if root in indices:
            continue
        # work_stack holds (node, iterator-position) frames.
        work_stack: list[tuple[str, int]] = [(root, 0)]
        while work_stack:
            node, child_idx = work_stack[-1]

            if child_idx == 0:
                # First visit to this node: assign index/lowlink, push.
                indices[node] = index_counter
                lowlink[node] = index_counter
                index_counter += 1
                scc_stack.append(node)
                on_stack[node] = True

            neighbors = sorted(g.out_edges.get(node, {}).keys())

            recursed = False
            while child_idx < len(neighbors):
                w = neighbors[child_idx]
                child_idx += 1
                if w not in indices:
                    # "Recurse" into w by pushing a new frame.
                    work_stack[-1] = (node, child_idx)
                    work_stack.append((w, 0))
                    recursed = True
                    break
                elif on_stack.get(w):
                    # w is in the current SCC frontier.
                    lowlink[node] = min(lowlink[node], indices[w])

            if recursed:
                continue

            # All children processed: finalize this node.
            work_stack.pop()
            # Propagate lowlink up to the parent (post-visit step).
            if work_stack:
                parent = work_stack[-1][0]
                lowlink[parent] = min(lowlink[parent], lowlink[node])

            # If node is a root of an SCC, pop the component off scc_stack.
            if lowlink[node] == indices[node]:
                component: list[str] = []
                while True:
                    w = scc_stack.pop()
                    on_stack[w] = False
                    component.append(w)
                    if w == node:
                        break
                result.append(component)

    return result


def collusion_rings(g: ReceiptGraph) -> list[list[str]]:
    """SCCs of size >= 2 — candidate collusion rings."""
    return [sorted(c) for c in tarjan_scc(g) if len(c) >= 2]


# ---------------------------------------------------------------------------
# (c) Revenue concentration per agent
# ---------------------------------------------------------------------------

def revenue_concentration(g: ReceiptGraph, agent_id: str) -> float:
    """Herfindahl index of an agent's *inbound* revenue across payers (0..1).

    Near 1.0 means almost all income comes from a single counterparty — the
    hallmark of a paired wash-trade or a sybil-fed seller.
    """
    by_payer = g.received_by_payer.get(agent_id, {})
    if not by_payer:
        return 0.0
    return herfindahl_index(list(by_payer.values()))


# ---------------------------------------------------------------------------
# (d) Self-dealing via shared operator key
# ---------------------------------------------------------------------------

def shared_operator_pairs(agents: list[dict]) -> dict[str, set[str]]:
    """Map agent_id -> set of *other* agents sharing its operator/owner key.

    Two agents controlled by the same operator paying each other is sybil
    self-dealing. The Cred402 agent record exposes ``owner_public_key``.
    """
    by_operator: dict[str, list[str]] = {}
    for a in agents:
        op = a.get("owner_public_key") or a.get("operator_key")
        aid = a.get("agent_id")
        if not op or not aid:
            continue
        by_operator.setdefault(op, []).append(aid)
    shared: dict[str, set[str]] = {}
    for op, members in by_operator.items():
        if len(members) < 2:
            continue
        for m in members:
            shared[m] = {x for x in members if x != m}
    return shared


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FraudAssessment:
    agent_id: str
    fraud_score: float          # 0..100
    flags: list[str]
    in_ring: bool
    ring_members: list[str]
    revenue_concentration: float

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "fraud_score": round(self.fraud_score, 2),
            "flags": self.flags,
            "in_ring": self.in_ring,
            "ring_members": self.ring_members,
            "revenue_concentration": round(self.revenue_concentration, 4),
        }


# Component weights for the fraud score (sum of activated weights, capped 100).
_W_WASH_TRADE = 45.0          # reciprocal 2-cycle present
_W_RING = 35.0                # member of an SCC ring of size >= 2
_W_CONCENTRATION = 25.0       # single-source revenue (scaled by HHI over 0.5)
_W_SELF_LOOP = 30.0           # pays itself
_W_SHARED_OPERATOR = 20.0     # transacts with a shared-operator sibling


def assess_fraud(
    agents: list[dict],
    receipts: list[dict],
) -> dict[str, FraudAssessment]:
    """Compute a fraud assessment for every agent from the receipt graph."""
    g = build_graph(receipts)
    two_cycles = find_two_cycles(g)
    rings = collusion_rings(g)
    operators = shared_operator_pairs(agents)

    # Index: which agents are in a wash pair / ring.
    wash_partners: dict[str, set[str]] = {}
    for a, b, _circ in two_cycles:
        wash_partners.setdefault(a, set()).add(b)
        wash_partners.setdefault(b, set()).add(a)

    ring_of: dict[str, list[str]] = {}
    for ring in rings:
        for member in ring:
            ring_of[member] = ring

    agent_ids = {a.get("agent_id") for a in agents if a.get("agent_id")}
    # Include any node that appears only in receipts.
    agent_ids |= g.nodes

    results: dict[str, FraudAssessment] = {}
    for agent_id in sorted(x for x in agent_ids if x):
        score = 0.0
        flags: list[str] = []

        # (a) wash trading
        if agent_id in wash_partners:
            score += _W_WASH_TRADE
            partners = ", ".join(sorted(wash_partners[agent_id]))
            flags.append(f"WASH_TRADE_RECIPROCAL_CYCLE:{partners}")

        # (b) collusion ring
        ring = ring_of.get(agent_id)
        in_ring = ring is not None and len(ring) >= 2
        if in_ring:
            score += _W_RING
            flags.append(f"COLLUSION_RING_SCC:{len(ring)}")

        # (c) revenue concentration
        conc = revenue_concentration(g, agent_id)
        if conc > 0.5:
            # scale the contribution from 0 at HHI=0.5 to full at HHI=1.0
            scaled = _W_CONCENTRATION * (conc - 0.5) / 0.5
            score += scaled
            flags.append(f"REVENUE_CONCENTRATION_HHI:{round(conc, 3)}")

        # self-loop (pays itself)
        if agent_id in g.out_edges.get(agent_id, {}):
            score += _W_SELF_LOOP
            flags.append("SELF_DEALING_SELF_LOOP")

        # (d) shared operator transacting with a sibling
        siblings = operators.get(agent_id, set())
        if siblings:
            counterparties = set(g.out_edges.get(agent_id, {}).keys()) | set(
                g.in_edges.get(agent_id, {}).keys()
            )
            sibling_cps = siblings & counterparties
            if sibling_cps:
                score += _W_SHARED_OPERATOR
                flags.append(
                    "SHARED_OPERATOR_SELF_DEALING:" + ",".join(sorted(sibling_cps))
                )

        results[agent_id] = FraudAssessment(
            agent_id=agent_id,
            fraud_score=min(100.0, score),
            flags=flags,
            in_ring=in_ring,
            ring_members=ring if in_ring else [],
            revenue_concentration=conc,
        )
    return results
