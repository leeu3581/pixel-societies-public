"""Accumulate observed activity from redacted records, without model calls."""

import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime

from .cc_models import BuilderProfile, Cadence, Project, RoleLean
from .redact import redact_paths

_EXTENSIONS = {
    "py": "Python", "pyi": "Python", "js": "JavaScript", "jsx": "React",
    "ts": "TypeScript", "tsx": "React", "rs": "Rust", "go": "Go",
    "java": "Java", "kt": "Kotlin", "swift": "Swift", "rb": "Ruby",
    "php": "PHP", "cpp": "C++", "cc": "C++", "c": "C", "cs": "C#",
    "sql": "SQL", "vue": "Vue", "svelte": "Svelte", "sh": "Shell",
    "css": "CSS", "html": "HTML", "dart": "Dart", "ipynb": "Jupyter",
}
_IMPORTS = {
    "react": "React", "next": "Next.js", "vue": "Vue", "svelte": "Svelte",
    "fastapi": "FastAPI", "django": "Django", "flask": "Flask",
    "pydantic": "Pydantic", "torch": "PyTorch", "tensorflow": "TensorFlow",
    "pandas": "pandas", "numpy": "NumPy", "express": "Express",
}

# Keys are the schema's closed matching vocabulary. Aliases use whole words
# after normalising separators/camelCase, never arbitrary substring matches.
_DOMAIN_ALIASES = {
    "devtools": ("devtools", "dev tools", "developer tools", "sdk", "cli"),
    "evals": ("evals", "evaluation", "evaluations", "benchmarks"),
    "observability": ("observability", "telemetry", "tracing", "monitoring"),
    "data-infra": ("data infra", "data infrastructure", "etl", "ingestion", "pipelines"),
    "agents": ("agent", "agents", "agentic"),
    "memory": ("memory", "memories"),
    "retrieval": ("retrieval", "rag", "vector search"),
    "fintech": ("fintech", "banking", "trading"),
    "payments": ("payment", "payments", "billing", "checkout"),
    "local-first": ("local first", "offline first"),
    "sync": ("sync", "synchronization", "synchronisation", "crdt"),
    "simulation": ("simulation", "simulations", "simulator"),
    "games": ("game", "games", "gaming", "gamedev"),
    "dataviz": ("dataviz", "data visualization", "data visualisation", "charts"),
    "design-systems": ("design system", "design systems", "storybook"),
    "frontend": ("frontend", "front end", "ui", "components"),
    "voice": ("voice", "speech", "tts", "asr"),
    "realtime": ("realtime", "real time", "websocket", "websockets"),
    "compilers": ("compiler", "compilers", "llvm"),
    "build-systems": ("build system", "build systems", "bundler", "bundlers"),
    "docs": ("docs", "documentation"),
    "growth": ("growth", "onboarding", "activation"),
    "ops-tooling": ("ops tooling", "devops", "deployment", "deploy", "kubernetes", "terraform"),
    "logistics": ("logistics", "shipping", "supply chain"),
    "optimization": ("optimization", "optimisation", "solver", "solvers"),
    "security": ("security", "authentication", "encryption", "auth"),
    "infra": ("infra", "infrastructure", "backend", "database", "databases"),
    "ml": ("ml", "machine learning", "neural", "training", "inference"),
}
_ROLE_NAMES = {
    "infra": ("backend", "database", "databases", "pipeline", "pipelines", "deploy", "devops", "infrastructure", "terraform"),
    "interface": ("frontend", "components", "canvas", "design system", "storybook", "styles"),
    "product": ("onboarding", "docs", "documentation", "growth", "integrations", "user flows"),
    "research": ("notebooks", "models", "solver", "solvers", "evaluation", "evals", "experiments"),
}
_ROLE_STACKS = {
    "infra": {"Rust", "Go", "SQL", "FastAPI", "Django", "Flask", "Express"},
    "interface": {"React", "Vue", "Svelte", "Next.js", "CSS", "HTML"},
    "product": set(),
    "research": {"Jupyter", "PyTorch", "TensorFlow", "pandas", "NumPy"},
}
_DOMAIN_PHRASES = {
    "devtools": "developer tools", "evals": "evaluation tools", "observability": "observability tools",
    "data-infra": "data pipelines", "agents": "AI agents", "memory": "memory systems",
    "retrieval": "retrieval systems", "fintech": "financial software", "payments": "payment systems",
    "local-first": "local-first apps", "sync": "sync systems", "simulation": "simulations",
    "games": "games", "dataviz": "data visualisations", "design-systems": "design systems",
    "frontend": "web interfaces", "voice": "voice tools", "realtime": "realtime apps",
    "compilers": "compilers", "build-systems": "build tools", "docs": "documentation tools",
    "growth": "growth tools", "ops-tooling": "operations tools", "logistics": "logistics software",
    "optimization": "optimisation tools", "security": "security tools", "infra": "infrastructure",
    "ml": "machine learning systems",
}


def _normalise_name(value: str) -> str:
    # Placeholder types (e.g. database_url) are not evidence of an interest.
    value = re.sub(r"<REDACTED:[^>]*>", " ", value)
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    return " " + re.sub(r"[^a-z0-9]+", " ", value.lower()).strip() + " "


