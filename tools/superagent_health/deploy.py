"""Deployment guard: the health task runs this checkout in place.

A merge to main only takes effect after that checkout is fast-forwarded to the
merged commit; a tree left on a feature branch, behind main or carrying
uncommitted tool changes keeps computing alerts with older logic, and nothing in
the report would say so. This module turns that state into a value the heartbeat
and the rendered messages can carry.

It reads local git only: no fetch, no credential prompt, no write, and it never
raises. A missing or broken git degrades the guard to ``quality=unknown`` instead
of stopping the health tick.
"""
import os
import subprocess
from pathlib import Path

DEFAULT_BRANCH = "main"
REPO_ROOT = Path(__file__).resolve().parents[2]
# Health code is what a report is built from; unrelated local edits (device
# scripts, docs) must not make the guard claim the running code is undeployed.
PACKAGE = Path(__file__).resolve().parent


def _git(root, args, runner, timeout):
    result = runner(["git", "-C", str(root), *args], capture_output=True, text=True,
                    encoding="utf-8", timeout=timeout,
                    env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"})
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "").strip() or "git " + args[0] + " failed")
    # Keep leading spaces: ``status --porcelain`` uses one for an unstaged change.
    return (result.stdout or "").rstrip("\r\n")


def _short(value):
    return value[:12] if value else None


def _scope(root):
    try:
        return PACKAGE.relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        # Another layout (e.g. a copied tool directory): report the whole tree.
        return "."


def deployment_state(repo_root=None, branch=DEFAULT_BRANCH, runner=subprocess.run, timeout=3):
    """Compare the running checkout with the last known tip of ``branch``.

    ``current`` is true only when the tree is on the branch, at its tip and clean
    for this package. ``quality=unknown`` means git could not tell (no repository,
    no branch ref, timeout); callers must not turn that into a warning.
    """
    root = Path(repo_root or REPO_ROOT)
    state = {"quality": "unknown", "current": None, "branch": None, "mainBranch": branch,
             "revision": None, "mainRevision": None, "behind": None, "ahead": None,
             "dirty": [], "reasons": [], "detail": None, "repoRoot": str(root)}
    try:
        state["branch"] = _git(root, ["rev-parse", "--abbrev-ref", "HEAD"], runner, timeout)
        revision = _git(root, ["rev-parse", "HEAD"], runner, timeout)
        reference = "origin/" + branch
        try:
            main = _git(root, ["rev-parse", "--verify", reference], runner, timeout)
        except RuntimeError:
            # A clone without that remote ref can still answer for the local branch.
            reference = branch
            main = _git(root, ["rev-parse", "--verify", reference], runner, timeout)
        counts = _git(root, ["rev-list", "--count", "--left-right", reference + "...HEAD"], runner, timeout)
        behind, ahead = [int(part) for part in counts.split()]
        dirty = []
        for line in _git(root, ["status", "--porcelain", "--", _scope(root)], runner, timeout).splitlines():
            path = line[3:].split(" -> ")[-1].strip()
            if path:
                dirty.append(path)
        state.update(quality="observed", revision=_short(revision), mainRevision=_short(main),
                     behind=behind, ahead=ahead, dirty=dirty)
        reasons = []
        if state["branch"] != branch:
            reasons.append("detached" if state["branch"] == "HEAD" else "branch")
        if behind:
            reasons.append("behind")
        if ahead:
            reasons.append("ahead")
        if dirty:
            reasons.append("dirty")
        state["reasons"] = reasons
        state["current"] = not reasons and revision == main
    except Exception as exc:
        state["detail"] = type(exc).__name__ + ": " + str(exc)[:200]
    return state
