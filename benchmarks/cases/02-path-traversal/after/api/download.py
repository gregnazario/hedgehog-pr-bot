import os
from flask import send_file, request

SAFE_ROOT = "/srv/reports"

def download():
    name = request.args.get("name", "")
    path = os.path.join(SAFE_ROOT, name)
    return send_file(path)