def _tool_paths(value):
    """Only named path fields, never free-form prompts or tool output."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"file_path", "path", "notebook_path", "directory"} and isinstance(item, str):
                yield item
            elif isinstance(item, (dict, list)):
                yield from _tool_paths(item)
    elif isinstance(value, list):
        for item in value:
            yield from _tool_paths(item)


def _headline(domain: str | None, stacks: list[str]) -> str | None:
    if not domain and not stacks:
        return None
    phrase = "Builds " + (_DOMAIN_PHRASES[domain] if domain else "software")
    selected = stacks[:2]
    while selected:
        candidate = phrase + " with " + " and ".join(selected)
        if len(candidate) < 70:
            return candidate
        selected.pop()
    return phrase


def stack_signals(value) -> set[str]:
    """Inspect redacted tool inputs only; never retain code or file contents."""
    found: set[str] = set()
    if isinstance(value, dict):
        for item in value.values():
            found.update(stack_signals(item))
    elif isinstance(value, list):
        for item in value:
            found.update(stack_signals(item))
    elif isinstance(value, str):
        for ext in re.findall(r"[\w/-]+\.([a-zA-Z0-9]+)\b", value):
            if ext.lower() in _EXTENSIONS:
                found.add(_EXTENSIONS[ext.lower()])
                if ext.lower() == "tsx":
                    found.add("TypeScript")
        for module in re.findall(
            r"(?:\bfrom\s+['\"]?|\bimport\s+['\"]?|\brequire\s*\(\s*['\"])([\w@/-]+)", value
        ):
            root = module.split("/")[0]
            if root in _IMPORTS:
                found.add(_IMPORTS[root])
    return found


@dataclass
class _ProjectActivity:
    name: str
    first: datetime
    last: datetime
    sessions: set[str] = field(default_factory=set)
    messages: int = 0
    branches: set[str] = field(default_factory=set)


class ProfileBuilder:
    """Cadence counts kept mainline messages; span is inclusive UTC calendar days.

    sessions_per_week = sessions * 7 / max(7, span_days), avoiding inflated
    weekly estimates from exports shorter than a week. Empty exports use zero.
    """

    def __init__(self):
        self.projects: dict[str, _ProjectActivity] = {}
        self.sessions: set[str] = set()
        self.days: set = set()
        self.hours: Counter[int] = Counter()
        self.stacks: set[str] = set()
        self.tools: set[str] = set()
        self.stack_counts: Counter[str] = Counter()
        self.domain_evidence: dict[str, set[str]] = {domain: set() for domain in _DOMAIN_ALIASES}
        self.role_evidence: dict[str, set[str]] = {role: set() for role in _ROLE_NAMES}

    def _add_names(self, name: str) -> None:
        name = _normalise_name(name)
        for domain, aliases in _DOMAIN_ALIASES.items():
            self.domain_evidence[domain].update(alias for alias in aliases if f" {alias} " in name)
        for role, aliases in _ROLE_NAMES.items():
            self.role_evidence[role].update("name:" + alias for alias in aliases if f" {alias} " in name)

    def _role_lean(self) -> RoleLean:
        # Distinct signals, not message volume: repeating one file a thousand
        # times must not turn a sparse profile into a confident classification.
        scores = sorted(((len(evidence), role) for role, evidence in self.role_evidence.items()), reverse=True)
        top, role = scores[0]
        second = scores[1][0]
        if top < 2 or (second and top < 2 * second):
            return "generalist"
        return role

    def add(self, record: dict, ts: datetime, session: str) -> None:
        key = record["_path_fingerprint"]
        project = self.projects.setdefault(key, _ProjectActivity(record["cwd"], ts, ts))
        project.first = min(project.first, ts)
        project.last = max(project.last, ts)
        project.sessions.add(session)
        project.messages += 1
        self._add_names(record["cwd"])
        branch = record.get("gitBranch")
        if isinstance(branch, str) and branch.strip():
            project.branches.add(redact_paths(branch)[:200])
            self._add_names(branch)
        self.sessions.add(session)
        self.days.add(ts.date())
        self.hours[ts.hour] += 1
        content = record["message"].get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = block.get("name")
                if isinstance(name, str) and name:
                    self.tools.add(redact_paths(name)[:200])
                tool_input = block.get("input")
                signals = stack_signals(tool_input)
                self.stacks.update(signals)
                self.stack_counts.update(signals)
                for role, stacks in _ROLE_STACKS.items():
                    self.role_evidence[role].update("stack:" + stack for stack in signals & stacks)
                for path in _tool_paths(tool_input):
                    self._add_names(path)

    def build(self) -> BuilderProfile:
        days = sorted(self.days)
        span = (days[-1] - days[0]).days + 1 if days else 0
        longest = streak = 0
        previous = None
        for day in days:
            streak = streak + 1 if previous and (day - previous).days == 1 else 1
            longest = max(longest, streak)
            previous = day
        domains = sorted((domain for domain, evidence in self.domain_evidence.items() if evidence),
                         key=lambda domain: (-len(self.domain_evidence[domain]), domain))
        top_stacks = sorted(self.stacks, key=lambda stack: (-self.stack_counts[stack], stack))
        return BuilderProfile(
            projects=[Project(
                name=p.name, path_fingerprint=key, first_seen=p.first, last_seen=p.last,
                session_count=len(p.sessions), message_count=p.messages, branches=sorted(p.branches),
            ) for key, p in sorted(self.projects.items())],
            stacks=sorted(self.stacks), tools=sorted(self.tools),
            total_sessions=len(self.sessions), span_days=span,
            domains=domains, role_lean=self._role_lean(),
            headline=_headline(domains[0] if domains else None, top_stacks),
            cadence=Cadence(
                active_days=len(days), sessions_per_week=round(len(self.sessions) * 7 / max(7, span), 3),
                hour_histogram={hour: self.hours[hour] for hour in range(24)},
                longest_streak_days=longest,
            ),
        )
