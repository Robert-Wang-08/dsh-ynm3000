"""Read-only check of a device binding; never sends or reads credential files."""
import argparse
import json
import os
import subprocess
from pathlib import Path
from common import load_config


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--config",required=True)
    args=parser.parse_args()
    config=load_config(args.config)
    values=config.get("delivery",{})
    recipient=os.environ.get(values.get("recipient_env",""),"")
    cli=os.environ.get(values.get("cli_env",""),"")
    directory=os.environ.get(values.get("config_dir_env",""),"")
    if not recipient.startswith("oc_") or not Path(cli).is_file() or not Path(directory).is_dir():
        raise SystemExit("binding environment is missing; no external call made")
    env={**os.environ,"LARKSUITE_CLI_CONFIG_DIR":directory,"LARKSUITE_CLI_NO_UPDATE_NOTIFIER":"1","LARKSUITE_CLI_NO_SKILLS_NOTIFIER":"1"}
    result=subprocess.run([cli,"im","chats","get","--chat-id",recipient,"--as","bot","--format","json"],capture_output=True,text=True,encoding="utf-8",timeout=20,env=env)
    try:
        data=json.loads(result.stdout if result.returncode==0 else result.stderr)
    except ValueError:
        raise SystemExit("unparseable read-only channel metadata")
    print(json.dumps({"recipientSuffix":recipient[-8:],"ok":data.get("ok"),"identity":data.get("identity"),"chatMode":data.get("data",{}).get("chat_mode"),"errorType":data.get("error",{}).get("type")},ensure_ascii=False))
    raise SystemExit(0 if result.returncode==0 and data.get("ok") is True else 1)

if __name__=="__main__":
    main()
