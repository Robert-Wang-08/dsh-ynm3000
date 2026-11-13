"""Bot transport with recipient gating, idempotency and no shell interpolation."""
import json
import os
import subprocess
from pathlib import Path
from common import digest

class DeliveryError(Exception):
    def __init__(self,kind,ambiguous=False,permanent=False):
        super().__init__(kind)
        self.ambiguous,self.permanent=ambiguous,permanent

def binding(config):
    delivery=config.get("delivery",{})
    if not delivery.get("enabled") or not delivery.get("binding_confirmed"):
        raise DeliveryError("binding_not_confirmed",permanent=True)
    if delivery.get("identity") != "bot" or delivery.get("content_policy") != "redacted_health_report_v1":
        raise DeliveryError("identity_or_content_not_confirmed",permanent=True)
    recipient=os.environ.get(delivery.get("recipient_env", ""), "")
    cli=os.environ.get(delivery.get("cli_env", ""), "")
    directory=os.environ.get(delivery.get("config_dir_env", ""), "")
    if not recipient.startswith("oc_") or not Path(cli).is_file() or not Path(directory).is_dir():
        raise DeliveryError("binding_environment_missing",permanent=True)
    return recipient,cli,directory

def binding_id(config, resolved):
    recipient,cli,directory=resolved
    delivery=config.get("delivery",{})
    return digest([recipient,str(Path(cli).resolve()),str(Path(directory).resolve()),delivery.get("identity"),delivery.get("content_policy")])

def send(config,text,key,runner=subprocess.run):
    recipient,cli,directory=binding(config)
    env={**os.environ,"LARKSUITE_CLI_CONFIG_DIR":directory,"NO_COLOR":"1","LARKSUITE_CLI_NO_UPDATE_NOTIFIER":"1","LARKSUITE_CLI_NO_SKILLS_NOTIFIER":"1"}
    # stdin avoids exposing report text to process command-line inspection.
    argv=[cli,"im","+messages-send","--chat-id",recipient,"--text","-","--as","bot","--idempotency-key",key,"--format","json"]
    try:
        result=runner(argv,input=text,text=True,encoding="utf-8",capture_output=True,timeout=30,env=env)
    except subprocess.TimeoutExpired:
        raise DeliveryError("send_timeout",ambiguous=True)
    except OSError:
        raise DeliveryError("sender_start_failed",permanent=True)
    try:
        data=json.loads(result.stdout if result.returncode==0 else result.stderr)
    except ValueError:
        raise DeliveryError("unparseable_channel_result",ambiguous=result.returncode==0)
    if result.returncode==0 and data.get("ok") is True:
        message_id=data.get("data",{}).get("message_id")
        if not message_id:
            raise DeliveryError("accepted_without_receipt",ambiguous=True)
        return message_id
    error=data.get("error",{})
    code=str(error.get("code") or error.get("subtype") or result.returncode)
    raise DeliveryError("channel_error_"+code,permanent=error.get("type") in ("authorization","authentication") or result.returncode==10)
