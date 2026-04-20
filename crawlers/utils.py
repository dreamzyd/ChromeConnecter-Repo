import requests
import json
import os
import base64
import time
from datetime import datetime

# --- 环境变量配置 ---
# 请在使用前设置 export CHROME_SESSION_TOKEN="你的token"
SESSION_TOKEN = os.environ.get("CHROME_SESSION_TOKEN", "")
RELAY_SERVER_URL = "http://127.0.0.1:18794"
BASE_DOWNLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "downloads"))

def send_command(action, params=None):
    if not SESSION_TOKEN:
        raise ValueError("缺少 CHROME_SESSION_TOKEN 环境变量。请先使用 export 设置它。")
        
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {SESSION_TOKEN}"
    }
    payload = {"action": action}
    if params:
        payload["params"] = params
        
    response = requests.post(f"{RELAY_SERVER_URL}/api/command", json=payload, headers=headers)
    result = response.json()
    if not result.get("success"):
        raise Exception(f"命令执行失败: {result.get('error')}")
    return result.get("data")

def get_save_dir(site_category, page_title):
    """
    根据网站分类和网页标题，生成结构化的保存目录：
    downloads/quantclass_bbs/2026-04-20_标题/
    """
    date_str = datetime.now().strftime("%Y-%m-%d")
    # 清理非法字符
    safe_title = "".join(c for c in page_title if c not in r'\/:*?"<>|').strip()
    if not safe_title:
        safe_title = "unnamed_page"
        
    dir_path = os.path.join(BASE_DOWNLOAD_DIR, site_category, f"{date_str}_{safe_title}")
    os.makedirs(dir_path, exist_ok=True)
    return dir_path

def save_attachment(save_dir, filename, base64_data):
    """
    解码并保存 Base64 格式的附件
    """
    filename = "".join(c for c in filename if c not in r'\/:*?"<>|').strip() or "unnamed_file"
    if "," in base64_data:
        base64_data = base64_data.split(",")[1]
        
    file_data = base64.b64decode(base64_data)
    att_file_path = os.path.join(save_dir, filename)
    
    with open(att_file_path, "wb") as f:
        f.write(file_data)
    print(f"  -> ✅ 附件已保存: {att_file_path}")
    return att_file_path
