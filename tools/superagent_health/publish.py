"""Publish a full report as a Feishu document, so a chat message can stay brief.

Feishu turns a `--markdown` message into rich text, but it does not make a local
path clickable and it splits a long report into pages. The manager therefore asked
for a durable copy in Feishu plus the complete local path. This module creates the
document with the bot identity, grants the manager read permission and returns the
link; the caller keeps the local file.
"""
import json
import subprocess
from delivery import binding, cli_env

class PublishError(Exception):
    """A document could not be created or shared; the report must still be delivered."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code

def share_ids(config):
    links = (config.get("delivery") or {}).get("report_links") or {}
    return [str(item).strip() for item in links.get("share_open_ids") or [] if str(item).strip().startswith("ou_")]

def configured(config):
    """True only when the device opted in and named someone who may read the document."""
    links = (config.get("delivery") or {}).get("report_links") or {}
    return bool(links.get("enabled")) and bool(share_ids(config))

def _json_payload(result):
    # The CLI prints its JSON to stdout on success and sometimes on failure too; the
    # stream is not a reliable signal, so parse whichever one carries the object.
    for raw in (result.stdout or "", result.stderr or ""):
        start = raw.find("{")
        if start < 0:
            continue
        try:
            return json.loads(raw[start:])
        except ValueError:
            continue
    raise PublishError("doc_unparseable")

def _call(argv, text, cli, directory, runner, timeout):
    try:
        result = runner(argv, input=text, text=True, encoding="utf-8",
                        capture_output=True, timeout=timeout, env=cli_env(directory))
    except subprocess.TimeoutExpired:
        raise PublishError("doc_timeout")
    except OSError:
        raise PublishError("doc_cli_failed")
    data = _json_payload(result)
    if result.returncode != 0 or data.get("ok") is not True:
        error = data.get("error") or {}
        raise PublishError("doc_error_" + str(error.get("code") or error.get("subtype") or result.returncode))
    return data

def publish_report(config, title, text, runner=subprocess.run):
    """Create one document for one report and share it; returns url and token.

    The document is created from the same Markdown as the chat message, so the
    manager reads identical content in Feishu. A bare document token is not a link;
    the URL is what the report prints.
    """
    recipient, cli, directory = binding(config)
    argv = [cli, "docs", "+create", "--title", title, "--doc-format", "markdown",
            "--content", "-", "--as", "bot", "--format", "json"]
    data = _call(argv, text, cli, directory, runner, 60)
    document = (data.get("data") or {}).get("document") or {}
    url = document.get("url")
    token = document.get("document_id")
    if not url or not token:
        raise PublishError("doc_without_receipt")
    for open_id in share_ids(config):
        # A bare document token needs --type; the URL form would hide the type.
        share = [cli, "drive", "+member-add", "--token", token, "--type", "docx", "--member-type", "openid",
                 "--member-id", open_id, "--perm", "view", "--yes", "--as", "bot", "--format", "json"]
        _call(share, None, cli, directory, runner, 30)
    return {"url": url, "token": token}
