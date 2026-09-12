import os
from flask import send_file, request

SAFE_ROOT = "/srv/reports"

def download():
    name = request.args.get("name", "")
    path = os.path.realpath(os.path.join(SAFE_ROOT, name))
    if not path.startswith(SAFE_ROOT + os.sep):
        return "forbidden", 403
    return send_file(path)
